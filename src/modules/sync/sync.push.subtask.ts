import { prisma } from '../../config/prisma';
import { tasksService } from '../tasks/tasks.service';
import type { UpdateSubtaskInput } from '../tasks/tasks.schema';
import { toSyncSubtaskDto } from './sync.mappers';
import {
  applied,
  bestEffort,
  conflict,
  decide,
  invalid,
  memberWorkspaceIds,
  rejected,
  sameDate,
  type Outcome,
} from './sync.push.shared';
import { subtaskDataSchema, type SubtaskData, type SyncMutationInput } from './sync.schema';

// Mutaciones de `subtask` (contrato §5.4). H2: solo subtareas de tareas del
// workspace Personal. Todo pasa por tasksService.

export async function subtaskMutation(
  userId: string,
  m: SyncMutationInput,
  now: number,
): Promise<Outcome> {
  const memberOf = await memberWorkspaceIds(userId);
  const current = await prisma.subtask.findUnique({
    where: { id: m.id },
    include: { task: { select: { column: { select: { board: { select: { workspaceId: true } } } } } } },
  });
  const mine = current !== null && memberOf.has(current.task.column.board.workspaceId);
  if (current && !mine) {
    return m.op === 'delete'
      ? applied(null)
      : rejected('ID_ALREADY_IN_USE', 'Ese identificador ya está en uso.');
  }

  const reread = async () =>
    toSyncSubtaskDto(await prisma.subtask.findUniqueOrThrow({ where: { id: m.id } }));

  if (m.op === 'delete') {
    if (!current) return applied(null);
    if (current.deletedAt) return applied(toSyncSubtaskDto(current));
    if (decide(current, m, now) === 'conflict') return conflict(toSyncSubtaskDto(current));
    await tasksService.deleteSubtask(current.taskId, m.id, userId);
    return applied(await reread());
  }

  const parsed = subtaskDataSchema.safeParse(m.data);
  if (!parsed.success) return invalid('Los datos de la subtarea no son válidos.');
  const data: SubtaskData = parsed.data;

  if (!current) {
    // La tarea padre debe ser una tarea VIVA de un workspace donde soy miembro.
    const task = await prisma.task.findFirst({
      where: {
        id: data.taskId,
        deletedAt: null,
        column: { board: { workspaceId: { in: [...memberOf] }, deletedAt: null } },
      },
      select: { id: true },
    });
    if (!task) return rejected('DEPENDENCY_NOT_FOUND', 'La tarea de la subtarea no existe.');

    const created = await tasksService.createSubtask(task.id, userId, {
      id: m.id,
      title: data.title,
      dueAt: data.dueAt ?? undefined,
      assigneeId: data.assigneeId ?? undefined,
    });
    // createSubtask no recibe `completed` ni `position`: se completan con el
    // mismo service que usa la API.
    const rest: UpdateSubtaskInput = {
      ...(data.completed ? { completed: true } : {}),
      ...(created.value.position !== data.position ? { position: data.position } : {}),
    };
    if (Object.keys(rest).length > 0) {
      await bestEffort(() => tasksService.updateSubtask(task.id, m.id, userId, rest));
    }
    return applied(await reread());
  }

  // Una subtarea no cambia de tarea por sync.
  if (data.taskId !== current.taskId) {
    return invalid('No se puede mover una subtarea a otra tarea.');
  }
  // Un tombstone nunca se resucita.
  if (current.deletedAt) return conflict(toSyncSubtaskDto(current));

  const same =
    current.title === data.title &&
    current.completed === data.completed &&
    current.position === data.position &&
    current.assigneeId === data.assigneeId &&
    sameDate(current.dueAt, data.dueAt);
  if (same) return applied(toSyncSubtaskDto(current));
  if (decide(current, m, now) === 'conflict') return conflict(toSyncSubtaskDto(current));

  const patch: UpdateSubtaskInput = {
    ...(current.title !== data.title ? { title: data.title } : {}),
    ...(current.completed !== data.completed ? { completed: data.completed } : {}),
    ...(current.position !== data.position ? { position: data.position } : {}),
    ...(current.assigneeId !== data.assigneeId ? { assigneeId: data.assigneeId } : {}),
    ...(!sameDate(current.dueAt, data.dueAt) ? { dueAt: data.dueAt } : {}),
  };
  await tasksService.updateSubtask(current.taskId, m.id, userId, patch);
  return applied(await reread());
}

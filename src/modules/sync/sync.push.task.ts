import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import type { UpdateTaskInput } from '../tasks/tasks.schema';
import { tasksService } from '../tasks/tasks.service';
import { ensurePersonalWorkspace } from '../workspaces/personal-workspace';
import { toSyncTaskDto } from './sync.mappers';
import {
  applied,
  bestEffort,
  conflict,
  decide,
  invalid,
  rejected,
  sameDate,
  type Outcome,
} from './sync.push.shared';
import { taskDataSchema, type SyncMutationInput, type TaskData } from './sync.schema';

// Mutaciones de `task` (contrato §5.4). H2: tareas de listas planas Y de
// tableros del workspace Personal. Los workspaces compartidos llegan con H5.

const TASK_INCLUDE = {
  column: {
    select: { id: true, boardId: true, board: { select: { workspaceId: true, isList: true } } },
  },
} satisfies Prisma.TaskInclude;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>;

const toDto = (task: TaskRow) =>
  toSyncTaskDto(task, { id: task.column.boardId, isList: task.column.board.isList });

interface Target {
  columnId: string;
}

/** Columna destino de la tarea: la interna de una lista viva mía (`listId`) o
 * una columna viva de un tablero normal vivo de mi workspace Personal
 * (`columnId`). Devuelve un `Outcome` de rechazo si no se puede resolver. */
async function resolveTarget(
  userId: string,
  personalId: string,
  data: TaskData,
): Promise<Target | Outcome> {
  if (data.listId !== null) {
    const list = await prisma.board.findFirst({
      where: { id: data.listId, isList: true, workspaceId: personalId, deletedAt: null },
      include: { columns: { where: { deletedAt: null }, orderBy: { position: 'asc' }, take: 1 } },
    });
    const columnId = list?.columns[0]?.id;
    if (!columnId) return rejected('DEPENDENCY_NOT_FOUND', 'La lista de la tarea no existe.');
    return { columnId };
  }

  const column = await prisma.column.findFirst({
    where: {
      id: data.columnId!,
      deletedAt: null,
      board: { workspaceId: personalId, isList: false, deletedAt: null },
    },
    select: { id: true },
  });
  if (column) return { columnId: column.id };

  // ¿Es una columna de un workspace compartido al que pertenezco? Esas tareas
  // llegan con H5: no se guarda el rechazo para poder reenviarlas entonces.
  const shared = await prisma.column.findFirst({
    where: {
      id: data.columnId!,
      board: { workspace: { members: { some: { userId } } } },
    },
    select: { id: true },
  });
  if (shared) {
    return rejected(
      'INVALID_MUTATION',
      'Las tareas de workspaces compartidos todavía no se pueden sincronizar.',
      null,
      false,
    );
  }
  return rejected('DEPENDENCY_NOT_FOUND', 'La columna de la tarea no existe.');
}

export async function taskMutation(
  userId: string,
  m: SyncMutationInput,
  now: number,
): Promise<Outcome> {
  const personal = await ensurePersonalWorkspace(prisma, userId);
  const current = await prisma.task.findUnique({ where: { id: m.id }, include: TASK_INCLUDE });
  // Un id que existe pero no es una tarea de mi workspace Personal se trata como
  // ajeno: nunca se revela qué es ni de quién.
  const mine = current !== null && current.column.board.workspaceId === personal.id;
  if (current && !mine) {
    return m.op === 'delete'
      ? applied(null)
      : rejected('ID_ALREADY_IN_USE', 'Ese identificador ya está en uso.');
  }

  const reread = async () =>
    toDto(await prisma.task.findUniqueOrThrow({ where: { id: m.id }, include: TASK_INCLUDE }));

  if (m.op === 'delete') {
    if (!current) return applied(null);
    if (current.deletedAt) return applied(toDto(current));
    if (decide(current, m, now) === 'conflict') return conflict(toDto(current));
    await tasksService.deleteTask(m.id, userId);
    return applied(await reread());
  }

  const parsed = taskDataSchema.safeParse(m.data);
  if (!parsed.success) return invalid('Los datos de la tarea no son válidos.');
  const data: TaskData = parsed.data;

  // Un tombstone nunca se resucita (antes que cualquier otra comprobación: el
  // cliente debe enterarse de que la tarea ya no existe).
  if (current?.deletedAt) return conflict(toDto(current));

  const target = await resolveTarget(userId, personal.id, data);
  if ('status' in target) return target;
  const { columnId } = target;

  if (!current) {
    const created = await tasksService.createTask(userId, {
      id: m.id,
      columnId,
      title: data.title,
      description: data.description ?? undefined,
      dueAt: data.dueAt ?? undefined,
      assigneeId: data.assigneeId ?? undefined,
      priority: data.priority,
      completedAt: data.completedAt ?? undefined,
      repeatUnit: data.repeatUnit,
      repeatInterval: data.repeatInterval,
      repeatWeekdays: data.repeatWeekdays,
      repeatAnchorDay: data.repeatAnchorDay,
      repeatSuccessorId: data.repeatSuccessorId,
    });
    // createTask siempre añade al final; si el cliente pidió otra posición se
    // reordena con el mismo servicio que usa la API.
    if (created.value.position !== data.position) {
      await bestEffort(() => tasksService.moveTask(m.id, userId, { columnId, position: data.position }));
    }
    return applied(await reread());
  }

  // No-op: coincide con el servidor; no se toca updatedAt.
  if (isSameTask(current, columnId, data)) return applied(toDto(current));
  if (decide(current, m, now) === 'conflict') return conflict(toDto(current));

  const patch = buildTaskPatch(current, data);
  const columnChanged = current.columnId !== columnId;
  const move = () => tasksService.moveTask(m.id, userId, { columnId, position: data.position });

  if (columnChanged) {
    // Cambiar de columna puede chocar con el WIP o los permisos: se hace PRIMERO
    // y sin tolerancia, para que ese rechazo no deje nada aplicado. Si después
    // falla la edición (4xx), el movimiento ya está confirmado: se devuelve
    // `applied` con el registro real y el cliente adopta lo que quedó.
    await move();
    if (Object.keys(patch).length > 0) {
      await bestEffort(() => tasksService.updateTask(m.id, userId, patch));
    }
  } else {
    if (Object.keys(patch).length > 0) await tasksService.updateTask(m.id, userId, patch);
    if (current.position !== data.position) await bestEffort(move);
  }
  return applied(await reread());
}

function isSameTask(current: TaskRow, columnId: string, d: TaskData): boolean {
  return (
    current.columnId === columnId &&
    current.title === d.title &&
    current.description === d.description &&
    current.priority === d.priority &&
    sameDate(current.dueAt, d.dueAt) &&
    current.assigneeId === d.assigneeId &&
    current.position === d.position &&
    sameDate(current.completedAt, d.completedAt) &&
    current.repeatUnit === d.repeatUnit &&
    current.repeatInterval === d.repeatInterval &&
    current.repeatWeekdays === d.repeatWeekdays &&
    current.repeatAnchorDay === d.repeatAnchorDay &&
    current.repeatSuccessorId === d.repeatSuccessorId
  );
}

/** Solo los campos que cambian: así no se disparan efectos de más (p. ej. la
 * notificación TASK_ASSIGNED solo sale si el responsable cambió de verdad). */
function buildTaskPatch(current: TaskRow, d: TaskData): UpdateTaskInput {
  const patch: UpdateTaskInput = {};
  if (current.title !== d.title) patch.title = d.title;
  if (current.description !== d.description) patch.description = d.description;
  if (current.priority !== d.priority) patch.priority = d.priority;
  if (!sameDate(current.dueAt, d.dueAt)) patch.dueAt = d.dueAt;
  if (current.assigneeId !== d.assigneeId) patch.assigneeId = d.assigneeId;
  if (!sameDate(current.completedAt, d.completedAt)) patch.completedAt = d.completedAt;
  const repeatChanged =
    current.repeatUnit !== d.repeatUnit ||
    current.repeatInterval !== d.repeatInterval ||
    current.repeatWeekdays !== d.repeatWeekdays ||
    current.repeatAnchorDay !== d.repeatAnchorDay;
  if (repeatChanged) {
    patch.repeatUnit = d.repeatUnit;
    patch.repeatInterval = d.repeatInterval;
    patch.repeatWeekdays = d.repeatWeekdays;
    patch.repeatAnchorDay = d.repeatAnchorDay;
  }
  if (current.repeatSuccessorId !== d.repeatSuccessorId) {
    patch.repeatSuccessorId = d.repeatSuccessorId;
  }
  return patch;
}

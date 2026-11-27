import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import { remindersService } from '../reminders/reminders.service';
import { ensurePersonalWorkspace } from '../workspaces/personal-workspace';
import { toSyncReminderDto } from './sync.mappers';
import {
  applied,
  checkOwnTask,
  conflict,
  decide,
  invalid,
  rejected,
  sameDate,
  type Outcome,
} from './sync.push.shared';
import { reminderDataSchema, type ReminderData, type SyncMutationInput } from './sync.schema';

// Mutaciones de `reminder` (contrato §5.4 y §5.5). Los recordatorios creados por
// sync llevan origin MOBILE y el dueño que los creó: el worker del backend los
// ignora (la app los avisa en local) y solo su dueño los ve. Puede haber varios
// por tarea.

export async function reminderMutation(
  userId: string,
  m: SyncMutationInput,
  now: number,
): Promise<Outcome> {
  const personal = await ensurePersonalWorkspace(prisma, userId);
  const current = await prisma.reminder.findUnique({
    where: { id: m.id },
    include: {
      task: { select: { column: { select: { board: { select: { workspaceId: true } } } } } },
    },
  });
  // Solo es mío un recordatorio MOBILE que yo creé sobre una tarea de mi
  // Personal; cualquier otro id existente es ajeno y no se revela.
  const mine =
    current !== null &&
    current.origin === 'MOBILE' &&
    current.createdById === userId &&
    current.task.column.board.workspaceId === personal.id;
  if (current && !mine) {
    return m.op === 'delete'
      ? applied(null)
      : rejected('ID_ALREADY_IN_USE', 'Ese identificador ya está en uso.');
  }

  const reread = async () =>
    toSyncReminderDto(await prisma.reminder.findUniqueOrThrow({ where: { id: m.id } }));

  if (m.op === 'delete') {
    if (!current) return applied(null);
    if (current.deletedAt) return applied(toSyncReminderDto(current));
    if (decide(current, m, now) === 'conflict') return conflict(toSyncReminderDto(current));
    try {
      await remindersService.deleteMobileReminder(m.id, userId);
    } catch (err) {
      // La tarea ya no es accesible (borrada): el recordatorio es mío, así que
      // se borra igual; el cliente solo necesita el tombstone.
      if (!(err instanceof AppError) || err.statusCode !== 404) throw err;
      await prisma.reminder.updateMany({
        where: { id: m.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }
    return applied(await reread());
  }

  const parsed = reminderDataSchema.safeParse(m.data);
  if (!parsed.success) return invalid('Los datos del recordatorio no son válidos.');
  const data: ReminderData = parsed.data;
  const input = {
    remindAt: new Date(data.remindAt),
    status: data.status,
    sentAt: data.sentAt ? new Date(data.sentAt) : null,
  };

  if (!current) {
    const taskProblem = await checkOwnTask(userId, personal.id, data.taskId);
    if (taskProblem) return taskProblem;
    await remindersService.createMobileReminder(data.taskId, userId, { id: m.id, ...input });
    return applied(await reread());
  }

  // Un tombstone nunca se resucita.
  if (current.deletedAt) return conflict(toSyncReminderDto(current));
  if (data.taskId !== current.taskId) {
    return invalid('No se puede mover un recordatorio a otra tarea.');
  }
  // SENT / DISMISSED son estados finales: es una regla de validez, no de
  // versiones, así que se comprueba antes del veredicto.
  if (data.status === 'PENDING' && current.status !== 'PENDING') {
    return rejected(
      'INVALID_MUTATION',
      'Un recordatorio ya enviado o cancelado no puede volver a pendiente.',
      toSyncReminderDto(current),
    );
  }

  const same =
    current.remindAt.getTime() === input.remindAt.getTime() &&
    current.status === data.status &&
    sameDate(current.sentAt, data.sentAt);
  if (same) return applied(toSyncReminderDto(current));
  if (decide(current, m, now) === 'conflict') return conflict(toSyncReminderDto(current));

  try {
    await remindersService.updateMobileReminder(m.id, userId, input);
  } catch (err) {
    if (err instanceof AppError && err.code === 'REMINDER_NOT_PENDING') {
      return rejected('INVALID_MUTATION', err.message, toSyncReminderDto(current));
    }
    throw err;
  }
  return applied(await reread());
}

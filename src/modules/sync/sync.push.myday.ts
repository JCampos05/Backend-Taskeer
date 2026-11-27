import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import { tasksService } from '../tasks/tasks.service';
import { toSyncMyDayDto } from './sync.mappers';
import { applied, checkVisibleTask, invalid, type Outcome } from './sync.push.shared';
import { myDayDataSchema, type SyncMutationInput } from './sync.schema';

// Mutaciones de `myDay` (contrato §5.4 y §5.5). El `id` ES el taskId: una marca
// por usuario y tarea, siempre propia. `addedAt` lo fija el dispositivo (acotado
// al reloj del servidor). A diferencia del resto de entidades NO sigue el
// veredicto por versiones sino la regla propia del contrato: alta, renovar si
// el `addedAt` es posterior, reactivar un tombstone, o no-op.

export async function myDayMutation(
  userId: string,
  m: SyncMutationInput,
  now: number,
): Promise<Outcome> {
  const where = { userId_taskId: { userId, taskId: m.id } };
  const mark = await prisma.myDayTask.findUnique({ where });
  const reread = async () => toSyncMyDayDto(await prisma.myDayTask.findUniqueOrThrow({ where }));

  if (m.op === 'delete') {
    // Sin marca, o ya quitada: nada que hacer (idempotente).
    if (!mark) return applied(null);
    if (mark.deletedAt) return applied(toSyncMyDayDto(mark));
    try {
      await tasksService.removeTaskFromMyDay(m.id, userId);
    } catch (err) {
      // La tarea ya no es accesible: la marca es mía, así que se quita igual.
      if (!(err instanceof AppError) || err.statusCode !== 404) throw err;
      await prisma.myDayTask.updateMany({
        where: { userId, taskId: m.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }
    return applied(await reread());
  }

  const parsed = myDayDataSchema.safeParse(m.data);
  if (!parsed.success) return invalid('Los datos de Mi día no son válidos.');

  const taskProblem = await checkVisibleTask(userId, m.id);
  if (taskProblem) return taskProblem;

  // Un `addedAt` en el futuro se acota a la hora del servidor.
  const addedAt = new Date(Math.min(new Date(parsed.data.addedAt).getTime(), now));
  await tasksService.setMyDayMark(m.id, userId, addedAt);
  return applied(await reread());
}

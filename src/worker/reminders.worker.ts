import { prisma } from '../config/prisma';
import { pushNotification } from '../modules/notifications/notifications.stream';

const INTERVALO_POLLING_MS = 60_000;

/**
 * Worker de recordatorios — simplificación temporal in-process (ver
 * docs/01-arquitectura.md, "Simplificación temporal: polling in-process en
 * la misma API"). Revisa `Reminder` con `status = PENDING AND
 * remindAt <= NOW()` cada minuto, dispara los que correspondan.
 *
 * Self-scheduling con `setTimeout` (no `setInterval`) a propósito: si una
 * corrida tarda más de un minuto (poco probable al volumen del MVP, pero
 * posible), evita que se acumulen corridas superpuestas — la siguiente
 * corrida se agenda solo después de que la actual termina.
 */
export function startRemindersWorker(): void {
  void ejecutarCorrida();
}

async function ejecutarCorrida(): Promise<void> {
  try {
    await dispararRecordatoriosVencidos();
  } catch (err) {
    console.error('[reminders-worker] Falló una corrida del worker:', err);
  } finally {
    setTimeout(() => void ejecutarCorrida(), INTERVALO_POLLING_MS);
  }
}

async function dispararRecordatoriosVencidos(): Promise<void> {
  const vencidos = await prisma.reminder.findMany({
    where: { status: 'PENDING', remindAt: { lte: new Date() } },
    include: { task: true },
  });

  for (const recordatorio of vencidos) {
    try {
      await dispararUno(recordatorio.id, recordatorio.taskId, recordatorio.task.title, recordatorio.task.assigneeId);
    } catch (err) {
      // Un recordatorio que falla no debe tumbar el resto de la corrida.
      console.error(`[reminders-worker] Falló al disparar reminder ${recordatorio.id}:`, err);
    }
  }
}

async function dispararUno(
  reminderId: string,
  taskId: string,
  taskTitle: string,
  assigneeId: string | null,
): Promise<void> {
  // updateMany condicionado (`status: 'PENDING'` en el where) en vez de
  // update por id: si por alguna razón dos corridas se solapan, solo una
  // logra marcarlo SENT (count === 1) y sigue adelante — la otra ve
  // count === 0 y no hace nada, mismo patrón atómico usado en la rotación
  // de refresh tokens y en el reset de contraseña con código.
  const { count } = await prisma.reminder.updateMany({
    where: { id: reminderId, status: 'PENDING' },
    data: { status: 'SENT', sentAt: new Date() },
  });

  if (count === 0) return;

  // Decisión confirmada por el usuario: si la tarea no tiene asignado, no
  // hay a quién notificar específicamente — el recordatorio igual queda
  // marcado SENT arriba, simplemente no genera Notification.
  if (!assigneeId) return;

  const notification = await prisma.notification.create({
    data: {
      userId: assigneeId,
      type: 'REMINDER',
      title: 'Recordatorio de tarea',
      body: taskTitle,
      taskId,
    },
  });

  pushNotification(notification);
}

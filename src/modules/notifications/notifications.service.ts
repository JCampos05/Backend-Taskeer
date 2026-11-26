import type { WorkspaceRole } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import type { SnoozeNotificationInput } from './notifications.schema';
import type { NotificationDto } from './notifications.types';

// Este módulo nunca crea Notification — las crean otros módulos
// internamente al resolver su propia lógica de negocio (modules/auth para
// RECOVERY_CODE_USED, modules/workspaces para INVITATION, etc.). Aquí solo
// se lee y se marca como leída, siempre implícito sobre
// `userId = req.auth.sub` — nunca se acepta un userId del cliente (ni body
// ni query), para que nadie pueda leer/marcar notificaciones ajenas (ver
// docs/01-arquitectura.md, "Notificaciones globales en tiempo real").

function toNotificationDto(notification: {
  id: string;
  userId: string;
  type: NotificationDto['type'];
  title: string;
  body: string | null;
  taskId: string | null;
  readAt: Date | null;
  createdAt: Date;
}): NotificationDto {
  return {
    id: notification.id,
    userId: notification.userId,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    taskId: notification.taskId,
    readAt: notification.readAt ? notification.readAt.toISOString() : null,
    createdAt: notification.createdAt.toISOString(),
  };
}

async function listNotifications(
  userId: string,
  unreadOnly: boolean | undefined,
): Promise<NotificationDto[]> {
  const notifications = await prisma.notification.findMany({
    where: {
      userId,
      // unreadOnly === true filtra readAt: null; undefined o false devuelve
      // todas (ver comentario en notifications.schema.ts).
      ...(unreadOnly ? { readAt: null } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });

  return notifications.map(toNotificationDto);
}

async function markAsRead(notificationId: string, userId: string): Promise<NotificationDto> {
  const notification = await prisma.notification.findFirst({
    where: { id: notificationId, userId },
  });

  if (!notification) {
    // No revela si la notificación existe pero pertenece a otro usuario —
    // 404 uniforme, mismo criterio que modules/tasks y modules/workspaces.
    throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'La notificación no existe.');
  }

  // Decisión: idempotente por diseño simple — si ya estaba leída, se
  // vuelve a fijar `readAt` a "ahora" en vez de dejarla intacta. No hay
  // efecto observable distinto para el usuario (sigue viéndola como leída
  // en ambos casos); si más adelante hace falta preservar el instante
  // exacto de la primera lectura, cambiar esto a un no-op condicional.
  const updated = await prisma.notification.update({
    where: { id: notification.id },
    data: { readAt: new Date() },
  });

  return toNotificationDto(updated);
}

async function markAllAsRead(userId: string): Promise<{ updatedCount: number }> {
  const result = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });

  return { updatedCount: result.count };
}

// Notification no tiene `deletedAt` en el schema (a diferencia de
// Board/Task) — no hay regla de soft delete que aplique acá, un borrado
// físico es correcto: es la bandeja de notificaciones del usuario, no un
// recurso colaborativo que otros necesiten auditar después.

async function deleteNotification(notificationId: string, userId: string): Promise<void> {
  const notification = await prisma.notification.findFirst({
    where: { id: notificationId, userId },
  });

  if (!notification) {
    throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'La notificación no existe.');
  }

  await prisma.notification.delete({ where: { id: notification.id } });
}

async function deleteReadNotifications(userId: string): Promise<{ deletedCount: number }> {
  const result = await prisma.notification.deleteMany({
    where: { userId, readAt: { not: null } },
  });

  return { deletedCount: result.count };
}

const SNOOZE_MIN_MS = 60_000;
const SNOOZE_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const SNOOZE_ROLES: WorkspaceRole[] = ['OWNER', 'ADMIN', 'EDITOR'];

/** Pospone una notificación de recordatorio ya disparada: crea un `Reminder`
 * nuevo (PENDING) sobre la misma tarea y retira la notificación de la bandeja.
 * El worker lo dispara de nuevo cuando llegue `remindAt`.
 *
 * Reglas: solo el asignado actual de la tarea puede posponer (el worker
 * notifica a `task.assigneeId`; si no coincidiera, el aviso le llegaría a otra
 * persona) y, como crear un Reminder es mutar la tarea, hereda el mismo rol
 * mínimo (OWNER/ADMIN/EDITOR) que `modules/reminders`. La notificación se
 * borra con `deleteMany` condicionado dentro de la misma transacción: si dos
 * clics llegan a la vez, solo uno ve count === 1 y crea el recordatorio. */
async function snoozeNotification(
  notificationId: string,
  userId: string,
  input: SnoozeNotificationInput,
): Promise<{ reminderId: string; remindAt: string }> {
  const notification = await prisma.notification.findFirst({
    where: { id: notificationId, userId },
  });
  if (!notification) {
    throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'La notificación no existe.');
  }

  if (notification.type !== 'REMINDER' || !notification.taskId) {
    throw new AppError(400, 'NOTIFICATION_NOT_SNOOZABLE', 'Esta notificación no se puede posponer.');
  }

  const remindAt = new Date(input.remindAt);
  const ahora = Date.now();
  if (remindAt.getTime() < ahora + SNOOZE_MIN_MS || remindAt.getTime() > ahora + SNOOZE_MAX_MS) {
    throw new AppError(
      400,
      'INVALID_SNOOZE_TIME',
      'La nueva fecha debe estar entre 1 minuto y 30 días a partir de ahora.',
    );
  }

  const taskId = notification.taskId;

  // Task, membresía y asignado se leen DENTRO de la transacción, justo antes
  // de crear el Reminder, para que no puedan cambiar entre la comprobación y
  // la escritura (tarea borrada, reasignada, usuario expulsado o degradado).
  const reminder = await prisma.$transaction(async (tx) => {
    const taskNotFound = new AppError(404, 'TASK_NOT_FOUND', 'La tarea ya no existe.');
    const task = await tx.task.findUnique({
      where: { id: taskId },
      include: { column: { include: { board: { include: { workspace: true } } } } },
    });
    if (
      !task ||
      task.deletedAt !== null ||
      task.column.board.deletedAt !== null ||
      task.column.board.workspace.deletedAt !== null
    ) {
      throw taskNotFound;
    }

    const membership = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: task.column.board.workspaceId, userId } },
    });
    if (!membership) {
      throw taskNotFound;
    }
    if (!SNOOZE_ROLES.includes(membership.role)) {
      throw new AppError(403, 'FORBIDDEN', 'No tienes permisos para posponer recordatorios en este workspace.');
    }
    if (task.assigneeId !== userId) {
      throw new AppError(
        409,
        'NOT_TASK_ASSIGNEE',
        'Solo quien tiene asignada la tarea puede posponer su recordatorio.',
      );
    }

    const { count } = await tx.notification.deleteMany({ where: { id: notification.id, userId } });
    if (count === 0) {
      throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'La notificación no existe.');
    }
    return tx.reminder.create({ data: { taskId: task.id, remindAt } });
  });

  return { reminderId: reminder.id, remindAt: reminder.remindAt.toISOString() };
}

export const notificationsService = {
  snoozeNotification,
  listNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  deleteReadNotifications,
};

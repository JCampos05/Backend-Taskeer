import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
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

export const notificationsService = {
  listNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  deleteReadNotifications,
};

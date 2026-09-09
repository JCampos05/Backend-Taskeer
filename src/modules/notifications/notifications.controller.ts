import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../errors/AppError';
import { notificationsService } from './notifications.service';
import { consumeStreamTicket, issueStreamTicket, openStream } from './notifications.stream';
import type {
  ListNotificationsQuery,
  NotificationIdParams,
  StreamQuery,
} from './notifications.schema';

// El controller nunca llama a Prisma directamente ni contiene lógica de
// negocio — solo adapta req/res y delega todo a notifications.service.

async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { unread } = req.query as unknown as ListNotificationsQuery;
    const notifications = await notificationsService.listNotifications(req.auth!.sub, unread);
    res.status(200).json({ notifications });
  } catch (err) {
    next(err);
  }
}

async function markAsRead(req: Request, res: Response, next: NextFunction) {
  try {
    const { notificationId } = req.params as unknown as NotificationIdParams;
    const notification = await notificationsService.markAsRead(notificationId, req.auth!.sub);
    res.status(200).json({ notification });
  } catch (err) {
    next(err);
  }
}

async function markAllAsRead(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await notificationsService.markAllAsRead(req.auth!.sub);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { notificationId } = req.params as unknown as NotificationIdParams;
    await notificationsService.deleteNotification(notificationId, req.auth!.sub);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

async function removeRead(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await notificationsService.deleteReadNotifications(req.auth!.sub);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function streamTicket(req: Request, res: Response, next: NextFunction) {
  try {
    // req.auth ya viene resuelto por requireAuth — este es el único punto
    // donde el ticket se emite ligado al usuario real de la sesión, nunca
    // a un userId que el cliente pudiera controlar.
    const ticket = issueStreamTicket(req.auth!.sub);
    res.status(200).json({ ticket });
  } catch (err) {
    next(err);
  }
}

function stream(req: Request, res: Response, next: NextFunction) {
  const { ticket } = req.query as unknown as StreamQuery;
  const userId = consumeStreamTicket(ticket);

  if (!userId) {
    // El ticket ya se borró al intentarlo (válido o no) — reintentar con
    // el mismo valor nunca puede funcionar, ni por accidente ni por un
    // segundo intento malicioso.
    next(new AppError(401, 'INVALID_STREAM_TICKET', 'El ticket de conexión no es válido o venció.'));
    return;
  }

  openStream(userId, res);
}

export const notificationsController = {
  list,
  markAsRead,
  markAllAsRead,
  remove,
  removeRead,
  streamTicket,
  stream,
};

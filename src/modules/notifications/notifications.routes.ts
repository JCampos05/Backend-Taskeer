import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../../middlewares/requireAuth';
import { validate } from '../../middlewares/validate';
import { notificationsController } from './notifications.controller';
import {
  listNotificationsSchema,
  notificationIdParamSchema,
  streamSchema,
} from './notifications.schema';

export const notificationsRouter = Router();

// Todos los endpoints requieren sesión activa y operan implícitamente sobre
// req.auth.sub como userId — nunca aceptan un userId del cliente (ni body
// ni query), para que nadie pueda leer/marcar notificaciones ajenas.

notificationsRouter.get(
  '/notifications',
  requireAuth,
  validate(listNotificationsSchema),
  notificationsController.list,
);

notificationsRouter.patch(
  '/notifications/read-all',
  requireAuth,
  notificationsController.markAllAsRead,
);

notificationsRouter.patch(
  '/notifications/:notificationId/read',
  requireAuth,
  validate(notificationIdParamSchema),
  notificationsController.markAsRead,
);

// Ruta literal '/read' antes que la paramétrica '/:notificationId' — si no,
// Express intentaría matchear "read" como si fuera un notificationId.
notificationsRouter.delete(
  '/notifications/read',
  requireAuth,
  notificationsController.removeRead,
);

notificationsRouter.delete(
  '/notifications/:notificationId',
  requireAuth,
  validate(notificationIdParamSchema),
  notificationsController.remove,
);

// Rate limit propio: generoso (una reconexión legítima bajo mala red puede
// pedir varios tickets seguidos), pero acotado — sin esto, nada impide
// pedir tickets sin parar (cada uno es barato de emitir, pero no gratis:
// ocupan memoria hasta vencer o usarse).
const ticketRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Demasiados intentos de conexión. Intenta de nuevo más tarde.',
    },
  },
});

notificationsRouter.post(
  '/notifications/stream-ticket',
  requireAuth,
  ticketRateLimit,
  notificationsController.streamTicket,
);

// Rate limit propio y por IP (no por usuario — este endpoint no tiene
// requireAuth, así que no hay identidad todavía cuando el limiter corre):
// es el único endpoint de la API sin JWT, así que no puede depender solo
// del límite genérico compartido con el resto de rutas — alguien sin
// cuenta mandando tickets con formato válido pero inválidos agotaría ese
// budget compartido y bloquearía de rebote a usuarios legítimos detrás de
// la misma IP.
const streamRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Demasiados intentos de conexión. Intenta de nuevo más tarde.',
    },
  },
});

// Sin requireAuth: la identidad no viene de un JWT en este request (un
// EventSource no puede mandar el header Authorization), viene de
// consumir el ticket de un solo uso emitido arriba — ver
// notifications.stream.ts para el detalle completo del diseño.
notificationsRouter.get(
  '/notifications/stream',
  streamRateLimit,
  validate(streamSchema),
  notificationsController.stream,
);

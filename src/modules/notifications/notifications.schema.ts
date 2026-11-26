import { z } from 'zod';

// Todo body/params/query se valida con Zod antes de tocar la base de datos —
// mismo patrón que modules/tasks/tasks.schema.ts.

const uuidParam = z.string().uuid('El identificador no es válido.');

// Los query params siempre llegan como string — acepta "true"/"false" y los
// convierte a boolean. Si el query param está ausente, queda `undefined`
// (distinto de `false`): el service lo interpreta como "sin filtro", no
// como "filtrar por leídas".
const unreadQueryParam = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

export const listNotificationsSchema = z.object({
  query: z.object({
    unread: unreadQueryParam,
  }),
});

export const notificationIdParamSchema = z.object({
  params: z.object({ notificationId: uuidParam }),
});

// ISO 8601 en UTC — la conversión "mañana a las 9:00 hora local" la hace el
// frontend con UserPreferences.timezoneId (CLAUDE.md, reglas no negociables).
// Que sea futura y no demasiado lejana se valida en el service contra el reloj
// del servidor, no aquí.
export const snoozeNotificationSchema = z.object({
  params: z.object({ notificationId: uuidParam }),
  body: z.object({
    remindAt: z.string().datetime({ message: 'La fecha debe ser un ISO 8601 válido.' }),
  }),
});

// El ticket es hex de 32 bytes (ver generateOpaqueToken-style en
// notifications.stream.ts) — 64 caracteres hexadecimales exactos.
export const streamSchema = z.object({
  query: z.object({
    ticket: z.string().regex(/^[a-f0-9]{64}$/, 'El ticket no tiene el formato correcto.'),
  }),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsSchema>['query'];
export type NotificationIdParams = z.infer<typeof notificationIdParamSchema>['params'];
export type SnoozeNotificationInput = z.infer<typeof snoozeNotificationSchema>['body'];
export type StreamQuery = z.infer<typeof streamSchema>['query'];

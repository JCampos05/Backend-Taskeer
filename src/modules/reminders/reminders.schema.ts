import { z } from 'zod';

// Todo body/params/query se valida con Zod antes de tocar la base de datos —
// mismo patrón que modules/tasks/tasks.schema.ts.

const uuidParam = z.string().uuid('El identificador no es válido.');

// ISO 8601 tal cual — se guarda en UTC sin convertir zona horaria en el
// backend (mismo patrón que Task.dueAt en tasks.schema.ts, ver CLAUDE.md,
// reglas no negociables).
const isoDateString = z.string().datetime({ message: 'La fecha debe ser un ISO 8601 válido.' });

export const createReminderSchema = z.object({
  params: z.object({ taskId: uuidParam }),
  body: z.object({
    remindAt: isoDateString,
  }),
});

export const listRemindersSchema = z.object({
  params: z.object({ taskId: uuidParam }),
});

export const reminderIdParamSchema = z.object({
  params: z.object({ reminderId: uuidParam }),
});

export type CreateReminderInput = z.infer<typeof createReminderSchema>['body'];
export type CreateReminderParams = z.infer<typeof createReminderSchema>['params'];
export type ListRemindersParams = z.infer<typeof listRemindersSchema>['params'];
export type ReminderIdParams = z.infer<typeof reminderIdParamSchema>['params'];

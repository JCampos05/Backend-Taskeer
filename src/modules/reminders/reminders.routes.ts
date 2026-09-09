import { Router } from 'express';
import { requireAuth } from '../../middlewares/requireAuth';
import { validate } from '../../middlewares/validate';
import { remindersController } from './reminders.controller';
import {
  createReminderSchema,
  listRemindersSchema,
  reminderIdParamSchema,
} from './reminders.schema';

export const remindersRouter = Router();

// Todo requiere sesión activa — requireAuth solo resuelve identidad; cada
// método de reminders.service.ts verifica membresía/rol explícitamente
// contra WorkspaceMember (a través de la cadena Task → Column → Board →
// Workspace) antes de cada acción.

remindersRouter.post(
  '/tasks/:taskId/reminders',
  requireAuth,
  validate(createReminderSchema),
  remindersController.create,
);

remindersRouter.get(
  '/tasks/:taskId/reminders',
  requireAuth,
  validate(listRemindersSchema),
  remindersController.list,
);

// Nivel raíz, no anidado bajo /tasks/:taskId/... — el reminderId ya es
// contexto suficiente (mismo patrón que PATCH/DELETE /tasks/:taskId en
// modules/tasks/tasks.routes.ts).
remindersRouter.delete(
  '/reminders/:reminderId',
  requireAuth,
  validate(reminderIdParamSchema),
  remindersController.cancel,
);

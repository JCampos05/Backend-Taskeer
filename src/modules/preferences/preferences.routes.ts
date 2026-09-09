import { Router } from 'express';
import { requireAuth } from '../../middlewares/requireAuth';
import { validate } from '../../middlewares/validate';
import { preferencesController } from './preferences.controller';
import { updatePreferencesSchema } from './preferences.schema';

export const preferencesRouter = Router();

// Sin permisos de workspace de por medio: UserPreferences es 1-a-1 con el
// usuario autenticado, requireAuth (resuelve identidad) es suficiente — no
// hay rol/membresía que verificar (ver docs/02-modelo-datos.md).
preferencesRouter.get('/me/preferences', requireAuth, preferencesController.getPreferences);
preferencesRouter.patch(
  '/me/preferences',
  requireAuth,
  validate(updatePreferencesSchema),
  preferencesController.updatePreferences,
);

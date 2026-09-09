import type { Request, Response, NextFunction } from 'express';
import { preferencesService } from './preferences.service';
import type { UpdatePreferencesInput } from './preferences.schema';

// El controller nunca llama a Prisma directamente ni contiene lógica de
// negocio — solo adapta req/res y delega todo a preferences.service.

async function getPreferences(req: Request, res: Response, next: NextFunction) {
  try {
    const preferences = await preferencesService.getPreferences(req.auth!.sub);
    res.status(200).json({ preferences });
  } catch (err) {
    next(err);
  }
}

async function updatePreferences(req: Request, res: Response, next: NextFunction) {
  try {
    const input = req.body as UpdatePreferencesInput;
    const preferences = await preferencesService.updatePreferences(req.auth!.sub, input);
    res.status(200).json({ preferences });
  } catch (err) {
    next(err);
  }
}

export const preferencesController = {
  getPreferences,
  updatePreferences,
};

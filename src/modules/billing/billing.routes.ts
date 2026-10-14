import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../../middlewares/requireAuth';
import { billingController } from './billing.controller';

export const billingRouter = Router();

// Respuestas privadas por usuario: que ningún proxy o caché compartido las
// guarde ni las sirva a otra persona.
function noStore(_req: Request, res: Response, next: NextFunction) {
  res.set('Cache-Control', 'no-store');
  next();
}

// Solo lectura por ahora: no hay checkout ni cambio de plan (fuera de
// alcance, ver docs/07-alcance-mvp.md). Sin validate(): no reciben
// body/params/query. La identidad sale de requireAuth, nunca de un parámetro.
billingRouter.get('/billing/plans', requireAuth, noStore, billingController.listPlans);
billingRouter.get('/me/subscription', requireAuth, noStore, billingController.getMySubscription);

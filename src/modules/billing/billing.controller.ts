import type { NextFunction, Request, Response } from 'express';
import { billingService } from './billing.service';

// El controller nunca llama a Prisma directamente ni contiene lógica de
// negocio — solo adapta req/res y delega todo a billing.service.

async function listPlans(_req: Request, res: Response, next: NextFunction) {
  try {
    const plans = await billingService.listPlans();
    res.status(200).json({ plans });
  } catch (err) {
    next(err);
  }
}

async function getMySubscription(req: Request, res: Response, next: NextFunction) {
  try {
    const subscription = await billingService.getMySubscription(req.auth!.sub);
    res.status(200).json({ subscription });
  } catch (err) {
    next(err);
  }
}

export const billingController = {
  listPlans,
  getMySubscription,
};

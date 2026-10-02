import type { NextFunction, Request, Response } from 'express';
import { myDayService } from './my-day.service';

// El controller nunca llama a Prisma directamente ni contiene lógica de
// negocio — solo adapta req/res y delega todo a my-day.service.

async function getMyDay(req: Request, res: Response, next: NextFunction) {
  try {
    const myDay = await myDayService.getMyDay(req.auth!.sub, req.auth!.email);
    res.status(200).json({ myDay });
  } catch (err) {
    next(err);
  }
}

export const myDayController = {
  getMyDay,
};

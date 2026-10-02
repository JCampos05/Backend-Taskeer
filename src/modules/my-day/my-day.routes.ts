import { Router } from 'express';
import { requireAuth } from '../../middlewares/requireAuth';
import { myDayController } from './my-day.controller';

export const myDayRouter = Router();

// Nivel raíz bajo /me, mismo criterio que GET /me/reminders/upcoming y
// GET /me/preferences — identidad resuelta por requireAuth, sin parámetro
// de workspace/board (cruza todos los del usuario). Sin validate(): no
// recibe body/params/query.
myDayRouter.get('/me/my-day', requireAuth, myDayController.getMyDay);

import type { Request, Response, NextFunction } from 'express';
import { remindersService } from './reminders.service';
import type {
  CreateReminderInput,
  ListRemindersParams,
  ReminderIdParams,
} from './reminders.schema';

// El controller nunca llama a Prisma directamente ni contiene lógica de
// negocio — solo adapta req/res y delega todo a reminders.service.

async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { taskId } = req.params as unknown as ListRemindersParams;
    const input = req.body as CreateReminderInput;
    const reminder = await remindersService.createReminder(taskId, req.auth!.sub, input);
    res.status(201).json({ reminder });
  } catch (err) {
    next(err);
  }
}

async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { taskId } = req.params as unknown as ListRemindersParams;
    const reminders = await remindersService.listRemindersByTask(taskId, req.auth!.sub);
    res.status(200).json({ reminders });
  } catch (err) {
    next(err);
  }
}

async function cancel(req: Request, res: Response, next: NextFunction) {
  try {
    const { reminderId } = req.params as unknown as ReminderIdParams;
    const reminder = await remindersService.cancelReminder(reminderId, req.auth!.sub);
    res.status(200).json({ reminder });
  } catch (err) {
    next(err);
  }
}

async function listUpcoming(req: Request, res: Response, next: NextFunction) {
  try {
    const reminders = await remindersService.listUpcomingForUser(req.auth!.sub);
    res.status(200).json({ reminders });
  } catch (err) {
    next(err);
  }
}

export const remindersController = {
  create,
  list,
  cancel,
  listUpcoming,
};

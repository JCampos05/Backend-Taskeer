import type { Request, Response, NextFunction } from 'express';
import { tasksService } from './tasks.service';
import type {
  CreateTaskInput,
  ListTasksQuery,
  MoveTaskInput,
  TaskIdParams,
  UpdateTaskInput,
} from './tasks.schema';

// El controller nunca llama a Prisma directamente ni contiene lógica de
// negocio — solo adapta req/res y delega todo a tasks.service.

async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const input = req.body as CreateTaskInput;
    const task = await tasksService.createTask(req.auth!.sub, input);
    res.status(201).json({ task });
  } catch (err) {
    next(err);
  }
}

async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { boardId } = req.query as unknown as ListTasksQuery;
    const tasks = await tasksService.listTasksByBoard(boardId, req.auth!.sub);
    res.status(200).json({ tasks });
  } catch (err) {
    next(err);
  }
}

async function getById(req: Request, res: Response, next: NextFunction) {
  try {
    const { taskId } = req.params as unknown as TaskIdParams;
    const task = await tasksService.getTaskById(taskId, req.auth!.sub);
    res.status(200).json({ task });
  } catch (err) {
    next(err);
  }
}

async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { taskId } = req.params as unknown as TaskIdParams;
    const input = req.body as UpdateTaskInput;
    const task = await tasksService.updateTask(taskId, req.auth!.sub, input);
    res.status(200).json({ task });
  } catch (err) {
    next(err);
  }
}

async function move(req: Request, res: Response, next: NextFunction) {
  try {
    const { taskId } = req.params as unknown as TaskIdParams;
    const input = req.body as MoveTaskInput;
    const task = await tasksService.moveTask(taskId, req.auth!.sub, input);
    res.status(200).json({ task });
  } catch (err) {
    next(err);
  }
}

async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { taskId } = req.params as unknown as TaskIdParams;
    await tasksService.deleteTask(taskId, req.auth!.sub);
    res.status(200).json({ deleted: true });
  } catch (err) {
    next(err);
  }
}

export const tasksController = {
  create,
  list,
  getById,
  update,
  move,
  remove,
};

import type { Request, Response, NextFunction } from 'express';
import { tasksService } from './tasks.service';
import type {
  CreateSubtaskInput,
  CreateTaskInput,
  ListTasksQuery,
  MoveTaskInput,
  SubtaskParams,
  TaskIdParams,
  UpdateSubtaskInput,
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
    const { boardId, priority } = req.query as unknown as ListTasksQuery;
    const tasks = await tasksService.listTasksByBoard(boardId, req.auth!.sub, priority);
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

async function listSubtasks(req: Request, res: Response, next: NextFunction) {
  try {
    const { taskId } = req.params as unknown as TaskIdParams;
    const subtasks = await tasksService.listSubtasks(taskId, req.auth!.sub);
    res.status(200).json({ subtasks });
  } catch (err) {
    next(err);
  }
}

async function createSubtask(req: Request, res: Response, next: NextFunction) {
  try {
    const { taskId } = req.params as unknown as TaskIdParams;
    const input = req.body as CreateSubtaskInput;
    const subtask = await tasksService.createSubtask(taskId, req.auth!.sub, input);
    res.status(201).json({ subtask });
  } catch (err) {
    next(err);
  }
}

async function updateSubtask(req: Request, res: Response, next: NextFunction) {
  try {
    const { taskId, subtaskId } = req.params as unknown as SubtaskParams;
    const input = req.body as UpdateSubtaskInput;
    const subtask = await tasksService.updateSubtask(taskId, subtaskId, req.auth!.sub, input);
    res.status(200).json({ subtask });
  } catch (err) {
    next(err);
  }
}

async function removeSubtask(req: Request, res: Response, next: NextFunction) {
  try {
    const { taskId, subtaskId } = req.params as unknown as SubtaskParams;
    await tasksService.deleteSubtask(taskId, subtaskId, req.auth!.sub);
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
  listSubtasks,
  createSubtask,
  updateSubtask,
  removeSubtask,
};

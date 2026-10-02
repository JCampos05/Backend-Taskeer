import { Router } from 'express';
import { requireAuth } from '../../middlewares/requireAuth';
import { validate } from '../../middlewares/validate';
import { tasksController } from './tasks.controller';
import {
  createSubtaskSchema,
  createTaskSchema,
  listTasksSchema,
  moveTaskSchema,
  subtaskParamsSchema,
  taskIdParamSchema,
  updateSubtaskSchema,
  updateTaskSchema,
} from './tasks.schema';

export const tasksRouter = Router();

// Task no se anida de forma limpia bajo /workspaces/:workspaceId/boards/:boardId
// sin quedar en tres niveles de anidamiento (viola la convención de un solo
// nivel, ver .claude/skills/taskeer-conventions/SKILL.md) — endpoint de nivel
// raíz filtrable por query param (`GET /tasks?boardId=...`), más rutas por id
// donde el id ya resuelve el contexto de workspace/board.
//
// Todo requiere sesión activa — requireAuth solo resuelve identidad; cada
// método de tasks.service.ts verifica membresía/rol explícitamente contra
// WorkspaceMember antes de cada acción.

tasksRouter.post('/tasks', requireAuth, validate(createTaskSchema), tasksController.create);

tasksRouter.get('/tasks', requireAuth, validate(listTasksSchema), tasksController.list);

tasksRouter.get(
  '/tasks/:taskId',
  requireAuth,
  validate(taskIdParamSchema),
  tasksController.getById,
);

tasksRouter.patch(
  '/tasks/:taskId',
  requireAuth,
  validate(updateTaskSchema),
  tasksController.update,
);

tasksRouter.post(
  '/tasks/:taskId/move',
  requireAuth,
  validate(moveTaskSchema),
  tasksController.move,
);

tasksRouter.delete(
  '/tasks/:taskId',
  requireAuth,
  validate(taskIdParamSchema),
  tasksController.remove,
);

// --- Subtasks (checklist dentro de una tarea) ---

tasksRouter.get(
  '/tasks/:taskId/subtasks',
  requireAuth,
  validate(taskIdParamSchema),
  tasksController.listSubtasks,
);

tasksRouter.post(
  '/tasks/:taskId/subtasks',
  requireAuth,
  validate(createSubtaskSchema),
  tasksController.createSubtask,
);

tasksRouter.patch(
  '/tasks/:taskId/subtasks/:subtaskId',
  requireAuth,
  validate(updateSubtaskSchema),
  tasksController.updateSubtask,
);

tasksRouter.delete(
  '/tasks/:taskId/subtasks/:subtaskId',
  requireAuth,
  validate(subtaskParamsSchema),
  tasksController.removeSubtask,
);

// --- "Mi día" (marca personal, ver tasks.service.ts) ---

tasksRouter.get(
  '/tasks/:taskId/my-day',
  requireAuth,
  validate(taskIdParamSchema),
  tasksController.getMyDayStatus,
);

tasksRouter.put(
  '/tasks/:taskId/my-day',
  requireAuth,
  validate(taskIdParamSchema),
  tasksController.addToMyDay,
);

tasksRouter.delete(
  '/tasks/:taskId/my-day',
  requireAuth,
  validate(taskIdParamSchema),
  tasksController.removeFromMyDay,
);

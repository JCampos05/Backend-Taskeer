import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../../middlewares/requireAuth';
import { validate } from '../../middlewares/validate';
import { boardsController } from './boards.controller';
import {
  boardIdParamsSchema,
  boardMemberOverrideParamsSchema,
  columnParamsSchema,
  createBoardSchema,
  moveBoardsSchema,
  createColumnSchema,
  setBoardMemberOverrideSchema,
  updateBoardSchema,
  updateColumnSchema,
  workspaceIdParamSchema,
} from './boards.schema';

export const boardsRouter = Router();

// Mover tableros es una operación pesada (transacción con muchas consultas) y
// destructiva para quien pierde acceso — límite propio, más estricto que el
// general de la API.
const moveBoardsRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// Todo lo de boards requiere sesión activa — requireAuth solo resuelve
// identidad (req.auth), nunca el nivel de permiso dentro del workspace; cada
// método de boards.service.ts verifica membresía/rol explícitamente contra
// WorkspaceMember antes de cada acción (mismo patrón que modules/workspaces).

// Antes que las rutas con :boardId para que "move" nunca se lea como un id.
boardsRouter.post(
  '/workspaces/:workspaceId/boards/move',
  requireAuth,
  moveBoardsRateLimit,
  validate(moveBoardsSchema),
  boardsController.move,
);

boardsRouter.post(
  '/workspaces/:workspaceId/boards',
  requireAuth,
  validate(createBoardSchema),
  boardsController.create,
);

boardsRouter.get(
  '/workspaces/:workspaceId/boards',
  requireAuth,
  validate(workspaceIdParamSchema),
  boardsController.list,
);

boardsRouter.get(
  '/workspaces/:workspaceId/boards/:boardId',
  requireAuth,
  validate(boardIdParamsSchema),
  boardsController.getById,
);

boardsRouter.patch(
  '/workspaces/:workspaceId/boards/:boardId',
  requireAuth,
  validate(updateBoardSchema),
  boardsController.update,
);

boardsRouter.delete(
  '/workspaces/:workspaceId/boards/:boardId',
  requireAuth,
  validate(boardIdParamsSchema),
  boardsController.remove,
);

boardsRouter.post(
  '/workspaces/:workspaceId/boards/:boardId/columns',
  requireAuth,
  validate(createColumnSchema),
  boardsController.createColumn,
);

boardsRouter.patch(
  '/workspaces/:workspaceId/boards/:boardId/columns/:columnId',
  requireAuth,
  validate(updateColumnSchema),
  boardsController.updateColumn,
);

boardsRouter.delete(
  '/workspaces/:workspaceId/boards/:boardId/columns/:columnId',
  requireAuth,
  validate(columnParamsSchema),
  boardsController.removeColumn,
);

// --- Roles por tablero individual (overrides) ---

boardsRouter.get(
  '/workspaces/:workspaceId/boards/:boardId/member-overrides',
  requireAuth,
  validate(boardIdParamsSchema),
  boardsController.listMemberOverrides,
);

boardsRouter.put(
  '/workspaces/:workspaceId/boards/:boardId/member-overrides/:userId',
  requireAuth,
  validate(setBoardMemberOverrideSchema),
  boardsController.setMemberOverride,
);

boardsRouter.delete(
  '/workspaces/:workspaceId/boards/:boardId/member-overrides/:userId',
  requireAuth,
  validate(boardMemberOverrideParamsSchema),
  boardsController.removeMemberOverride,
);

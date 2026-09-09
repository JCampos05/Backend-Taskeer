import type { Request, Response, NextFunction } from 'express';
import { boardsService } from './boards.service';
import type {
  BoardIdParams,
  ColumnParams,
  CreateBoardInput,
  CreateColumnInput,
  UpdateBoardInput,
  UpdateColumnInput,
  WorkspaceIdParams,
} from './boards.schema';

// El controller nunca llama a Prisma directamente ni contiene lógica de
// negocio — solo adapta req/res y delega todo a boards.service.

async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = req.params as unknown as WorkspaceIdParams;
    const input = req.body as CreateBoardInput;
    const board = await boardsService.createBoard(workspaceId, req.auth!.sub, input);
    res.status(201).json({ board });
  } catch (err) {
    next(err);
  }
}

async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = req.params as unknown as WorkspaceIdParams;
    const boards = await boardsService.listBoards(workspaceId, req.auth!.sub);
    res.status(200).json({ boards });
  } catch (err) {
    next(err);
  }
}

async function getById(req: Request, res: Response, next: NextFunction) {
  try {
    const { workspaceId, boardId } = req.params as unknown as BoardIdParams;
    const board = await boardsService.getBoardById(workspaceId, boardId, req.auth!.sub);
    res.status(200).json({ board });
  } catch (err) {
    next(err);
  }
}

async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { workspaceId, boardId } = req.params as unknown as BoardIdParams;
    const input = req.body as UpdateBoardInput;
    const board = await boardsService.updateBoard(workspaceId, boardId, req.auth!.sub, input);
    res.status(200).json({ board });
  } catch (err) {
    next(err);
  }
}

async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { workspaceId, boardId } = req.params as unknown as BoardIdParams;
    await boardsService.deleteBoard(workspaceId, boardId, req.auth!.sub);
    res.status(200).json({ deleted: true });
  } catch (err) {
    next(err);
  }
}

async function createColumn(req: Request, res: Response, next: NextFunction) {
  try {
    const { workspaceId, boardId } = req.params as unknown as BoardIdParams;
    const input = req.body as CreateColumnInput;
    const column = await boardsService.createColumn(workspaceId, boardId, req.auth!.sub, input);
    res.status(201).json({ column });
  } catch (err) {
    next(err);
  }
}

async function updateColumn(req: Request, res: Response, next: NextFunction) {
  try {
    const { workspaceId, boardId, columnId } = req.params as unknown as ColumnParams;
    const input = req.body as UpdateColumnInput;
    const column = await boardsService.updateColumn(
      workspaceId,
      boardId,
      columnId,
      req.auth!.sub,
      input,
    );
    res.status(200).json({ column });
  } catch (err) {
    next(err);
  }
}

async function removeColumn(req: Request, res: Response, next: NextFunction) {
  try {
    const { workspaceId, boardId, columnId } = req.params as unknown as ColumnParams;
    await boardsService.deleteColumn(workspaceId, boardId, columnId, req.auth!.sub);
    res.status(200).json({ deleted: true });
  } catch (err) {
    next(err);
  }
}

export const boardsController = {
  create,
  list,
  getById,
  update,
  remove,
  createColumn,
  updateColumn,
  removeColumn,
};

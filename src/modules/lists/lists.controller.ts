import type { NextFunction, Request, Response } from 'express';
import { listsService } from './lists.service';
import type { CreateListInput, ListIdParams, UpdateListInput } from './lists.schema';

// El controller nunca llama a Prisma directamente ni contiene lógica de
// negocio — solo adapta req/res y delega todo a lists.service.

async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const lists = await listsService.listLists(req.auth!.sub);
    res.status(200).json({ lists });
  } catch (err) {
    next(err);
  }
}

async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const input = req.body as CreateListInput;
    const { value: list, created } = await listsService.createList(req.auth!.sub, input);
    // 200 si fue un reintento idempotente de una creación ya aplicada.
    res.status(created ? 201 : 200).json({ list });
  } catch (err) {
    next(err);
  }
}

async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { listId } = req.params as unknown as ListIdParams;
    const input = req.body as UpdateListInput;
    const list = await listsService.updateList(req.auth!.sub, listId, input);
    res.status(200).json({ list });
  } catch (err) {
    next(err);
  }
}

async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { listId } = req.params as unknown as ListIdParams;
    await listsService.deleteList(req.auth!.sub, listId);
    res.status(200).json({ deleted: true });
  } catch (err) {
    next(err);
  }
}

export const listsController = {
  list,
  create,
  update,
  remove,
};

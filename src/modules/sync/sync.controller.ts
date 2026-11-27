import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../errors/AppError';
import { syncPushService } from './sync.push.service';
import { SYNC_MAX_BATCH, type SyncChangesQuery, type SyncMutationInput } from './sync.schema';
import { syncService } from './sync.service';

// El controller nunca llama a Prisma directamente ni contiene lógica de
// negocio — solo adapta req/res y delega todo a los services.

async function changes(req: Request, res: Response, next: NextFunction) {
  try {
    const { cursor, limit } = req.query as unknown as SyncChangesQuery;
    const result = await syncService.getChanges(req.auth!.sub, cursor, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/** Antes de validar con Zod: un lote de más de 100 mutaciones es 413
 * BATCH_TOO_LARGE (no un 400 de validación). */
function limitBatchSize(req: Request, _res: Response, next: NextFunction) {
  const mutations = (req.body as { mutations?: unknown } | undefined)?.mutations;
  if (Array.isArray(mutations) && mutations.length > SYNC_MAX_BATCH) {
    return next(
      new AppError(413, 'BATCH_TOO_LARGE', `Un lote admite como máximo ${SYNC_MAX_BATCH} mutaciones.`),
    );
  }
  next();
}

async function push(req: Request, res: Response, next: NextFunction) {
  try {
    const { mutations } = req.body as { mutations: SyncMutationInput[] };
    const result = await syncPushService.push(req.auth!.sub, mutations);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export const syncController = {
  changes,
  push,
  limitBatchSize,
};

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../../middlewares/requireAuth';
import { validate } from '../../middlewares/validate';
import { syncContract } from './sync.contract';
import { syncChangesSchema, syncPushSchema } from './sync.schema';
import { syncController } from './sync.controller';

export const syncRouter = Router();

// Límite propio por USUARIO (no por IP), uno por endpoint y separado del global
// (contrato §5.8): 300 peticiones / 15 min en cada uno. Varios usuarios pueden
// compartir IP (NAT móvil) y una carga inicial paginada son muchas peticiones.
// Va DESPUÉS de requireAuth para poder usar `req.auth.sub` como clave. Al
// superarse responde 429 con `Retry-After` (lo añade standardHeaders).
function syncRateLimit(endpoint: string) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `sync:${endpoint}:${req.auth?.sub ?? 'anon'}`,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Demasiadas solicitudes de sincronización. Espera un momento.',
      },
    },
  });
}

// requireAuth solo resuelve identidad; los services acotan CADA consulta a lo
// que el usuario autenticado puede ver. Se aplica por ruta (no con
// `syncRouter.use`) para no afectar a los routers montados después.
syncRouter.get(
  '/sync/changes',
  requireAuth,
  syncContract,
  syncRateLimit('changes'),
  validate(syncChangesSchema),
  syncController.changes,
);

syncRouter.post(
  '/sync/push',
  requireAuth,
  syncContract,
  syncRateLimit('push'),
  syncController.limitBatchSize,
  validate(syncPushSchema),
  syncController.push,
);

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../../middlewares/requireAuth';
import { validate } from '../../middlewares/validate';
import { listsController } from './lists.controller';
import { createListSchema, listIdParamsSchema, updateListSchema } from './lists.schema';

export const listsRouter = Router();

// Límite propio y holgado, por usuario (no por IP): la app móvil sincroniza
// listas con frecuencia y varios usuarios pueden compartir IP (NAT móvil), así
// que el contador global de 300/15 min por IP se quedaría corto. Va DESPUÉS de
// requireAuth para poder usar `req.auth.sub` como clave.
const listsRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.auth?.sub ?? 'anon'}`,
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Demasiadas solicitudes. Intenta de nuevo más tarde.',
    },
  },
});

// Todo lo de lists requiere sesión activa. requireAuth solo resuelve identidad;
// lists.service.ts acota cada consulta al workspace Personal del usuario. Se
// aplica por ruta (no con `listsRouter.use`) para que no afecte a los routers
// montados después en la API.
const guard = [requireAuth, listsRateLimit];

listsRouter.get('/lists', ...guard, listsController.list);

listsRouter.post('/lists', ...guard, validate(createListSchema), listsController.create);

listsRouter.patch(
  '/lists/:listId',
  ...guard,
  validate(updateListSchema),
  listsController.update,
);

listsRouter.delete(
  '/lists/:listId',
  ...guard,
  validate(listIdParamsSchema),
  listsController.remove,
);

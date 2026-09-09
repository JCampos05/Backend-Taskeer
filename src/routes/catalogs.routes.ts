import { Router } from 'express';
import { prisma } from '../config/prisma';
import { requireAuth } from '../middlewares/requireAuth';

// Catálogos estáticos (ver docs/02-modelo-datos.md) — funcionalidad
// transversal simple, sin reglas de negocio propias, por eso van como MVC
// clásico en vez de un módulo de dominio completo.
export const catalogsRouter = Router();

catalogsRouter.get('/catalogs/countries', requireAuth, async (_req, res, next) => {
  try {
    const countries = await prisma.country.findMany({
      orderBy: { name: 'asc' },
    });
    res.json({ countries });
  } catch (err) {
    next(err);
  }
});

catalogsRouter.get('/catalogs/timezones', requireAuth, async (_req, res, next) => {
  try {
    const timezones = await prisma.timezone.findMany({
      orderBy: { utcOffset: 'asc' },
    });
    res.json({ timezones });
  } catch (err) {
    next(err);
  }
});

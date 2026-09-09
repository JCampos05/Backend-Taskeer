import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';

// Middleware transversal de validación Zod, reutilizable por cualquier módulo
// de dominio. Valida body/params/query juntos contra un único schema y
// reemplaza `req.body`/`req.query` con la versión ya parseada (tipos
// coercidos/transformados por Zod, ej. trim + lowercase de email). Los
// errores de Zod los captura `errorHandler` de forma centralizada — ver
// docs/03-autenticacion-seguridad.md, sección "Validación de entrada".
export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse({
        body: req.body,
        params: req.params,
        query: req.query,
      });

      if (parsed.body !== undefined) req.body = parsed.body;
      if (parsed.query !== undefined) req.query = parsed.query;
      if (parsed.params !== undefined) req.params = parsed.params;

      next();
    } catch (err) {
      next(err);
    }
  };
}

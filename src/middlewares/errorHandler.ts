import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/AppError';

// Nunca se expone stack trace ni detalle interno al cliente — ver
// docs/03-autenticacion-seguridad.md y la skill taskeer-conventions para el
// formato de error de la API.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: { code: err.code, message: err.message },
    });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Los datos enviados no son válidos.' },
    });
  }

  console.error(err);
  return res.status(500).json({
    error: { code: 'INTERNAL_SERVER_ERROR', message: 'Ocurrió un error inesperado.' },
  });
}

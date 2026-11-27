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

  // Errores del body parser (express.json): cuerpo demasiado grande o JSON roto.
  // Sin esto salían como 500. En /sync el tamaño tiene su código propio.
  const parserError = err as { type?: string } | null;
  if (parserError?.type === 'entity.too.large') {
    const isSync = req.originalUrl.startsWith('/api/v1/sync/');
    return res.status(413).json({
      error: {
        code: isSync ? 'BATCH_TOO_LARGE' : 'PAYLOAD_TOO_LARGE',
        message: 'El cuerpo de la petición es demasiado grande.',
      },
    });
  }
  if (parserError?.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'El cuerpo de la petición no es un JSON válido.' },
    });
  }

  // Otros errores del parser con status 4xx (codificación, abortada...) son
  // defecto de la petición, no un fallo del servidor.
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500 && parserError?.type) {
    return res.status(status).json({
      error: { code: 'VALIDATION_ERROR', message: 'La petición no es válida.' },
    });
  }

  // En /sync un error de Prisma puede traer en su mensaje los argumentos de la
  // consulta (título/descripción del usuario): ahí solo se registra qué falló.
  if (req.originalUrl.startsWith('/api/v1/sync/')) {
    const e = err as { name?: string; code?: string; stack?: string };
    console.error('[sync]', e?.name, e?.code, e?.stack?.split('\n')[1]?.trim());
  } else {
    console.error(err);
  }
  return res.status(500).json({
    error: { code: 'INTERNAL_SERVER_ERROR', message: 'Ocurrió un error inesperado.' },
  });
}

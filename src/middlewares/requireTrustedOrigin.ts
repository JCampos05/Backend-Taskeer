import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { AppError } from '../errors/AppError';

// Con la cookie de refresh en `sameSite: 'none'` (necesaria porque Frontend y
// Backend viven en dominios distintos en producción), CORS deja de ser una
// barrera real contra CSRF en rutas que no leen nada del body: una petición
// "simple" (sin JSON, sin headers custom) no dispara preflight, así que
// cualquier sitio puede forzarla igual — el navegador solo le impediría LEER
// la respuesta, no que la petición se ejecute. Este middleware valida del
// lado servidor que el `Origin` sea uno de los permitidos antes de tocar la
// cookie de sesión, reemplazando la protección que `sameSite: 'strict'` daba
// gratis. Usar en cualquier ruta que mute estado dependiendo solo de la
// cookie (sin exigir un body validado).
export function requireTrustedOrigin(req: Request, _res: Response, next: NextFunction) {
  const origin = req.get('origin');
  if (!origin || !env.corsAllowedOrigins.includes(origin)) {
    throw new AppError(403, 'UNTRUSTED_ORIGIN', 'Origen no autorizado.');
  }
  next();
}

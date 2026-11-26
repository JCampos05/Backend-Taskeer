import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';
import { requireTrustedOrigin } from './requireTrustedOrigin';
import { validate } from './validate';

// Cliente móvil (app Android): se identifica con la cabecera `X-Client: mobile`.
// En ese modo la sesión NO usa cookies: el refresh token viaja en el cuerpo
// (JSON) de la petición y de la respuesta.
//
// Por qué esto no debilita la protección CSRF de la web:
// - CSRF existe porque el navegador adjunta la cookie de refresh de forma
//   automática. En modo móvil el controlador IGNORA la cookie y lee el token
//   solo del cuerpo, así que una petición forjada desde otro sitio no tiene
//   forma de aportar un token (no lo conoce) ni de aprovechar uno ambiental.
// - Una web que quisiera usar la cabecera `X-Client` desde otro origen
//   dispararía un preflight de CORS, que solo aprueba los orígenes de la
//   lista blanca (`env.corsAllowedOrigins`).
export const MOBILE_CLIENT_HEADER = 'x-client';
export const MOBILE_CLIENT_VALUE = 'mobile';

export function isMobileClient(req: Request): boolean {
  return req.get(MOBILE_CLIENT_HEADER)?.toLowerCase() === MOBILE_CLIENT_VALUE;
}

/** Igual que `requireTrustedOrigin` para el navegador, pero deja pasar al
 * cliente móvil (que no envía `Origin`). Ver la nota de arriba sobre CSRF. */
export function requireTrustedOriginUnlessMobile(req: Request, res: Response, next: NextFunction) {
  if (isMobileClient(req)) {
    next();
    return;
  }
  requireTrustedOrigin(req, res, next);
}

/** Aplica `schema` solo cuando la petición viene del cliente móvil (en el
 * navegador el token va en la cookie y no hay cuerpo que validar). */
export function validateWhenMobile(schema: ZodSchema) {
  const validator = validate(schema);
  return (req: Request, res: Response, next: NextFunction) => {
    if (isMobileClient(req)) {
      validator(req, res, next);
      return;
    }
    next();
  };
}

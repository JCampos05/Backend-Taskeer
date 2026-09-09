import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError } from '../errors/AppError';
import type { JwtAccessTokenPayload } from '../modules/auth/auth.types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: JwtAccessTokenPayload;
    }
  }
}

// Verifica el JWT de acceso (Authorization: Bearer <token>) y adjunta el
// payload a req.auth. Solo resuelve identidad — no resuelve permisos de
// workspace, eso lo hace cada service (ver .claude/agents/api-module-scaffolder.md).
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;

  if (!token) {
    return next(new AppError(401, 'UNAUTHENTICATED', 'Falta iniciar sesión.'));
  }

  try {
    req.auth = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] }) as JwtAccessTokenPayload;
    next();
  } catch {
    next(new AppError(401, 'UNAUTHENTICATED', 'La sesión no es válida o expiró.'));
  }
}

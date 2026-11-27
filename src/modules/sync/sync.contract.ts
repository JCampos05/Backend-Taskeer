import type { NextFunction, Request, Response } from 'express';
import { SYNC_CONTRACT_MAJOR, SYNC_CONTRACT_VERSION } from './sync.types';

// Negociación de versión del contrato de sync: el cliente manda en cada
// petición `X-Sync-Contract: MAJOR.MINOR` (la más alta que conoce) y el
// servidor contesta con la suya en la misma cabecera. Sin cabecera se asume
// 1.0. Una MAJOR que el servidor no soporta es 426.
const VERSION_RE = /^(\d{1,4})\.(\d{1,4})$/;

export function syncContract(req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Sync-Contract', SYNC_CONTRACT_VERSION);

  const raw = req.header('X-Sync-Contract');
  if (raw === undefined) return next();

  const match = VERSION_RE.exec(raw.trim());
  if (!match) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'La versión del contrato no es válida.' },
    });
  }
  if (Number(match[1]) !== SYNC_CONTRACT_MAJOR) {
    return res.status(426).json({
      error: {
        code: 'CONTRACT_VERSION_UNSUPPORTED',
        message:
          'Esta versión de la app ya no es compatible. Actualiza la app para seguir sincronizando.',
      },
      supportedMajors: [SYNC_CONTRACT_MAJOR],
    });
  }
  next();
}

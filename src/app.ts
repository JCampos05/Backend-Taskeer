import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { env } from './config/env';
import { errorHandler } from './middlewares/errorHandler';
import { authRouter } from './modules/auth/auth.routes';
import { boardsRouter } from './modules/boards/boards.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { preferencesRouter } from './modules/preferences/preferences.routes';
import { remindersRouter } from './modules/reminders/reminders.routes';
import { tasksRouter } from './modules/tasks/tasks.routes';
import { workspacesRouter } from './modules/workspaces/workspaces.routes';
import { catalogsRouter } from './routes/catalogs.routes';
import { healthRouter } from './routes/health.routes';

// Orden de middlewares en patrón gateway — ver docs/01-arquitectura.md,
// sección "La API como gateway (sin serlo literalmente)". No reordenar.
export const app = express();

// Detrás de un proxy real (Render) sin esto, `req.ip` no refleja la IP del
// cliente — debilita el rate limit agresivo de rutas como /auth/login y
// /auth/reset-password-with-code, y corrompe el `ipAddress` guardado en
// AuditLog. `1` confía solo en el primer hop (el proxy de Render), no en
// cualquiera.
app.set('trust proxy', 1);

app.use(helmet());

app.use(
  cors({
    origin: env.corsAllowedOrigins,
    credentials: true,
  }),
);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// El middleware de auth (verificación de JWT, `requireAuth.ts`) no se monta
// acá de forma global — se aplica por ruta, solo donde hace falta sesión
// activa (ej. POST /auth/recovery-codes/regenerate), no en toda la API.

const apiRouter = express.Router();
apiRouter.use(healthRouter);
apiRouter.use(catalogsRouter);
apiRouter.use(authRouter);
apiRouter.use(workspacesRouter);
apiRouter.use(boardsRouter);
apiRouter.use(tasksRouter);
apiRouter.use(remindersRouter);
apiRouter.use(notificationsRouter);
apiRouter.use(preferencesRouter);
// Un módulo nuevo de dominio nunca debe quedar huérfano sin montar aquí.

app.use('/api/v1', apiRouter);

app.use(errorHandler);

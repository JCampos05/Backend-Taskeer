import { createHash } from 'node:crypto';
import { Router } from 'express';
import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../../middlewares/requireAuth';
import {
  isMobileClient,
  requireTrustedOriginUnlessMobile,
  validateWhenMobile,
} from '../../middlewares/mobileClient';
import { validate } from '../../middlewares/validate';
import { authController } from './auth.controller';
import {
  changePasswordSchema,
  googleLoginSchema,
  googleMobileLoginSchema,
  loginSchema,
  mobileRefreshTokenSchema,
  regenerateRecoveryCodesSchema,
  registerSchema,
  resetPasswordWithCodeSchema,
  updateProfileSchema,
  verifyEmailSchema,
  verifyWithRecoveryCodeSchema,
} from './auth.schema';

export const authRouter = Router();

// En memoria por ahora; en producción con más de una instancia de API
// corriendo, este store debe pasar a `rate-limit-redis` (igual que el
// rate limit general del gateway) para que el contador sobreviva reinicios
// y sea consistente entre instancias.
//
// Cada endpoint sensible tiene su PROPIA instancia de rateLimit(), aunque
// varias compartan el mismo límite numérico — un solo `rateLimit()`
// reutilizado en varias rutas comparte un único contador por IP entre todas
// ellas (bug real encontrado probando: /auth/refresh se dispara solo en
// cada recarga de página vía bootstrap(), así que agotaba en minutos el
// mismo contador que protege /auth/login contra fuerza bruta, bloqueando
// login sin que el usuario hubiera fallado ni un intento real ahí).
function crearRateLimitAuth(limit: number, keyGenerator?: (req: Request) => string) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    ...(keyGenerator ? { keyGenerator } : {}),
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'Demasiados intentos. Intenta de nuevo más tarde.',
      },
    },
  });
}

// Sin esto, /auth/register permite enumerar correos registrados (409
// EMAIL_ALREADY_REGISTERED) sin fricción.
authRouter.post(
  '/auth/register',
  crearRateLimitAuth(10),
  validate(registerSchema),
  authController.register,
);
authRouter.get('/auth/verify-email', validate(verifyEmailSchema), authController.verifyEmail);
// Requiere sesión activa. Rate limit más generoso que el resto: es
// user-initiated pero no crítico como login/reset — el riesgo es solo spam
// hacia la propia bandeja del usuario, no fuerza bruta contra un secreto.
authRouter.post(
  '/auth/resend-verification',
  requireAuth,
  crearRateLimitAuth(20),
  authController.resendVerification,
);
// Con solo 10 códigos fijos por cuenta, sin esto alguien podría intentar
// adivinar la contraseña por fuerza bruta (ver docs/03-autenticacion-seguridad.md).
authRouter.post('/auth/login', crearRateLimitAuth(10), validate(loginSchema), authController.login);
// El Frontend solo navega acá (un <a>/window.location, no fetch) — arma la
// URL de autorización de Google con las credenciales de Supabase que solo
// vive el Backend y hace el redirect 302. Rate limit generoso: es
// user-initiated (un click), no hay contraseña ni token de por medio que
// proteger, mismo criterio que resend-verification.
authRouter.get('/auth/google/redirect', crearRateLimitAuth(30), authController.googleRedirect);
// La contraseña ya no es el factor de riesgo acá (la identidad la garantiza
// la firma del JWT de Supabase, verificada en el service) — el límite es más
// generoso que login, mismo criterio que resend-verification: el riesgo real
// es abuso del endpoint, no fuerza bruta contra un secreto.
authRouter.post(
  '/auth/google',
  crearRateLimitAuth(20),
  validate(googleLoginSchema),
  authController.googleLogin,
);
// Mucho más generoso que login: a diferencia de ese, este NO es
// user-initiated — se dispara solo en cada carga/recarga de la app
// (bootstrap()) y cada vez que el access token vence (~15min), así que un
// límite pensado para intentos de contraseña lo agota con uso normal. Ya
// exige un refresh token válido (cookie httpOnly) para hacer algo, así que
// el riesgo que este límite cubre es otro: frenar el replay rápido de un
// refresh token robado, no fuerza bruta de credenciales.
// `requireTrustedOrigin`: con la cookie en `sameSite: 'none'`, esta ruta no
// exige ningún body validado — sin este chequeo de `Origin`, CSRF real (ver
// docs/03-autenticacion-seguridad.md, sección de cookies cross-site).
// Cliente móvil (`X-Client: mobile`): sin cookies ni `Origin`; el refresh token
// viaja en el cuerpo y la cookie se ignora (ver middlewares/mobileClient.ts
// para por qué esto no debilita la protección CSRF de la web).
// Clave del límite de /auth/refresh (logout no tiene límite propio): en móvil, el hash del refresh token del
// cuerpo (así muchos móviles detrás de una misma IP —CGNAT, wifi compartida—
// no agotan un contador común, y se sigue frenando el replay rápido de UN
// token); en la web, la IP como siempre. El techo por IP del límite global de
// la API sigue aplicando. Nunca se usa el token en claro como clave.
function claveRefresh(req: Request): string {
  const token = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
  if (isMobileClient(req) && typeof token === 'string' && token.length > 0) {
    return `rt:${createHash('sha256').update(token.slice(0, 256)).digest('hex')}`;
  }
  return req.ip ?? 'unknown';
}

authRouter.post(
  '/auth/refresh',
  requireTrustedOriginUnlessMobile,
  crearRateLimitAuth(60, claveRefresh),
  validateWhenMobile(mobileRefreshTokenSchema),
  authController.refresh,
);
// Login con Google desde la app: recibe el access token de Supabase (sin el
// nonce `state` del flujo de navegador) y devuelve la sesión en JSON. Mismo
// límite que /auth/google.
authRouter.post(
  '/auth/google/mobile',
  crearRateLimitAuth(20),
  validate(googleMobileLoginSchema),
  authController.googleMobileLogin,
);
// Igual de agresivo que login — incluso más crítico: solo 10 códigos fijos
// por cuenta para adivinar (ver docs/03-autenticacion-seguridad.md).
authRouter.post(
  '/auth/reset-password-with-code',
  crearRateLimitAuth(10),
  validate(resetPasswordWithCodeSchema),
  authController.resetPasswordWithCode,
);
// Verifica la cuenta con uno de los códigos de recuperación propios (sin
// Resend no hay verificación por correo). Mismo límite agresivo que el reset:
// es un intento de adivinar el mismo secreto.
// Además del límite por IP, otro por usuario: rotar de IP desde una misma
// cuenta no reinicia el contador.
authRouter.post(
  '/auth/verify-with-recovery-code',
  requireAuth,
  crearRateLimitAuth(10),
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `user:${req.auth?.sub ?? 'anon'}`,
    message: {
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'Demasiados intentos. Intenta de nuevo más tarde.',
      },
    },
  }),
  validate(verifyWithRecoveryCodeSchema),
  authController.verifyWithRecoveryCode,
);
// Requiere sesión activa — nunca "en frío" (ver docs/03-autenticacion-seguridad.md).
// También lleva rate limit agresivo: aunque ya exige JWT válido, sin esto
// alguien con un access token robado podría forzar repetidos argon2.verify
// contra la contraseña real dentro de la ventana de vida del token (~15min).
authRouter.post(
  '/auth/recovery-codes/regenerate',
  requireAuth,
  crearRateLimitAuth(10),
  validate(regenerateRecoveryCodesSchema),
  authController.regenerateRecoveryCodes,
);
// Igual de agresivo que login/reset-password-with-code — exige la
// contraseña actual, pero sin este límite alguien con un access token
// robado podría forzar repetidos argon2.verify dentro de la ventana de vida
// del token (~15min), mismo riesgo ya documentado en
// recovery-codes/regenerate.
authRouter.post(
  '/auth/change-password',
  requireAuth,
  crearRateLimitAuth(10),
  validate(changePasswordSchema),
  authController.changePassword,
);
// Perfil del usuario autenticado — vive acá porque toca User directamente,
// la misma entidad que ya maneja este módulo (no amerita un módulo aparte
// por un solo campo editable).
authRouter.patch(
  '/me/profile',
  requireAuth,
  validate(updateProfileSchema),
  authController.updateProfile,
);

authRouter.post(
  '/auth/logout',
  requireTrustedOriginUnlessMobile,
  validateWhenMobile(mobileRefreshTokenSchema),
  authController.logout,
);

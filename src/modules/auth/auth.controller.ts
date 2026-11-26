import { randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env';
import { AppError } from '../../errors/AppError';
import { isMobileClient } from '../../middlewares/mobileClient';
import { authService } from './auth.service';
import type { LoginServiceResult, MobileSessionDto } from './auth.types';
import type {
  ChangePasswordInput,
  GoogleLoginInput,
  GoogleMobileLoginInput,
  LoginInput,
  MobileRefreshTokenInput,
  RegenerateRecoveryCodesInput,
  RegisterInput,
  ResetPasswordWithCodeInput,
  UpdateProfileInput,
  VerifyEmailInput,
  VerifyWithRecoveryCodeInput,
} from './auth.schema';

// El controller nunca llama a Prisma directamente ni contiene lógica de
// negocio — solo adapta req/res y delega todo a auth.service.

// `sameSite: 'none'` (requiere `secure: true`, ya presente): Frontend y
// Backend viven en dominios distintos en producción (Vercel/Render), así
// que toda llamada del Frontend (`withCredentials: true`, XHR, nunca
// navegación de nivel superior) es cross-site desde la perspectiva del
// navegador — `strict`/`lax` nunca viajarían en esa llamada. Antes de este
// cambio esto pasaba desapercibido solo porque Frontend y Backend se
// probaban ambos en `localhost` (mismo sitio pese al puerto distinto).
const REFRESH_TOKEN_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'none' as const,
  path: '/api/v1/auth',
};

// Nonce anti-CSRF del login con Google (protege contra "login CSRF"/session
// swapping: sin esto, un atacante podría completar su propio flujo de
// Google, capturar la URL con SU access_token, y engañar a la víctima para
// que la abra — el navegador de la víctima terminaría autenticado como el
// atacante sin notarlo). Mismo motivo que la cookie de refresh arriba:
// `sameSite: 'none'` porque el `POST /auth/google` que la valida es una
// llamada cross-site del Frontend, no una navegación de nivel superior.
const OAUTH_STATE_COOKIE_NAME = 'taskeer_oauth_state';
const OAUTH_STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'none' as const,
  path: '/api/v1/auth',
  maxAge: 10 * 60 * 1000, // 10 minutos — tiempo generoso para completar el login en Google
};

/** Una respuesta con refresh token en el cuerpo nunca debe quedar en una caché
 * (navegador, proxy o CDN intermedios). */
function noStore(res: Response) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
}

/** Responde con la sesión recién emitida. Web: refresh token en cookie httpOnly
 * y fuera del JSON. Móvil (`X-Client: mobile`): sin cookie, el refresh token y
 * su vencimiento viajan en el JSON. `extra` añade campos (p. ej. los códigos de
 * recuperación del primer login con Google). */
function sendSession(
  req: Request,
  res: Response,
  result: LoginServiceResult,
  extra: Record<string, unknown> = {},
) {
  if (isMobileClient(req)) {
    const body: MobileSessionDto & Record<string, unknown> = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
      user: result.user,
      ...extra,
    };
    noStore(res);
    res.status(200).json(body);
    return;
  }

  res.cookie(env.refreshTokenCookieName, result.refreshToken, {
    ...REFRESH_TOKEN_COOKIE_OPTIONS,
    expires: result.refreshTokenExpiresAt,
  });
  res.status(200).json({ accessToken: result.accessToken, user: result.user, ...extra });
}

/** Refresh token de la petición: en móvil SOLO del cuerpo (la cookie se
 * ignora a propósito, ver middlewares/mobileClient.ts); en la web, de la cookie. */
function readRefreshToken(req: Request): string | undefined {
  if (isMobileClient(req)) {
    return (req.body as MobileRefreshTokenInput | undefined)?.refreshToken;
  }
  return req.cookies?.[env.refreshTokenCookieName] as string | undefined;
}

async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const input = req.body as RegisterInput;
    const result = await authService.register(input);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

async function resendVerification(req: Request, res: Response, next: NextFunction) {
  try {
    // req.auth ya viene resuelto por el middleware requireAuth montado en la ruta.
    const result = await authService.resendVerificationEmail(req.auth!.sub);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function verifyEmail(req: Request, res: Response, next: NextFunction) {
  try {
    const input = req.query as unknown as VerifyEmailInput;
    await authService.verifyEmail(input);
    res.status(200).json({ verified: true });
  } catch (err) {
    next(err);
  }
}

async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const input = req.body as LoginInput;
    const result = await authService.login(input, {
      userAgent: req.get('user-agent') ?? undefined,
      ipAddress: req.ip,
    });

    sendSession(req, res, result);
  } catch (err) {
    next(err);
  }
}

// Sin try/catch: no hay nada async ni que pueda fallar acá, solo arma una
// URL a partir de config ya validada al arrancar el proceso (env.ts).
function googleRedirect(_req: Request, res: Response) {
  const state = randomBytes(32).toString('hex');
  res.cookie(OAUTH_STATE_COOKIE_NAME, state, OAUTH_STATE_COOKIE_OPTIONS);
  res.redirect(authService.buildGoogleAuthorizeUrl(state));
}

async function googleLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const input = req.body as GoogleLoginInput;

    // De un solo uso: se borra exista o no, coincida o no — nunca se puede
    // reintentar contra la misma cookie dos veces.
    const expectedState = req.cookies?.[OAUTH_STATE_COOKIE_NAME] as string | undefined;
    res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: OAUTH_STATE_COOKIE_OPTIONS.path });

    if (!expectedState || expectedState !== input.state) {
      throw new AppError(
        400,
        'INVALID_OAUTH_STATE',
        'La sesión de Google no es válida o venció. Intenta de nuevo.',
      );
    }

    const result = await authService.loginWithGoogle(input, {
      userAgent: req.get('user-agent') ?? undefined,
      ipAddress: req.ip,
    });

    // recoveryCodes solo viene presente si este login creó una cuenta nueva
    // (ver auth.service.ts::loginWithGoogle) — JSON.stringify omite la clave
    // por completo cuando es undefined, así que un login normal no la trae.
    sendSession(req, res, result, { recoveryCodes: result.recoveryCodes });
  } catch (err) {
    next(err);
  }
}

// Login con Google desde la app Android. Sin cookie de estado (ese nonce
// protege el flujo de navegador): la app manda el access token de Supabase y
// recibe la sesión en JSON. La verificación del token es exactamente la misma
// que la del flujo web (firma por JWKS + email_verified vía la API de Supabase).
async function googleMobileLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const input = req.body as GoogleMobileLoginInput;
    const result = await authService.loginWithGoogle(input, {
      userAgent: req.get('user-agent') ?? undefined,
      ipAddress: req.ip,
    });

    // Siempre en modo móvil (sin cookie), aunque falte la cabecera X-Client:
    // este endpoint no tiene flujo de navegador.
    const body: MobileSessionDto & { recoveryCodes?: string[] } = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
      user: result.user,
      recoveryCodes: result.recoveryCodes,
    };
    noStore(res);
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.refreshAccessToken(readRefreshToken(req), {
      userAgent: req.get('user-agent') ?? undefined,
      ipAddress: req.ip,
    });

    sendSession(req, res, result);
  } catch (err) {
    next(err);
  }
}

async function resetPasswordWithCode(req: Request, res: Response, next: NextFunction) {
  try {
    const input = req.body as ResetPasswordWithCodeInput;
    await authService.resetPasswordWithCode(input, { ipAddress: req.ip });
    res.status(200).json({ reset: true });
  } catch (err) {
    next(err);
  }
}

async function verifyWithRecoveryCode(req: Request, res: Response, next: NextFunction) {
  try {
    const input = req.body as VerifyWithRecoveryCodeInput;
    const user = await authService.verifyWithRecoveryCode(req.auth!.sub, input, {
      ipAddress: req.ip,
    });
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}

async function regenerateRecoveryCodes(req: Request, res: Response, next: NextFunction) {
  try {
    const input = req.body as RegenerateRecoveryCodesInput;
    // req.auth ya viene resuelto por el middleware requireAuth montado en la ruta.
    const result = await authService.regenerateRecoveryCodes(req.auth!.sub, input);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function changePassword(req: Request, res: Response, next: NextFunction) {
  try {
    const input = req.body as ChangePasswordInput;
    // req.auth ya viene resuelto por el middleware requireAuth montado en la ruta.
    const result = await authService.changePassword(req.auth!.sub, input, {
      userAgent: req.get('user-agent') ?? undefined,
      ipAddress: req.ip,
    });

    sendSession(req, res, result);
  } catch (err) {
    next(err);
  }
}

async function updateProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const input = req.body as UpdateProfileInput;
    // req.auth ya viene resuelto por el middleware requireAuth montado en la ruta.
    const user = await authService.updateProfile(req.auth!.sub, input);
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}

async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.logout(readRefreshToken(req), { ipAddress: req.ip });
    // En móvil no hay cookie que limpiar.
    if (!isMobileClient(req)) {
      res.clearCookie(env.refreshTokenCookieName, REFRESH_TOKEN_COOKIE_OPTIONS);
    }
    res.status(200).json({ loggedOut: true });
  } catch (err) {
    next(err);
  }
}

export const authController = {
  register,
  resendVerification,
  verifyEmail,
  login,
  googleRedirect,
  googleLogin,
  googleMobileLogin,
  refresh,
  resetPasswordWithCode,
  verifyWithRecoveryCode,
  regenerateRecoveryCodes,
  changePassword,
  updateProfile,
  logout,
};

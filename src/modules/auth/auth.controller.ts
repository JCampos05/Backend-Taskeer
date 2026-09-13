import { randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env';
import { AppError } from '../../errors/AppError';
import { authService } from './auth.service';
import type {
  ChangePasswordInput,
  GoogleLoginInput,
  LoginInput,
  RegenerateRecoveryCodesInput,
  RegisterInput,
  ResetPasswordWithCodeInput,
  UpdateProfileInput,
  VerifyEmailInput,
} from './auth.schema';

// El controller nunca llama a Prisma directamente ni contiene lógica de
// negocio — solo adapta req/res y delega todo a auth.service.

const REFRESH_TOKEN_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict' as const,
  path: '/api/v1/auth',
};

// Nonce anti-CSRF del login con Google (protege contra "login CSRF"/session
// swapping: sin esto, un atacante podría completar su propio flujo de
// Google, capturar la URL con SU access_token, y engañar a la víctima para
// que la abra — el navegador de la víctima terminaría autenticado como el
// atacante sin notarlo). `sameSite: 'lax'` a propósito, a diferencia del
// refresh token (`strict`): esta cookie tiene que sobrevivir la navegación
// de nivel superior de VUELTA desde Supabase/Google, que sí cuenta como
// "cross-site" en el momento exacto en que el navegador aterriza de nuevo
// en este dominio.
const OAUTH_STATE_COOKIE_NAME = 'taskeer_oauth_state';
const OAUTH_STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/api/v1/auth',
  maxAge: 10 * 60 * 1000, // 10 minutos — tiempo generoso para completar el login en Google
};

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

    res.cookie(env.refreshTokenCookieName, result.refreshToken, {
      ...REFRESH_TOKEN_COOKIE_OPTIONS,
      expires: result.refreshTokenExpiresAt,
    });

    res.status(200).json({ accessToken: result.accessToken, user: result.user });
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

    res.cookie(env.refreshTokenCookieName, result.refreshToken, {
      ...REFRESH_TOKEN_COOKIE_OPTIONS,
      expires: result.refreshTokenExpiresAt,
    });

    // recoveryCodes solo viene presente si este login creó una cuenta nueva
    // (ver auth.service.ts::loginWithGoogle) — JSON.stringify omite la clave
    // por completo cuando es undefined, así que un login normal no la trae.
    res.status(200).json({
      accessToken: result.accessToken,
      user: result.user,
      recoveryCodes: result.recoveryCodes,
    });
  } catch (err) {
    next(err);
  }
}

async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const refreshToken = req.cookies?.[env.refreshTokenCookieName] as string | undefined;
    const result = await authService.refreshAccessToken(refreshToken, {
      userAgent: req.get('user-agent') ?? undefined,
      ipAddress: req.ip,
    });

    res.cookie(env.refreshTokenCookieName, result.refreshToken, {
      ...REFRESH_TOKEN_COOKIE_OPTIONS,
      expires: result.refreshTokenExpiresAt,
    });

    res.status(200).json({ accessToken: result.accessToken, user: result.user });
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

    res.cookie(env.refreshTokenCookieName, result.refreshToken, {
      ...REFRESH_TOKEN_COOKIE_OPTIONS,
      expires: result.refreshTokenExpiresAt,
    });

    res.status(200).json({ accessToken: result.accessToken, user: result.user });
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
    const refreshToken = req.cookies?.[env.refreshTokenCookieName] as string | undefined;
    await authService.logout(refreshToken);
    res.clearCookie(env.refreshTokenCookieName, REFRESH_TOKEN_COOKIE_OPTIONS);
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
  refresh,
  resetPasswordWithCode,
  regenerateRecoveryCodes,
  changePassword,
  updateProfile,
  logout,
};

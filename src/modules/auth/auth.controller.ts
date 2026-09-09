import type { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env';
import { authService } from './auth.service';
import type {
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
  refresh,
  resetPasswordWithCode,
  regenerateRecoveryCodes,
  updateProfile,
  logout,
};

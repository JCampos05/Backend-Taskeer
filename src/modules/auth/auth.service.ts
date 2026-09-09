import { randomBytes, randomInt, createHash } from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { prisma } from '../../config/prisma';
import { env } from '../../config/env';
import { AppError } from '../../errors/AppError';
import { mailService } from '../../services/mail/mail.service';
import { pushNotification } from '../notifications/notifications.stream';
import type {
  LoginInput,
  RegenerateRecoveryCodesInput,
  RegisterInput,
  ResetPasswordWithCodeInput,
  UpdateProfileInput,
  VerifyEmailInput,
} from './auth.schema';
import type {
  JwtAccessTokenPayload,
  LoginServiceResult,
  PublicUserDto,
  RecoveryCodesDto,
  RefreshServiceResult,
  RegisterResultDto,
  ResendVerificationResultDto,
} from './auth.types';

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

// Sin 0/O, 1/I/L — evita ambigüedad al transcribir un código a mano.
const RECOVERY_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const RECOVERY_CODE_COUNT = 10;

function toPublicUser(user: {
  id: string;
  email: string;
  displayName: string;
  emailVerifiedAt: Date | null;
}): PublicUserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerifiedAt: user.emailVerifiedAt ? user.emailVerifiedAt.toISOString() : null,
  };
}

/** Genera un token aleatorio de al menos 32 bytes y su hash SHA-256. Solo el
 * hash se persiste (AuthToken.tokenHash / RefreshToken.tokenHash) — el token
 * en texto plano es lo que se entrega una única vez (por correo, o en la
 * respuesta/cookie), nunca se puede recuperar después. */
function generateOpaqueToken(): { plain: string; hash: string } {
  const plain = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(plain).digest('hex');
  return { plain, hash };
}

/** Genera un set nuevo de 10 códigos de recuperación (formato XXXX-XXXX) con
 * su hash SHA-256. Igual que generateOpaqueToken: solo el hash se persiste,
 * el texto plano se muestra una única vez y no se puede recuperar después. */
function generateRecoveryCodeSet(): { plain: string; hash: string }[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const chars = Array.from(
      { length: 8 },
      () => RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)],
    );
    const plain = `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
    const hash = createHash('sha256').update(plain).digest('hex');
    return { plain, hash };
  });
}

// Hash argon2id "señuelo", calculado una sola vez y cacheado. Se usa para
// verificar contra él cuando el email no existe en /auth/login, así el
// costo de CPU de un intento con email inexistente es equivalente al de uno
// con email existente — evita distinguir ambos casos por timing.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2.hash(randomBytes(32).toString('hex'), { type: argon2.argon2id });
  }
  return dummyHashPromise;
}

async function register(input: RegisterInput): Promise<RegisterResultDto> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'Ese correo ya está registrado.');
  }

  const freePlan = await prisma.plan.findUnique({ where: { code: 'FREE' } });
  if (!freePlan) {
    // No debería pasar si el seed corrió correctamente — ver prisma/seed.ts.
    throw new AppError(
      500,
      'FREE_PLAN_NOT_SEEDED',
      'No se pudo completar el registro. Intenta más tarde.',
    );
  }

  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  const verification = generateOpaqueToken();
  const recoveryCodes = generateRecoveryCodeSet();

  let user;
  try {
    user = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          displayName: input.displayName,
        },
      });

      await tx.authToken.create({
        data: {
          userId: createdUser.id,
          type: 'EMAIL_VERIFICATION',
          tokenHash: verification.hash,
          expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
        },
      });

      await tx.subscription.create({
        data: {
          userId: createdUser.id,
          planId: freePlan.id,
        },
      });

      await tx.recoveryCode.createMany({
        data: recoveryCodes.map((rc) => ({ userId: createdUser.id, codeHash: rc.hash })),
      });

      return createdUser;
    });
  } catch (err) {
    // Carrera entre el `findUnique` de arriba y este `create`: dos registros
    // concurrentes con el mismo correo pueden pasar ambos el chequeo previo.
    // Prisma reporta la violación del `@unique` en `email` como P2002.
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'P2002'
    ) {
      throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'Ese correo ya está registrado.');
    }
    throw err;
  }

  // No await: el envío de correo nunca debe bloquear ni poder tumbar el
  // registro (mail.service ya absorbe sus propios errores). En desarrollo
  // además devolvemos el token en la respuesta para poder probar el flujo
  // sin depender de que el correo realmente llegue (ej. sin RESEND_API_KEY
  // configurado todavía). Allowlist explícita (`=== 'development'`) para
  // fallar cerrado por defecto en cualquier otro entorno.
  void mailService.sendVerificationEmail(user.email, verification.plain);

  const plainRecoveryCodes = recoveryCodes.map((rc) => rc.plain);

  if (env.nodeEnv === 'development') {
    return {
      user: toPublicUser(user),
      emailVerificationToken: verification.plain,
      recoveryCodes: plainRecoveryCodes,
    };
  }

  return { user: toPublicUser(user), recoveryCodes: plainRecoveryCodes };
}

/** Reenvía el correo de verificación con un token nuevo — necesario porque
 * el flujo original (mostrado solo en la respuesta de /auth/register en
 * desarrollo, o por correo real) no tiene forma de recuperarse si el correo
 * nunca llegó (ej. Resend con dominio de pruebas, que solo entrega a una
 * dirección fija — ver docs/01-arquitectura.md) o si el usuario perdió el
 * enlace. Requiere sesión activa — nunca "en frío", igual que
 * recovery-codes/regenerate. */
async function resendVerificationEmail(userId: string): Promise<ResendVerificationResultDto> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'La sesión no es válida.');
  }

  if (user.emailVerifiedAt) {
    return { alreadyVerified: true };
  }

  const verification = generateOpaqueToken();

  await prisma.$transaction([
    // Invalida cualquier token de verificación pendiente anterior — solo el
    // enlace más reciente debe funcionar, mismo criterio que
    // regenerateRecoveryCodes con los códigos viejos.
    prisma.authToken.updateMany({
      where: { userId: user.id, type: 'EMAIL_VERIFICATION', usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.authToken.create({
      data: {
        userId: user.id,
        type: 'EMAIL_VERIFICATION',
        tokenHash: verification.hash,
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
      },
    }),
  ]);

  void mailService.sendVerificationEmail(user.email, verification.plain);

  if (env.nodeEnv === 'development') {
    return { alreadyVerified: false, emailVerificationToken: verification.plain };
  }

  return { alreadyVerified: false };
}

async function verifyEmail(input: VerifyEmailInput): Promise<void> {
  const tokenHash = createHash('sha256').update(input.token).digest('hex');

  const authToken = await prisma.authToken.findUnique({ where: { tokenHash } });

  if (
    !authToken ||
    authToken.type !== 'EMAIL_VERIFICATION' ||
    authToken.usedAt ||
    authToken.expiresAt < new Date()
  ) {
    throw new AppError(
      400,
      'INVALID_OR_EXPIRED_TOKEN',
      'El enlace de verificación no es válido o venció.',
    );
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: authToken.userId },
      data: { emailVerifiedAt: new Date() },
    }),
    prisma.authToken.update({
      where: { id: authToken.id },
      data: { usedAt: new Date() },
    }),
    prisma.auditLog.create({
      data: { userId: authToken.userId, action: 'auth.email_verified' },
    }),
  ]);
}

/** Emite un JWT de acceso nuevo y un RefreshToken nuevo para `user`, y
 * registra `auditAction` en AuditLog dentro de la misma transacción. Usado
 * tanto por login (sesión nueva) como por refresh (rotación de sesión). */
async function issueSession(
  user: { id: string; email: string; displayName: string; emailVerifiedAt: Date | null },
  context: { userAgent?: string; ipAddress?: string },
  auditAction: string,
): Promise<LoginServiceResult> {
  const payload: JwtAccessTokenPayload = { sub: user.id, email: user.email };
  const accessToken = jwt.sign(payload, env.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: env.jwtAccessTokenTtl,
  } as jwt.SignOptions);

  const refreshToken = generateOpaqueToken();
  const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await prisma.$transaction([
    prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: refreshToken.hash,
        userAgent: context.userAgent,
        ipAddress: context.ipAddress,
        expiresAt: refreshTokenExpiresAt,
      },
    }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: auditAction,
        ipAddress: context.ipAddress,
      },
    }),
  ]);

  return {
    accessToken,
    user: toPublicUser(user),
    refreshToken: refreshToken.plain,
    refreshTokenExpiresAt,
  };
}

async function login(
  input: LoginInput,
  context: { userAgent?: string; ipAddress?: string },
): Promise<LoginServiceResult> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  const invalidCredentialsError = new AppError(
    401,
    'INVALID_CREDENTIALS',
    'Correo o contraseña incorrectos.',
  );

  // Si el usuario no existe, igual se verifica contra un hash señuelo — así
  // el costo de CPU (y por lo tanto el tiempo de respuesta) es equivalente
  // al de un intento con email existente, y no se puede enumerar cuentas
  // registradas por timing.
  const passwordMatches = await argon2.verify(
    user ? user.passwordHash : await getDummyHash(),
    input.password,
  );

  if (!user || !passwordMatches) {
    if (user) {
      await prisma.auditLog.create({
        data: {
          userId: user.id,
          action: 'auth.login_failed',
          ipAddress: context.ipAddress,
        },
      });
    }
    throw invalidCredentialsError;
  }

  return issueSession(user, context, 'auth.login');
}

async function refreshAccessToken(
  refreshTokenPlain: string | undefined,
  context: { userAgent?: string; ipAddress?: string },
): Promise<RefreshServiceResult> {
  const invalidRefreshError = new AppError(
    401,
    'INVALID_REFRESH_TOKEN',
    'La sesión expiró. Vuelve a iniciar sesión.',
  );

  if (!refreshTokenPlain) {
    throw invalidRefreshError;
  }

  const tokenHash = createHash('sha256').update(refreshTokenPlain).digest('hex');
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!existing || existing.expiresAt < new Date()) {
    throw invalidRefreshError;
  }

  if (existing.revokedAt) {
    // El token ya estaba revocado ANTES de este intento — no es la carrera
    // de abajo, es alguien reutilizando un refresh token que ya fue rotado
    // (señal de robo: el dueño legítimo ya lo usó una vez). Se revocan
    // todas las sesiones activas del usuario, igual que en un reset de
    // contraseña, y se registra el evento.
    await prisma.$transaction([
      prisma.refreshToken.updateMany({
        where: { userId: existing.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      prisma.auditLog.create({
        data: {
          userId: existing.userId,
          action: 'auth.refresh_token_reuse_detected',
          ipAddress: context.ipAddress,
        },
      }),
    ]);
    throw invalidRefreshError;
  }

  // Revocación atómica y condicionada (`revokedAt: null` en el where): si
  // dos requests concurrentes llegan con el mismo refresh token (ej. un
  // atacante corriendo en paralelo con el uso legítimo), solo una gana la
  // carrera (`count === 1`) y emite sesión nueva — la otra ve `count === 0`
  // y falla, en vez de que ambas pasen un `findUnique` previo y las dos
  // terminen emitiendo sesión a partir del mismo token.
  const { count } = await prisma.refreshToken.updateMany({
    where: { id: existing.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (count === 0) {
    throw invalidRefreshError;
  }

  return issueSession(existing.user, context, 'auth.token_refreshed');
}

async function resetPasswordWithCode(
  input: ResetPasswordWithCodeInput,
  context: { ipAddress?: string },
): Promise<void> {
  // Regla no negociable heredada del diseño anterior (correo): la respuesta
  // ante identificador inexistente o código inválido debe ser indistinguible
  // — nunca revelar cuál de los dos falló (docs/03-autenticacion-seguridad.md).
  const invalidError = new AppError(
    400,
    'INVALID_RECOVERY_CODE',
    'El correo o el código de recuperación no son válidos.',
  );

  const codeHash = createHash('sha256').update(input.code).digest('hex');
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  // Mismo trabajo (un lookup por codeHash) exista o no el usuario, para no
  // filtrar por timing cuál de los dos casos ocurrió.
  const recoveryCode = await prisma.recoveryCode.findUnique({ where: { codeHash } });

  if (!user || !recoveryCode || recoveryCode.userId !== user.id || recoveryCode.usedAt) {
    throw invalidError;
  }

  const newPasswordHash = await argon2.hash(input.newPassword, { type: argon2.argon2id });

  const notification = await prisma.$transaction(async (tx) => {
    // updateMany condicionado (`usedAt: null` en el where) en vez de update
    // por id: si el código se borró o se marcó usado entre el findUnique de
    // arriba y este punto (ej. una regeneración concurrente, o el mismo
    // código usado dos veces a la vez), `count` da 0 y se aborta con el
    // mismo error uniforme — nunca un 500 por un update sobre una fila que
    // ya no está en el estado esperado.
    const { count } = await tx.recoveryCode.updateMany({
      where: { id: recoveryCode.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    if (count === 0) {
      throw invalidError;
    }

    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash: newPasswordHash },
    });

    // Reset de contraseña revoca todas las sesiones activas — regla no
    // negociable (docs/03-autenticacion-seguridad.md).
    await tx.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: 'auth.password_reset_with_code',
        ipAddress: context.ipAddress,
      },
    });

    // Aviso al dueño de la cuenta de que se consumió un código.
    return tx.notification.create({
      data: {
        userId: user.id,
        type: 'RECOVERY_CODE_USED',
        title: 'Se usó un código de recuperación',
        body: 'Tu contraseña se restableció con uno de tus códigos de recuperación. Si no fuiste tú, revisa la seguridad de tu cuenta.',
      },
    });
  });

  // Fuera de la transacción a propósito: si el push en vivo fallara, no
  // debe revertir el reset de contraseña ya confirmado. La fila en
  // Notification (fuente de verdad) ya quedó escrita pase lo que pase acá.
  pushNotification(notification);
}

async function regenerateRecoveryCodes(
  userId: string,
  input: RegenerateRecoveryCodesInput,
): Promise<RecoveryCodesDto> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'La sesión no es válida.');
  }

  const passwordMatches = await argon2.verify(user.passwordHash, input.currentPassword);
  if (!passwordMatches) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Contraseña incorrecta.');
  }

  const recoveryCodes = generateRecoveryCodeSet();

  // Regenerar exige sesión activa + contraseña confirmada (ya verificado
  // arriba) — nunca "en frío". Los códigos viejos, usados o no, se borran de
  // golpe: si la fila no existe, ya no sirve, y el rastro de auditoría de
  // cuáles se llegaron a usar ya quedó en AuditLog al consumirse cada uno.
  await prisma.$transaction([
    prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
    prisma.recoveryCode.createMany({
      data: recoveryCodes.map((rc) => ({ userId: user.id, codeHash: rc.hash })),
    }),
    prisma.auditLog.create({
      data: { userId: user.id, action: 'recovery_codes.regenerated' },
    }),
  ]);

  return { recoveryCodes: recoveryCodes.map((rc) => rc.plain) };
}

async function logout(refreshTokenPlain: string | undefined): Promise<void> {
  if (!refreshTokenPlain) {
    return;
  }

  const tokenHash = createHash('sha256').update(refreshTokenPlain).digest('hex');
  const refreshToken = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!refreshToken || refreshToken.revokedAt) {
    return;
  }

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: refreshToken.id },
      data: { revokedAt: new Date() },
    }),
    prisma.auditLog.create({
      data: { userId: refreshToken.userId, action: 'auth.logout' },
    }),
  ]);
}

async function updateProfile(userId: string, input: UpdateProfileInput): Promise<PublicUserDto> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { displayName: input.displayName },
  });

  return toPublicUser(user);
}

export const authService = {
  register,
  resendVerificationEmail,
  verifyEmail,
  login,
  refreshAccessToken,
  resetPasswordWithCode,
  regenerateRecoveryCodes,
  updateProfile,
  logout,
};

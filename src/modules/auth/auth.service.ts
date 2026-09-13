import { randomBytes, randomInt, createHash } from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { prisma } from '../../config/prisma';
import { env } from '../../config/env';
import { AppError } from '../../errors/AppError';
import { mailService } from '../../services/mail/mail.service';
import { pushNotification } from '../notifications/notifications.stream';
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
import type {
  GoogleLoginServiceResult,
  JwtAccessTokenPayload,
  LoginServiceResult,
  PublicUserDto,
  RecoveryCodesDto,
  RefreshServiceResult,
  RegisterResultDto,
  ResendVerificationResultDto,
  SupabaseAccessTokenPayload,
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
  passwordHash: string | null;
}): PublicUserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerifiedAt: user.emailVerifiedAt ? user.emailVerifiedAt.toISOString() : null,
    hasPassword: user.passwordHash !== null,
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
  user: {
    id: string;
    email: string;
    displayName: string;
    emailVerifiedAt: Date | null;
    passwordHash: string | null;
  },
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

  // Si el usuario no existe, o existe pero solo tiene una cuenta de Google
  // vinculada (passwordHash null — nunca inició sesión local), se verifica
  // igual contra un hash señuelo en vez de comparar contra un hash vacío:
  // mismo costo de CPU en los tres casos, así que ninguno se puede distinguir
  // del resto por timing (docs/03-autenticacion-seguridad.md, "Inicio de
  // sesión con Google").
  const passwordMatches = await argon2.verify(
    user?.passwordHash ?? (await getDummyHash()),
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

/** Arma la URL de autorización de Google de Supabase y la devuelve para que
 * el controller haga un redirect 302 del navegador — el Frontend nunca
 * necesita las credenciales de Supabase ni la librería @supabase/supabase-js,
 * solo navega a `GET /auth/google/redirect`. Sin `code_challenge` (PKCE),
 * GoTrue responde con el flujo implícito: el access token vuelve directo en
 * el fragmento de la URL de `redirect_to` (`#access_token=...`), no como un
 * código a intercambiar — ver "Inicio de sesión con Google" en
 * docs/03-autenticacion-seguridad.md para el detalle completo y el tradeoff
 * aceptado. */
function buildGoogleAuthorizeUrl(state: string): string {
  // El nonce anti-CSRF viaja como query param DENTRO de `redirect_to`, no
  // como un `state` de nivel superior hacia Supabase — Supabase preserva la
  // query string de `redirect_to` tal cual y solo le agrega el fragmento
  // (`#access_token=...`) al volver, así que esto sobrevive el viaje
  // completo sin depender de que Supabase reenvíe un `state` propio de
  // forma documentada para este flujo específico.
  const redirectTo = `${env.publicWebUrl}/auth/callback?state=${encodeURIComponent(state)}`;
  const params = new URLSearchParams({
    provider: 'google',
    redirect_to: redirectTo,
    // Kong (el gateway delante de GoTrue) exige la key en cada request a
    // /auth/v1/*, incluida esta — como es un redirect de navegador y no un
    // fetch, la única forma de mandarla es en la query string. No es un
    // secreto (ver docs/03-autenticacion-seguridad.md): queda visible en la
    // URL de todos modos durante la navegación, esté donde esté construida.
    apikey: env.supabaseAnonKey,
  });
  return `${env.supabaseUrl}/auth/v1/authorize?${params.toString()}`;
}

// Claves públicas vigentes del proyecto de Supabase (Auth > JWT Signing
// Keys) — `createRemoteJWKSet` las cachea en memoria y las refresca sola
// cuando aparece un `kid` que no conoce, así que sobrevive una rotación de
// clave sin reiniciar el servidor. Creado una sola vez a nivel de módulo,
// no en cada request.
const supabaseJwks = createRemoteJWKSet(new URL(`${env.supabaseUrl}/auth/v1/.well-known/jwks.json`));

/** Verifica la firma del JWT que Supabase Auth le entrega al frontend tras
 * el login con Google — nunca se confía en el `sub`/`email` que el cliente
 * diga tener sin validar esto primero (docs/03-autenticacion-seguridad.md,
 * "Inicio de sesión con Google"). `audience: 'authenticated'` es el valor
 * fijo que Supabase pone en todo JWT de sesión de un usuario autenticado.
 *
 * Se verifica contra el JWKS de Supabase (clave pública), no contra un
 * secreto compartido: el proyecto rotó su signing key de HS256 legacy a una
 * ECC (P-256) sin avisar (comportamiento normal de Supabase, no un
 * incidente), así que un secreto fijo en `.env` queda obsoleto ante
 * cualquier rotación futura — el JWKS siempre resuelve la clave vigente.
 * `algorithms` se restringe explícitamente a los dos algoritmos asimétricos
 * que Supabase usa para signing keys, nunca a HS256 — aceptar HS256 acá
 * abriría una vía de forjar tokens usando la clave pública como si fuera un
 * secreto compartido (confusión de algoritmo). */
async function verifySupabaseAccessToken(token: string): Promise<SupabaseAccessTokenPayload> {
  try {
    const { payload } = await jwtVerify(token, supabaseJwks, {
      algorithms: ['ES256', 'RS256'],
      audience: 'authenticated',
      issuer: `${env.supabaseUrl}/auth/v1`,
    });
    return payload as unknown as SupabaseAccessTokenPayload;
  } catch {
    throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'La sesión de Google no es válida o venció.');
  }
}

// Forma mínima de la respuesta de GET /auth/v1/user que a Taskeer le
// importa — solo el array `identities`, nunca cacheado.
interface SupabaseUserResponse {
  identities?: Array<{ provider?: string; identity_data?: { email_verified?: boolean } }>;
}

/** Resuelve si Google reportó el correo como verificado, leyendo
 * `identities[].identity_data.email_verified` desde la propia API de
 * Supabase (GoTrue) en vez de confiar en `user_metadata` del JWT.
 * `user_metadata` es editable por el usuario autenticado (ej. llamando a
 * `PUT /auth/v1/user` con su propio access token + la anon key, que ya es
 * pública) — un atacante podría escribir `user_metadata.email_verified =
 * true` sin que Google haya verificado nada. `identity_data`, en cambio, es
 * un espejo de lo que el proveedor OAuth entregó en el último login y no se
 * actualiza a través de `updateUser`, así que es la fuente confiable para
 * esta decisión de seguridad. */
async function fetchGoogleEmailVerified(supabaseAccessToken: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${supabaseAccessToken}`,
        apikey: env.supabaseAnonKey,
      },
    });
  } catch {
    throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'La sesión de Google no es válida o venció.');
  }

  if (!response.ok) {
    throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'La sesión de Google no es válida o venció.');
  }

  const data = (await response.json()) as SupabaseUserResponse;
  const googleIdentity = data.identities?.find((identity) => identity.provider === 'google');
  return Boolean(googleIdentity?.identity_data?.email_verified);
}

/** Login/registro con Google vía Supabase Auth. Supabase nunca es la fuente
 * de verdad de un usuario de Taskeer — solo resuelve el intercambio OAuth
 * con Google; quien decide si la persona "existe" sigue siendo `User` en
 * MySQL. Ver "Inicio de sesión con Google" en docs/03-autenticacion-seguridad.md
 * para la política completa de vinculación de cuentas. */
// P2002 = violación de constraint @unique de Prisma. Dos requests
// concurrentes con el mismo `sub` de Google (doble clic, reintento de red)
// pueden chocar contra el @@unique de OAuthIdentity o el @unique de
// User.email — se trata como "alguien más ya lo resolvió", no como error.
function isUniqueConstraintViolation(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'P2002',
  );
}

async function loginWithGoogle(
  input: GoogleLoginInput,
  context: { userAgent?: string; ipAddress?: string },
): Promise<GoogleLoginServiceResult> {
  const payload = await verifySupabaseAccessToken(input.supabaseAccessToken);

  if (payload.app_metadata?.provider !== 'google') {
    throw new AppError(400, 'INVALID_PROVIDER', 'Este endpoint solo acepta sesiones de Google.');
  }

  // Defensivo: en la práctica Google/Supabase siempre incluyen el correo,
  // pero un JWT malformado o un scope distinto no debe tumbar la request con
  // un TypeError sin control.
  if (!payload.email) {
    throw new AppError(
      400,
      'GOOGLE_EMAIL_MISSING',
      'La cuenta de Google no compartió un correo electrónico.',
    );
  }

  const existingIdentity = await prisma.oAuthIdentity.findUnique({
    where: { provider_providerUserId: { provider: 'GOOGLE', providerUserId: payload.sub } },
    include: { user: true },
  });

  if (existingIdentity) {
    return issueSession(existingIdentity.user, context, 'auth.google_login');
  }

  // El axioma "Google ya verificó el correo" (docs/03-autenticacion-seguridad.md)
  // solo vale si viene confirmado por una fuente que el usuario no pueda
  // escribir — no todo login de Google trae el correo verificado (cuentas
  // corporativas, otros flujos). Se resuelve contra `identities` de la API
  // de Supabase, no contra `user_metadata` del JWT (ver
  // fetchGoogleEmailVerified): sin esto, se podría vincular o crear una
  // cuenta a partir de un correo que Google no garantiza que sea del usuario
  // real, o directamente falsificado por el propio cliente.
  const googleEmailVerified = await fetchGoogleEmailVerified(input.supabaseAccessToken);
  if (!googleEmailVerified) {
    throw new AppError(
      403,
      'GOOGLE_EMAIL_NOT_VERIFIED',
      'Tu cuenta de Google no tiene el correo verificado.',
    );
  }

  const email = payload.email.toLowerCase();
  const existingUser = await prisma.user.findUnique({ where: { email } });

  if (existingUser) {
    // Vulnerabilidad cerrada acá: si la cuenta LOCAL con este correo nunca
    // verificó ser su dueña (emailVerifiedAt null), NO se auto-vincula. Sin
    // este chequeo, un atacante podría registrarse localmente primero con el
    // correo de la víctima (registro no exige verificar el correo para
    // poder usarse) y, cuando la víctima real inicie sesión con Google, el
    // backend vincularía la identidad de Google de la víctima a la cuenta
    // del atacante — la víctima terminaría con una sesión de una cuenta cuya
    // contraseña conoce el atacante. Que Google haya verificado el correo no
    // dice nada sobre si ESTA cuenta local ya demostró ser su dueña.
    if (!existingUser.emailVerifiedAt) {
      throw new AppError(
        409,
        'LOCAL_ACCOUNT_EMAIL_NOT_VERIFIED',
        'Ya existe una cuenta con este correo sin verificar. Verifica tu correo o inicia sesión con tu contraseña antes de vincular Google.',
      );
    }

    // Vinculación automática, sin paso de confirmación extra: con el correo
    // ya verificado en ambos lados (Google y la cuenta local), Google es una
    // fuente de verificación tan confiable como la que Taskeer usaría por su
    // cuenta (decisión ya documentada, no una relajación de seguridad nueva).
    try {
      await prisma.$transaction([
        prisma.oAuthIdentity.create({
          data: { userId: existingUser.id, provider: 'GOOGLE', providerUserId: payload.sub },
        }),
        prisma.auditLog.create({
          data: {
            userId: existingUser.id,
            action: 'auth.google_account_linked',
            ipAddress: context.ipAddress,
          },
        }),
      ]);
    } catch (err) {
      if (!isUniqueConstraintViolation(err)) {
        throw err;
      }
      // Alguien más (misma identidad de Google, request concurrente) ya
      // ganó la carrera — se resuelve como login normal a continuación.
    }

    return issueSession(existingUser, context, 'auth.google_login');
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

  const displayName =
    payload.user_metadata?.full_name?.trim() ||
    payload.user_metadata?.name?.trim() ||
    email.split('@')[0];

  // Igual que register(): estos son la única vía de recuperación real que
  // tiene una cuenta de Google (no tiene contraseña local, así que "olvidé
  // mi contraseña" no aplica) — se generan al completar el registro, no
  // antes ni como paso opcional (docs/03-autenticacion-seguridad.md).
  const recoveryCodes = generateRecoveryCodeSet();
  let isNewSignup = true;

  let newUser;
  try {
    newUser = await prisma.$transaction(async (tx) => {
      // Google ya verificó el correo (chequeado arriba) — no hace falta el
      // flujo de AuthToken/EMAIL_VERIFICATION para estas cuentas.
      const createdUser = await tx.user.create({
        data: {
          email,
          passwordHash: null,
          displayName,
          emailVerifiedAt: new Date(),
        },
      });

      await tx.oAuthIdentity.create({
        data: { userId: createdUser.id, provider: 'GOOGLE', providerUserId: payload.sub },
      });

      await tx.subscription.create({
        data: { userId: createdUser.id, planId: freePlan.id },
      });

      await tx.recoveryCode.createMany({
        data: recoveryCodes.map((rc) => ({ userId: createdUser.id, codeHash: rc.hash })),
      });

      await tx.auditLog.create({
        data: {
          userId: createdUser.id,
          action: 'auth.google_signup',
          ipAddress: context.ipAddress,
        },
      });

      return createdUser;
    });
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) {
      throw err;
    }
    // Carrera: otra request concurrente con el mismo `sub` ya creó la
    // identidad (o alguien se registró con este correo justo en el medio).
    // Se resuelve buscando de nuevo en vez de fallar con un 500 genérico —
    // esos códigos de recuperación ya los generó la request que ganó la
    // carrera, no hay que devolver un segundo set.
    const identity = await prisma.oAuthIdentity.findUnique({
      where: { provider_providerUserId: { provider: 'GOOGLE', providerUserId: payload.sub } },
      include: { user: true },
    });
    if (!identity) {
      throw err;
    }
    newUser = identity.user;
    isNewSignup = false;
  }

  const session = await issueSession(newUser, context, 'auth.google_login');

  // Se muestran una sola vez, aquí, justo después del registro — igual que
  // en register(). Ni el usuario ni el backend pueden volver a verlos
  // después (solo se persiste el hash de cada uno).
  return isNewSignup
    ? { ...session, recoveryCodes: recoveryCodes.map((rc) => rc.plain) }
    : session;
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

  // Cuenta que solo entra por Google (docs/03-autenticacion-seguridad.md,
  // "Inicio de sesión con Google") — no hay contraseña local contra la cual
  // confirmar. Regenerar exige sesión activa + contraseña, nunca "en frío";
  // sin una contraseña que verificar, no hay forma segura de continuar.
  if (!user.passwordHash) {
    throw new AppError(
      400,
      'NO_LOCAL_PASSWORD',
      'Tu cuenta no tiene contraseña local todavía. Agrega una desde tu perfil antes de regenerar códigos de recuperación.',
    );
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

async function changePassword(
  userId: string,
  input: ChangePasswordInput,
  context: { userAgent?: string; ipAddress?: string },
): Promise<LoginServiceResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'La sesión no es válida.');
  }

  // Mismo criterio que regenerateRecoveryCodes: sin contraseña local no hay
  // nada contra qué confirmar la actual (cuenta que solo entra por Google).
  if (!user.passwordHash) {
    throw new AppError(
      400,
      'NO_LOCAL_PASSWORD',
      'Tu cuenta no tiene contraseña local todavía — inició sesión con Google.',
    );
  }

  const passwordMatches = await argon2.verify(user.passwordHash, input.currentPassword);
  if (!passwordMatches) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'La contraseña actual no es correcta.');
  }

  const newPasswordHash = await argon2.hash(input.newPassword, { type: argon2.argon2id });

  await prisma.$transaction(async (tx) => {
    // updateMany condicionado por el passwordHash ya verificado arriba (en
    // vez de un update por id incondicional) — mismo patrón atómico que
    // resetPasswordWithCode/refreshAccessToken: si dos cambios de contraseña
    // concurrentes del mismo usuario llegan casi al mismo tiempo, el que
    // pierde la carrera ve `count === 0` (el passwordHash ya no coincide con
    // el que verificó) y aborta con un error explícito, en vez de pisar en
    // silencio la contraseña que la otra request acaba de establecer.
    const { count } = await tx.user.updateMany({
      where: { id: user.id, passwordHash: user.passwordHash },
      data: { passwordHash: newPasswordHash },
    });

    if (count === 0) {
      throw new AppError(
        409,
        'CONCURRENT_PASSWORD_CHANGE',
        'Tu contraseña ya se actualizó desde otra sesión. Vuelve a intentarlo.',
      );
    }

    // Regla no negociable: cambiar la contraseña revoca todas las sesiones
    // activas (docs/03-autenticacion-seguridad.md) — incluida la que hizo
    // esta misma request; issueSession() de abajo le emite una sesión nueva
    // para no forzar un relogin inmediato de quien la acaba de cambiar a
    // propósito, mientras cualquier otro dispositivo sí queda deslogueado.
    await tx.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await tx.auditLog.create({
      data: { userId: user.id, action: 'auth.password_changed', ipAddress: context.ipAddress },
    });
  });

  return issueSession(
    { ...user, passwordHash: newPasswordHash },
    context,
    'auth.password_changed_session_reissued',
  );
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
  buildGoogleAuthorizeUrl,
  resendVerificationEmail,
  verifyEmail,
  login,
  loginWithGoogle,
  refreshAccessToken,
  resetPasswordWithCode,
  regenerateRecoveryCodes,
  changePassword,
  updateProfile,
  logout,
};

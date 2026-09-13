// DTOs propios del módulo auth. El Backend no comparte paquete de tipos con
// el Frontend por ahora — cada uno define los suyos (ver docs/01-arquitectura.md).

export interface PublicUserDto {
  id: string;
  email: string;
  displayName: string;
  emailVerifiedAt: string | null;
  // false para cuentas creadas por Google que nunca agregaron una
  // contraseña local (User.passwordHash null) — el Frontend lo usa para
  // decidir si mostrar "cambiar contraseña"/"regenerar códigos de
  // recuperación" o una nota explicando por qué esa cuenta no aplica.
  hasPassword: boolean;
}

export interface RegisterResultDto {
  user: PublicUserDto;
  // Solo presente en desarrollo, cuando no hay proveedor de correo conectado
  // todavía — ver TODO en auth.service.ts sobre la integración real con Resend.
  emailVerificationToken?: string;
  // Los 10 códigos de recuperación en texto plano — se muestran UNA sola vez,
  // aquí, justo después del registro. Ni el usuario ni el backend pueden
  // volver a verlos después (solo se persiste el hash de cada uno).
  recoveryCodes: string[];
}

export interface RecoveryCodesDto {
  recoveryCodes: string[];
}

export interface ResendVerificationResultDto {
  alreadyVerified: boolean;
  // Solo presente en desarrollo — mismo criterio que
  // RegisterResultDto.emailVerificationToken.
  emailVerificationToken?: string;
}

export interface LoginResultDto {
  accessToken: string;
  user: PublicUserDto;
}

// Resultado interno del service — incluye el refresh token en texto plano y
// su expiración, que el controller usa para setear la cookie httpOnly. Nunca
// se serializa completo como respuesta JSON (eso sería exponer el refresh
// token en el body, contradiciendo el patrón cookie-only).
export interface LoginServiceResult extends LoginResultDto {
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface JwtAccessTokenPayload {
  sub: string; // userId
  email: string;
}

// Mismo shape que LoginServiceResult: /auth/refresh también rota el refresh
// token (revoca el usado, entrega uno nuevo) además de emitir un access
// token nuevo — reduce la ventana de reuso si un refresh token se filtra.
export type RefreshServiceResult = LoginServiceResult;

// Subconjunto de claims del JWT que Supabase Auth firma tras un login con
// Google — solo lo que Taskeer necesita leer, no el shape completo real de
// Supabase. `sub` es el identificador estable de la identidad en Supabase
// (OAuthIdentity.providerUserId), no el id de User de Taskeer.
export interface SupabaseAccessTokenPayload {
  sub: string;
  email: string;
  app_metadata?: { provider?: string };
  // Deliberadamente SIN `email_verified` acá: viene dentro de este objeto en
  // el JWT real de Supabase GoTrue, pero `user_metadata` es editable por el
  // propio usuario autenticado (ver fetchGoogleEmailVerified en
  // auth.service.ts) — nunca se lee de aquí para decisiones de seguridad.
  user_metadata?: { full_name?: string; name?: string };
}

// Mismo shape que LoginServiceResult, más los códigos de recuperación —
// SOLO presentes cuando este login creó una cuenta nueva (equivalente a
// RegisterResultDto.recoveryCodes). En login de una identidad ya existente o
// vinculación a una cuenta local, el campo no viene: esos usuarios ya
// recibieron sus códigos en su momento (registro local, o un login con
// Google anterior).
export interface GoogleLoginServiceResult extends LoginServiceResult {
  recoveryCodes?: string[];
}

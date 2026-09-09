// DTOs propios del módulo auth. El Backend no comparte paquete de tipos con
// el Frontend por ahora — cada uno define los suyos (ver docs/01-arquitectura.md).

export interface PublicUserDto {
  id: string;
  email: string;
  displayName: string;
  emailVerifiedAt: string | null;
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

import 'dotenv/config';
import { buildDatabaseUrl } from './database-url';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: buildDatabaseUrl(),
  jwtSecret: required('JWT_SECRET'),
  jwtAccessTokenTtl: process.env.JWT_ACCESS_TOKEN_TTL ?? '15m',
  refreshTokenCookieName: process.env.REFRESH_TOKEN_COOKIE_NAME ?? 'taskeer_refresh',
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  // URL pública del Frontend para armar enlaces en correos (verificación,
  // reset de contraseña) — deliberadamente separada de `corsAllowedOrigins`,
  // que es una allowlist de seguridad, no "la URL canónica del frontend"
  // (puede tener 0, 1, o varios orígenes según el entorno).
  publicWebUrl: process.env.PUBLIC_WEB_URL ?? 'http://localhost:4200',
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  resendFromEmail: process.env.RESEND_FROM_EMAIL ?? '',
  internalWorkerSecret: required('INTERNAL_WORKER_SECRET'),
  // Arman la URL de autorización de Google a la que el Backend redirige al
  // navegador — el Frontend nunca necesita estas credenciales. También se
  // usa para construir la URL del JWKS con el que se verifica la firma del
  // JWT que Supabase emite tras el login con Google (ver
  // "Inicio de sesión con Google" en docs/03-autenticacion-seguridad.md) —
  // Supabase firma con una signing key que puede rotar, así que el backend
  // nunca guarda un secreto fijo para esto, siempre resuelve la clave
  // pública vigente contra Supabase.
  supabaseUrl: required('SUPABASE_URL'),
  supabaseAnonKey: required('SUPABASE_ANON_KEY'),
};

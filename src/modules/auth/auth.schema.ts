import { z } from 'zod';

// Todo body/params/query se valida con Zod antes de tocar la base de datos —
// ver docs/03-autenticacion-seguridad.md, sección "Validación de entrada".

export const registerSchema = z.object({
  body: z.object({
    email: z.string().trim().toLowerCase().email('El correo no es válido.'),
    password: z
      .string()
      .min(8, 'La contraseña debe tener al menos 8 caracteres.')
      .max(128, 'La contraseña es demasiado larga.'),
    displayName: z
      .string()
      .trim()
      .min(2, 'El nombre debe tener al menos 2 caracteres.')
      .max(100, 'El nombre es demasiado largo.'),
  }),
});

export const verifyEmailSchema = z.object({
  query: z.object({
    token: z.string().min(1, 'Falta el token de verificación.'),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().trim().toLowerCase().email('El correo no es válido.'),
    password: z
      .string()
      .min(1, 'La contraseña es obligatoria.')
      .max(128, 'La contraseña es demasiado larga.'),
  }),
});

// Formato de un código de recuperación: XXXX-XXXX, mayúsculas + números, sin
// caracteres ambiguos (0/O, 1/I/L quedan excluidos ya desde la generación —
// ver auth.service.ts — esta regex solo valida la forma general de entrada).
const RECOVERY_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export const resetPasswordWithCodeSchema = z.object({
  body: z.object({
    email: z.string().trim().toLowerCase().email('El correo no es válido.'),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(RECOVERY_CODE_PATTERN, 'El código de recuperación no tiene el formato correcto.'),
    newPassword: z
      .string()
      .min(8, 'La contraseña debe tener al menos 8 caracteres.')
      .max(128, 'La contraseña es demasiado larga.'),
  }),
});

export const regenerateRecoveryCodesSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1, 'La contraseña actual es obligatoria.'),
  }),
});

export const updateProfileSchema = z.object({
  body: z.object({
    displayName: z
      .string()
      .trim()
      .min(2, 'El nombre debe tener al menos 2 caracteres.')
      .max(100, 'El nombre es demasiado largo.'),
  }),
});

export type RegisterInput = z.infer<typeof registerSchema>['body'];
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>['query'];
export type LoginInput = z.infer<typeof loginSchema>['body'];
export type ResetPasswordWithCodeInput = z.infer<typeof resetPasswordWithCodeSchema>['body'];
export type RegenerateRecoveryCodesInput = z.infer<typeof regenerateRecoveryCodesSchema>['body'];
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>['body'];

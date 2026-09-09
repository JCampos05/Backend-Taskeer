import { z } from 'zod';

// Todo body/params/query se valida con Zod antes de tocar la base de datos —
// mismo patrón que modules/auth/auth.schema.ts.

const uuidParam = z.string().uuid('El identificador no es válido.');

// Slug: minúsculas, dígitos y guiones únicamente (mismo alfabeto que produce
// el slugify de workspaces.service.ts) — evita que alguien fuerce un slug con
// mayúsculas o caracteres raros directo por API saltándose la generación automática.
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const createWorkspaceSchema = z.object({
  body: z.object({
    name: z
      .string()
      .trim()
      .min(2, 'El nombre debe tener al menos 2 caracteres.')
      .max(150, 'El nombre es demasiado largo.'),
  }),
});

export const workspaceIdParamSchema = z.object({
  params: z.object({ id: uuidParam }),
});

export const updateWorkspaceSchema = z.object({
  params: z.object({ id: uuidParam }),
  body: z
    .object({
      name: z
        .string()
        .trim()
        .min(2, 'El nombre debe tener al menos 2 caracteres.')
        .max(150, 'El nombre es demasiado largo.')
        .optional(),
      slug: z
        .string()
        .trim()
        .toLowerCase()
        .min(2, 'El slug debe tener al menos 2 caracteres.')
        .max(160, 'El slug es demasiado largo.')
        .regex(SLUG_PATTERN, 'El slug solo puede tener minúsculas, números y guiones.')
        .optional(),
    })
    .refine((data) => data.name !== undefined || data.slug !== undefined, {
      message: 'Debes enviar al menos un campo para actualizar (name o slug).',
    }),
});

export const memberParamsSchema = z.object({
  params: z.object({ id: uuidParam, userId: uuidParam }),
});

export const updateMemberRoleSchema = z.object({
  params: z.object({ id: uuidParam, userId: uuidParam }),
  body: z.object({
    // OWNER nunca se asigna por esta vía — solo mediante transfer-ownership.
    role: z.enum(['ADMIN', 'EDITOR', 'VIEWER'], {
      errorMap: () => ({ message: 'El rol debe ser ADMIN, EDITOR o VIEWER.' }),
    }),
  }),
});

export const transferOwnershipSchema = z.object({
  params: z.object({ id: uuidParam }),
  body: z.object({
    newOwnerUserId: uuidParam,
  }),
});

export const createInvitationSchema = z.object({
  params: z.object({ id: uuidParam }),
  body: z.object({
    email: z.string().trim().toLowerCase().email('El correo no es válido.'),
    // Igual que el cambio de rol: nunca se invita como OWNER por esta vía.
    role: z.enum(['ADMIN', 'EDITOR', 'VIEWER'], {
      errorMap: () => ({ message: 'El rol debe ser ADMIN, EDITOR o VIEWER.' }),
    }),
  }),
});

export const listInvitationsSchema = z.object({
  params: z.object({ id: uuidParam }),
});

export const revokeInvitationSchema = z.object({
  params: z.object({ id: uuidParam, invitationId: uuidParam }),
});

export const acceptInvitationSchema = z.object({
  query: z.object({
    token: z.string().min(1, 'Falta el token de invitación.'),
  }),
});

export const acceptInvitationByIdSchema = z.object({
  params: z.object({ invitationId: uuidParam }),
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>['body'];
export type WorkspaceIdParams = z.infer<typeof workspaceIdParamSchema>['params'];
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>['body'];
export type MemberParams = z.infer<typeof memberParamsSchema>['params'];
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>['body'];
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>['body'];
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>['body'];
export type RevokeInvitationParams = z.infer<typeof revokeInvitationSchema>['params'];
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>['query'];
export type AcceptInvitationByIdParams = z.infer<typeof acceptInvitationByIdSchema>['params'];

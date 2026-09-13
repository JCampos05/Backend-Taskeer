import { z } from 'zod';

// Todo body/params/query se valida con Zod antes de tocar la base de datos —
// mismo patrón que modules/workspaces/workspaces.schema.ts.

const uuidParam = z.string().uuid('El identificador no es válido.');

// Mismo alfabeto que produce el slugify de boards.service.ts — evita que
// alguien fuerce un slug con mayúsculas o caracteres raros directo por API.
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const workspaceIdParamSchema = z.object({
  params: z.object({ workspaceId: uuidParam }),
});

export const createBoardSchema = z.object({
  params: z.object({ workspaceId: uuidParam }),
  body: z.object({
    name: z
      .string()
      .trim()
      .min(2, 'El nombre debe tener al menos 2 caracteres.')
      .max(150, 'El nombre es demasiado largo.'),
  }),
});

export const boardIdParamsSchema = z.object({
  params: z.object({ workspaceId: uuidParam, boardId: uuidParam }),
});

export const updateBoardSchema = z.object({
  params: z.object({ workspaceId: uuidParam, boardId: uuidParam }),
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

// null = ilimitado (ver Column.wipLimit en schema.prisma) — 0 no tendría
// sentido operativo (una columna que nunca admite tareas), así que se exige
// al menos 1 cuando sí se manda un número.
const wipLimitField = z
  .number()
  .int('El límite debe ser un entero.')
  .min(1, 'El límite debe ser mayor a 0.')
  .nullable()
  .optional();

export const createColumnSchema = z.object({
  params: z.object({ workspaceId: uuidParam, boardId: uuidParam }),
  body: z.object({
    name: z
      .string()
      .trim()
      .min(1, 'El nombre de la columna es obligatorio.')
      .max(100, 'El nombre de la columna es demasiado largo.'),
    wipLimit: wipLimitField,
  }),
});

export const columnParamsSchema = z.object({
  params: z.object({ workspaceId: uuidParam, boardId: uuidParam, columnId: uuidParam }),
});

export const updateColumnSchema = z.object({
  params: z.object({ workspaceId: uuidParam, boardId: uuidParam, columnId: uuidParam }),
  body: z
    .object({
      name: z
        .string()
        .trim()
        .min(1, 'El nombre de la columna es obligatorio.')
        .max(100, 'El nombre de la columna es demasiado largo.')
        .optional(),
      position: z
        .number()
        .int('La posición debe ser un entero.')
        .min(0, 'La posición no puede ser negativa.')
        .optional(),
      wipLimit: wipLimitField,
    })
    .refine(
      (data) => data.name !== undefined || data.position !== undefined || data.wipLimit !== undefined,
      { message: 'Debes enviar al menos un campo para actualizar (name, position o wipLimit).' },
    ),
});

// --- Overrides de rol por board (roles por tablero individual) ---
// Solo lo gestiona el OWNER/ADMIN del workspace — ver
// boards.service.ts::requireOwnerOrAdmin, que para estas acciones usa
// siempre el rol crudo de WorkspaceMember, nunca el rol efectivo.

const workspaceRole = z.enum(['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']);

export const setBoardMemberOverrideSchema = z.object({
  params: z.object({ workspaceId: uuidParam, boardId: uuidParam, userId: uuidParam }),
  body: z.object({
    role: workspaceRole,
  }),
});

export const boardMemberOverrideParamsSchema = z.object({
  params: z.object({ workspaceId: uuidParam, boardId: uuidParam, userId: uuidParam }),
});

export type WorkspaceIdParams = z.infer<typeof workspaceIdParamSchema>['params'];
export type CreateBoardInput = z.infer<typeof createBoardSchema>['body'];
export type BoardIdParams = z.infer<typeof boardIdParamsSchema>['params'];
export type UpdateBoardInput = z.infer<typeof updateBoardSchema>['body'];
export type CreateColumnInput = z.infer<typeof createColumnSchema>['body'];
export type ColumnParams = z.infer<typeof columnParamsSchema>['params'];
export type UpdateColumnInput = z.infer<typeof updateColumnSchema>['body'];
export type SetBoardMemberOverrideInput = z.infer<typeof setBoardMemberOverrideSchema>['body'];
export type BoardMemberOverrideParams = z.infer<typeof boardMemberOverrideParamsSchema>['params'];

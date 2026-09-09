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

export const createColumnSchema = z.object({
  params: z.object({ workspaceId: uuidParam, boardId: uuidParam }),
  body: z.object({
    name: z
      .string()
      .trim()
      .min(1, 'El nombre de la columna es obligatorio.')
      .max(100, 'El nombre de la columna es demasiado largo.'),
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
    })
    .refine((data) => data.name !== undefined || data.position !== undefined, {
      message: 'Debes enviar al menos un campo para actualizar (name o position).',
    }),
});

export type WorkspaceIdParams = z.infer<typeof workspaceIdParamSchema>['params'];
export type CreateBoardInput = z.infer<typeof createBoardSchema>['body'];
export type BoardIdParams = z.infer<typeof boardIdParamsSchema>['params'];
export type UpdateBoardInput = z.infer<typeof updateBoardSchema>['body'];
export type CreateColumnInput = z.infer<typeof createColumnSchema>['body'];
export type ColumnParams = z.infer<typeof columnParamsSchema>['params'];
export type UpdateColumnInput = z.infer<typeof updateColumnSchema>['body'];

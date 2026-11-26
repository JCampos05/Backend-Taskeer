import { z } from 'zod';

// Todo body/params se valida con Zod antes de tocar la base de datos — mismo
// patrón que modules/boards/boards.schema.ts.

const uuidParam = z.string().uuid('El identificador no es válido.');

const nameField = z
  .string()
  .trim()
  .min(1, 'El nombre de la lista es obligatorio.')
  .max(100, 'El nombre de la lista es demasiado largo.');

const positionField = z
  .number()
  .int('La posición debe ser un entero.')
  .min(0, 'La posición no puede ser negativa.');

export const createListSchema = z.object({
  body: z.object({
    // UUID generado por el cliente; creación idempotente (ver lists.service.ts).
    id: uuidParam.optional(),
    name: nameField,
    position: positionField.optional(),
  }),
});

export const listIdParamsSchema = z.object({
  params: z.object({ listId: uuidParam }),
});

export const updateListSchema = z.object({
  params: z.object({ listId: uuidParam }),
  body: z
    .object({
      name: nameField.optional(),
      position: positionField.optional(),
    })
    .refine((data) => data.name !== undefined || data.position !== undefined, {
      message: 'Debes enviar al menos un campo para actualizar (name o position).',
    }),
});

export type CreateListInput = z.infer<typeof createListSchema>['body'];
export type ListIdParams = z.infer<typeof listIdParamsSchema>['params'];
export type UpdateListInput = z.infer<typeof updateListSchema>['body'];

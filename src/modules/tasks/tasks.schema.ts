import { z } from 'zod';

// Todo body/params/query se valida con Zod antes de tocar la base de datos —
// mismo patrón que modules/workspaces/workspaces.schema.ts.

const uuidParam = z.string().uuid('El identificador no es válido.');

// ISO 8601 tal cual — se guarda en UTC sin convertir zona horaria en el
// backend (ver CLAUDE.md, reglas no negociables).
const isoDateString = z.string().datetime({ message: 'La fecha debe ser un ISO 8601 válido.' });

export const createTaskSchema = z.object({
  body: z.object({
    columnId: uuidParam,
    title: z
      .string()
      .trim()
      .min(1, 'El título es obligatorio.')
      .max(200, 'El título es demasiado largo.'),
    description: z.string().trim().max(5000, 'La descripción es demasiado larga.').optional(),
    dueAt: isoDateString.optional(),
    assigneeId: uuidParam.optional(),
  }),
});

export const listTasksSchema = z.object({
  query: z.object({
    boardId: uuidParam,
  }),
});

export const taskIdParamSchema = z.object({
  params: z.object({ taskId: uuidParam }),
});

export const updateTaskSchema = z.object({
  params: z.object({ taskId: uuidParam }),
  body: z
    .object({
      title: z
        .string()
        .trim()
        .min(1, 'El título es obligatorio.')
        .max(200, 'El título es demasiado largo.')
        .optional(),
      description: z
        .string()
        .trim()
        .max(5000, 'La descripción es demasiado larga.')
        .nullable()
        .optional(),
      dueAt: isoDateString.nullable().optional(),
      assigneeId: uuidParam.nullable().optional(),
    })
    .refine(
      (data) =>
        data.title !== undefined ||
        data.description !== undefined ||
        data.dueAt !== undefined ||
        data.assigneeId !== undefined,
      { message: 'Debes enviar al menos un campo para actualizar.' },
    ),
});

export const moveTaskSchema = z.object({
  params: z.object({ taskId: uuidParam }),
  body: z.object({
    columnId: uuidParam,
    position: z.number().int('La posición debe ser un entero.').min(0, 'La posición no puede ser negativa.'),
  }),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>['body'];
export type ListTasksQuery = z.infer<typeof listTasksSchema>['query'];
export type TaskIdParams = z.infer<typeof taskIdParamSchema>['params'];
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>['body'];
export type MoveTaskInput = z.infer<typeof moveTaskSchema>['body'];

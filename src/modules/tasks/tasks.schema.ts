import { z } from 'zod';

// Todo body/params/query se valida con Zod antes de tocar la base de datos —
// mismo patrón que modules/workspaces/workspaces.schema.ts.

const uuidParam = z.string().uuid('El identificador no es válido.');

// ISO 8601 tal cual — se guarda en UTC sin convertir zona horaria en el
// backend (ver CLAUDE.md, reglas no negociables).
const isoDateString = z.string().datetime({ message: 'La fecha debe ser un ISO 8601 válido.' });

const taskPriority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);

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
    priority: taskPriority.optional(),
  }),
});

export const listTasksSchema = z.object({
  query: z.object({
    boardId: uuidParam,
    priority: taskPriority.optional(),
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
      priority: taskPriority.optional(),
    })
    .refine(
      (data) =>
        data.title !== undefined ||
        data.description !== undefined ||
        data.dueAt !== undefined ||
        data.assigneeId !== undefined ||
        data.priority !== undefined,
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

// --- Subtasks (checklist dentro de una Task) ---
// No se anidan bajo /workspaces/.../boards/.../tasks — mismo criterio de
// "un solo nivel de anidamiento" ya aplicado a Task (ver comentario en
// tasks.routes.ts): /tasks/:taskId/subtasks, el taskId ya resuelve contexto.

export const createSubtaskSchema = z.object({
  params: z.object({ taskId: uuidParam }),
  body: z.object({
    title: z
      .string()
      .trim()
      .min(1, 'El título es obligatorio.')
      .max(200, 'El título es demasiado largo.'),
    dueAt: isoDateString.optional(),
    assigneeId: uuidParam.optional(),
  }),
});

export const subtaskParamsSchema = z.object({
  params: z.object({ taskId: uuidParam, subtaskId: uuidParam }),
});

export const updateSubtaskSchema = z.object({
  params: z.object({ taskId: uuidParam, subtaskId: uuidParam }),
  body: z
    .object({
      title: z
        .string()
        .trim()
        .min(1, 'El título es obligatorio.')
        .max(200, 'El título es demasiado largo.')
        .optional(),
      dueAt: isoDateString.nullable().optional(),
      assigneeId: uuidParam.nullable().optional(),
      completed: z.boolean().optional(),
      position: z
        .number()
        .int('La posición debe ser un entero.')
        .min(0, 'La posición no puede ser negativa.')
        .optional(),
    })
    .refine(
      (data) =>
        data.title !== undefined ||
        data.dueAt !== undefined ||
        data.assigneeId !== undefined ||
        data.completed !== undefined ||
        data.position !== undefined,
      { message: 'Debes enviar al menos un campo para actualizar.' },
    ),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>['body'];
export type ListTasksQuery = z.infer<typeof listTasksSchema>['query'];
export type TaskIdParams = z.infer<typeof taskIdParamSchema>['params'];
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>['body'];
export type MoveTaskInput = z.infer<typeof moveTaskSchema>['body'];
export type CreateSubtaskInput = z.infer<typeof createSubtaskSchema>['body'];
export type SubtaskParams = z.infer<typeof subtaskParamsSchema>['params'];
export type UpdateSubtaskInput = z.infer<typeof updateSubtaskSchema>['body'];

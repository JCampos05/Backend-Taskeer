import { z } from 'zod';

// Todo body/params/query se valida con Zod antes de tocar la base de datos —
// mismo patrón que modules/workspaces/workspaces.schema.ts.

const uuidParam = z.string().uuid('El identificador no es válido.');

// `id` generado por el CLIENTE al crear (apps offline-first): se normaliza a
// minúsculas. Un cliente nativo puede mandar UUID en mayúsculas (p. ej.
// UUID().uuidString de Swift); guardarlos tal cual haría que el orden por id de
// la sincronización dependiera del collation de MySQL en vez de ser ordinal.
const clientId = z
  .string()
  .uuid('El identificador no es válido.')
  .transform((value) => value.toLowerCase());

// ISO 8601 tal cual — se guarda en UTC sin convertir zona horaria en el
// backend (ver CLAUDE.md, reglas no negociables).
const isoDateString = z.string().datetime({ message: 'La fecha debe ser un ISO 8601 válido.' });

const taskPriority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);

// --- Repetición de tareas (solo se guarda; el backend no calcula nada) ---
// La app calcula la sucesora al completar; aquí solo se validan rangos. La
// coherencia entre campos (sin repeatUnit el resto debe ser nulo, etc.) se
// comprueba en el service, porque en un PATCH hay que cruzarla con lo ya
// guardado.
export const REPEAT_UNITS = ['DAY', 'WEEK', 'MONTH', 'YEAR'] as const;

const repeatFields = {
  repeatUnit: z.enum(REPEAT_UNITS).nullable().optional(),
  repeatInterval: z
    .number()
    .int('El intervalo debe ser un entero.')
    .min(1, 'El intervalo debe ser al menos 1.')
    .max(1000, 'El intervalo es demasiado grande.')
    .nullable()
    .optional(),
  // Máscara de 7 bits: lunes = bit 0 ... domingo = bit 6. 0 = sin días fijos.
  repeatWeekdays: z
    .number()
    .int('Los días de la semana deben ser un entero.')
    .min(0, 'Los días de la semana no son válidos.')
    .max(127, 'Los días de la semana no son válidos.')
    .nullable()
    .optional(),
  repeatAnchorDay: z
    .number()
    .int('El día ancla debe ser un entero.')
    .min(1, 'El día ancla debe estar entre 1 y 31.')
    .max(31, 'El día ancla debe estar entre 1 y 31.')
    .nullable()
    .optional(),
  repeatSuccessorId: uuidParam.nullable().optional(),
};

export const createTaskSchema = z.object({
  body: z.object({
    // UUID generado por el cliente (apps offline-first). Si se omite, lo
    // genera el servidor; si ya existe en el mismo contexto, la creación es
    // idempotente (devuelve la existente). Ver tasks.service.ts.
    id: clientId.optional(),
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
    completedAt: isoDateString.optional(),
    ...repeatFields,
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
      // El cliente envía el instante en que completó la tarea (null = la
      // reabre). El servidor no mueve la tarea de columna por su cuenta.
      completedAt: isoDateString.nullable().optional(),
      ...repeatFields,
    })
    .refine(
      (data) =>
        data.title !== undefined ||
        data.description !== undefined ||
        data.dueAt !== undefined ||
        data.assigneeId !== undefined ||
        data.priority !== undefined ||
        data.completedAt !== undefined ||
        data.repeatUnit !== undefined ||
        data.repeatInterval !== undefined ||
        data.repeatWeekdays !== undefined ||
        data.repeatAnchorDay !== undefined ||
        data.repeatSuccessorId !== undefined,
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
    id: clientId.optional(),
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

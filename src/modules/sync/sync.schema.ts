import { z } from 'zod';

// Todo query/body se valida con Zod antes de tocar la base de datos. Los errores
// de la ENVOLTURA son 400 VALIDATION_ERROR; los errores de `data` de cada
// mutación NO lo son: se validan en el service y salen como `rejected
// INVALID_MUTATION` de esa mutación (el lote nunca falla entero por una).

export const SYNC_DEFAULT_LIMIT = 200;
export const SYNC_MAX_LIMIT = 500;
export const SYNC_MAX_BATCH = 100;

export const syncChangesSchema = z.object({
  query: z.object({
    // Solo se acota el texto. El contenido (base64url de JSON) se decodifica en
    // el service para responder 400 INVALID_CURSOR y no el VALIDATION_ERROR
    // genérico. 512 es el máximo del contrato.
    cursor: z.string().max(512, 'El cursor no es válido.').optional(),
    // `coerce` porque en un query string todo llega como texto.
    limit: z.coerce
      .number()
      .int('El límite debe ser un entero.')
      .min(1, 'El límite mínimo es 1.')
      .max(SYNC_MAX_LIMIT, `El límite máximo es ${SYNC_MAX_LIMIT}.`)
      .default(SYNC_DEFAULT_LIMIT),
  }),
});

export type SyncChangesQuery = z.infer<typeof syncChangesSchema>['query'];

// Ids en minúsculas: el orden por id de la sincronización debe ser ordinal.
const uuid = z
  .string()
  .uuid('El identificador no es válido.')
  .transform((value) => value.toLowerCase());
const isoDate = z.string().datetime({ message: 'La fecha debe ser un ISO 8601 válido.' });

const mutationBase = z.object({
  clientMutationId: uuid,
  // `entity` se deja como texto libre: un valor desconocido es `rejected
  // UNKNOWN_ENTITY` de esa mutación, no un 400 del lote.
  entity: z.string().min(1).max(40),
  id: uuid,
  baseUpdatedAt: isoDate.nullable(),
  clientUpdatedAt: isoDate,
});

const mutationSchema = z.discriminatedUnion('op', [
  mutationBase.extend({ op: z.literal('upsert'), data: z.record(z.unknown()) }),
  mutationBase.extend({ op: z.literal('delete') }),
]);

export const syncPushSchema = z.object({
  body: z
    .object({
      // El máximo (100) se comprueba antes, en el controller, para responder
      // 413 BATCH_TOO_LARGE y no 400.
      mutations: z.array(mutationSchema).min(1, 'Debes enviar al menos una mutación.'),
    })
    .superRefine((body, ctx) => {
      const seen = new Set<string>();
      for (const m of body.mutations) {
        if (seen.has(m.clientMutationId)) {
          ctx.addIssue({ code: 'custom', message: 'clientMutationId repetido en el lote.' });
          return;
        }
        seen.add(m.clientMutationId);
      }
    }),
});

export type SyncMutationInput = z.infer<typeof syncPushSchema>['body']['mutations'][number];

// --- `data` por entidad (validado en el service) ---------------------------

const priority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);

export const listDataSchema = z.object({
  name: z.string().trim().min(1).max(100),
  position: z.number().int().min(0),
});

export const taskDataSchema = z
  .object({
    columnId: uuid.nullable(),
    listId: uuid.nullable(),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(5000).nullable(),
    priority,
    dueAt: isoDate.nullable(),
    assigneeId: uuid.nullable(),
    position: z.number().int().min(0),
    completedAt: isoDate.nullable(),
    repeatUnit: z.enum(['DAY', 'WEEK', 'MONTH', 'YEAR']).nullable(),
    repeatInterval: z.number().int().min(1).max(1000).nullable(),
    repeatWeekdays: z.number().int().min(0).max(127).nullable(),
    repeatAnchorDay: z.number().int().min(1).max(31).nullable(),
    repeatSuccessorId: uuid.nullable(),
  })
  // Exactamente uno de los dos no nulo.
  .refine((d) => (d.columnId === null) !== (d.listId === null), {
    message: 'Debes enviar listId o columnId, no ambos ni ninguno.',
  });

export type ListData = z.infer<typeof listDataSchema>;
export type TaskData = z.infer<typeof taskDataSchema>;

export const boardDataSchema = z.object({
  workspaceId: uuid,
  name: z.string().trim().min(2).max(150),
  // Solo en el alta: siembra ESTAS columnas (con sus ids) en vez de las tres por
  // defecto. En una edición se ignora.
  columns: z
    .array(
      z.object({
        id: uuid,
        name: z.string().trim().min(1).max(100),
        position: z.number().int().min(0),
        wipLimit: z.number().int().min(1).nullable().optional(),
        isDoneColumn: z.boolean(),
      }),
    )
    .min(1)
    .max(50)
    .refine((cols) => new Set(cols.map((c) => c.id)).size === cols.length, {
      message: 'Los ids de las columnas no pueden repetirse.',
    })
    .optional(),
});

export const columnDataSchema = z.object({
  boardId: uuid,
  name: z.string().trim().min(1).max(100),
  position: z.number().int().min(0),
  wipLimit: z.number().int().min(1).nullable(),
  isDoneColumn: z.boolean(),
});

export const subtaskDataSchema = z.object({
  taskId: uuid,
  title: z.string().trim().min(1).max(200),
  completed: z.boolean(),
  position: z.number().int().min(0),
  assigneeId: uuid.nullable(),
  dueAt: isoDate.nullable(),
});

export type BoardData = z.infer<typeof boardDataSchema>;
export type ColumnData = z.infer<typeof columnDataSchema>;
export type SubtaskData = z.infer<typeof subtaskDataSchema>;

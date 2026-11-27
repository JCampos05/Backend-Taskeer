import type { Prisma, SyncMutationStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import { isUniqueConstraintError } from '../../utils/idempotent-create';
import { listsService } from '../lists/lists.service';
import { tasksService } from '../tasks/tasks.service';
import type { UpdateTaskInput } from '../tasks/tasks.schema';
import { ensurePersonalWorkspace } from '../workspaces/personal-workspace';
import { toSyncListDto, toSyncListTaskDto } from './sync.mappers';
import {
  listDataSchema,
  taskDataSchema,
  type ListData,
  type SyncMutationInput,
  type TaskData,
} from './sync.schema';
import {
  SYNC_CONTRACT_VERSION,
  type SyncPushResponse,
  type SyncPushResult,
  type SyncPushStatus,
} from './sync.types';

// Escritura por lotes para la app móvil (contrato v1.0, §5.2 y §5.4). NO
// reimplementa reglas: cada mutación llama a los services existentes, así que
// los permisos, el WIP, la repetición y las notificaciones son los de la API
// normal. Lo propio de este archivo es (1) la idempotencia por clientMutationId,
// (2) el veredicto de conflictos (última escritura gana) y (3) traducir
// errores de los services a `rejected`.
//
// El cuerpo de las mutaciones NUNCA se registra en logs: son datos del usuario.

// Tope de adelanto del reloj del cliente (§4.3.3): un dispositivo con la hora
// muy adelantada no puede "ganar" siempre.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
// Las mutaciones procesadas se conservan para reenvíos ≥ 30 días (§5.2).
const MUTATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_EVERY_MS = 60 * 60 * 1000;

interface Outcome {
  status: SyncPushStatus;
  record: unknown;
  error?: { code: string; message: string };
  /** false = no se guarda en SyncMutation (la mutación aún no es procesable en
   * este despliegue; reenviarla más adelante debe poder funcionar). */
  persist?: boolean;
}

const applied = (record: unknown): Outcome => ({ status: 'applied', record });
const conflict = (record: unknown): Outcome => ({ status: 'conflict', record });
const rejected = (code: string, message: string, record: unknown = null, persist = true): Outcome => ({
  status: 'rejected',
  record,
  error: { code, message },
  persist,
});

// ---------------------------------------------------------------------------
// Veredicto de conflictos (§4.3)
// ---------------------------------------------------------------------------

/** Decide si una mutación sobre un registro VIVO `S` que SÍ cambia algo se
 * aplica o pierde. (El no-op y el tombstone se resuelven antes.) */
function decide(current: { updatedAt: Date }, m: SyncMutationInput, now: number): 'apply' | 'conflict' {
  const base = m.baseUpdatedAt ? new Date(m.baseUpdatedAt).getTime() : null;
  // El cliente conocía la versión vigente del servidor: se aplica sin comparar relojes.
  if (base !== null && current.updatedAt.getTime() <= base) return 'apply';
  // El servidor cambió después: gana el más reciente (reloj del cliente acotado).
  const clientClock = Math.min(new Date(m.clientUpdatedAt).getTime(), now + CLOCK_SKEW_MS);
  return clientClock > current.updatedAt.getTime() ? 'apply' : 'conflict';
}

/** Traduce un error de un service (AppError) al código del contrato. */
function toRejected(err: AppError): Outcome {
  let code = err.code;
  if (PASSTHROUGH_CODES.has(code)) return rejected(code, err.message);
  if (err.statusCode === 403) code = 'FORBIDDEN';
  else if (err.statusCode === 404) code = 'DEPENDENCY_NOT_FOUND';
  else if ((err.statusCode === 400 || err.statusCode === 422) && !PASSTHROUGH_CODES.has(code)) {
    code = 'INVALID_MUTATION';
  }
  return rejected(code, err.message);
}

// Códigos que el contrato define tal cual (§5.7) y deben llegar sin traducir.
const PASSTHROUGH_CODES = new Set([
  'COLUMN_WIP_LIMIT_REACHED',
  'CROSS_WORKSPACE_MOVE',
  'LIST_NAME_TAKEN',
  'LAST_LIST',
  'COLUMN_NOT_EMPTY',
  'ID_ALREADY_IN_USE',
  'WORKSPACE_LIMIT_REACHED',
]);

const invalid = (message: string): Outcome => rejected('INVALID_MUTATION', message);

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function listMutation(userId: string, m: SyncMutationInput, now: number): Promise<Outcome> {
  const personal = await ensurePersonalWorkspace(prisma, userId);
  const current = await prisma.board.findUnique({ where: { id: m.id } });
  // Un id que existe pero NO es una lista mía se trata como ajeno: nunca se
  // revela qué es ni de quién.
  const mine = current !== null && current.isList && current.workspaceId === personal.id;
  if (current && !mine) {
    return m.op === 'delete'
      ? applied(null)
      : rejected('ID_ALREADY_IN_USE', 'Ese identificador ya está en uso.');
  }

  const reread = async () => {
    const board = await prisma.board.findUniqueOrThrow({ where: { id: m.id } });
    return toSyncListDto(board);
  };
  /** La lista viva del usuario que ya usa ese nombre (para LIST_NAME_TAKEN). */
  const clashing = async (name: string) => {
    const board = await prisma.board.findFirst({
      where: { workspaceId: personal.id, isList: true, deletedAt: null, name: { equals: name }, id: { not: m.id } },
    });
    return board ? toSyncListDto(board) : null;
  };

  if (m.op === 'delete') {
    if (!current) return applied(null);
    if (current.deletedAt) return applied(toSyncListDto(current));
    if (decide(current, m, now) === 'conflict') return conflict(toSyncListDto(current));
    try {
      await listsService.deleteList(userId, m.id);
    } catch (err) {
      if (err instanceof AppError && err.code === 'LAST_LIST') {
        return rejected('LAST_LIST', err.message, toSyncListDto(current));
      }
      throw err;
    }
    return applied(await reread());
  }

  const parsed = listDataSchema.safeParse(m.data);
  if (!parsed.success) return invalid('Los datos de la lista no son válidos.');
  const data: ListData = parsed.data;

  if (!current) {
    try {
      await listsService.createList(userId, { id: m.id, name: data.name, position: data.position });
    } catch (err) {
      if (err instanceof AppError && err.code === 'LIST_NAME_TAKEN') {
        return rejected('LIST_NAME_TAKEN', err.message, await clashing(data.name));
      }
      throw err;
    }
    return applied(await reread());
  }

  // Un tombstone nunca se resucita.
  if (current.deletedAt) return conflict(toSyncListDto(current));
  // No-op: coincide con el servidor; no se toca updatedAt.
  if (current.name === data.name && current.listPosition === data.position) {
    return applied(toSyncListDto(current));
  }
  if (decide(current, m, now) === 'conflict') return conflict(toSyncListDto(current));

  try {
    await listsService.updateList(userId, m.id, {
      ...(current.name !== data.name ? { name: data.name } : {}),
      ...(current.listPosition !== data.position ? { position: data.position } : {}),
    });
  } catch (err) {
    if (err instanceof AppError && err.code === 'LIST_NAME_TAKEN') {
      return rejected('LIST_NAME_TAKEN', err.message, await clashing(data.name));
    }
    throw err;
  }
  return applied(await reread());
}

// ---------------------------------------------------------------------------
// task (H1: solo tareas de listas planas)
// ---------------------------------------------------------------------------

const TASK_INCLUDE = {
  column: { select: { boardId: true, board: { select: { workspaceId: true, isList: true } } } },
} satisfies Prisma.TaskInclude;

async function taskMutation(userId: string, m: SyncMutationInput, now: number): Promise<Outcome> {
  const personal = await ensurePersonalWorkspace(prisma, userId);
  const current = await prisma.task.findUnique({ where: { id: m.id }, include: TASK_INCLUDE });
  const mine =
    current !== null &&
    current.column.board.isList &&
    current.column.board.workspaceId === personal.id;
  if (current && !mine) {
    return m.op === 'delete'
      ? applied(null)
      : rejected('ID_ALREADY_IN_USE', 'Ese identificador ya está en uso.');
  }

  const reread = async () => {
    const task = await prisma.task.findUniqueOrThrow({ where: { id: m.id }, include: TASK_INCLUDE });
    return toSyncListTaskDto(task, task.column.boardId);
  };
  const currentDto = () => toSyncListTaskDto(current!, current!.column.boardId);

  if (m.op === 'delete') {
    if (!current) return applied(null);
    if (current.deletedAt) return applied(currentDto());
    if (decide(current, m, now) === 'conflict') return conflict(currentDto());
    await tasksService.deleteTask(m.id, userId);
    return applied(await reread());
  }

  const parsed = taskDataSchema.safeParse(m.data);
  if (!parsed.success) return invalid('Los datos de la tarea no son válidos.');
  const data: TaskData = parsed.data;

  // Un tombstone nunca se resucita (antes que cualquier otra comprobación: el
  // cliente debe enterarse de que la tarea ya no existe).
  if (current?.deletedAt) return conflict(currentDto());

  // Tareas de tablero (columnId): llegan con los hitos siguientes. No se
  // guarda el rechazo para que reenviarla cuando exista funcione.
  if (data.listId === null) {
    return rejected(
      'INVALID_MUTATION',
      'Las tareas de tablero todavía no se pueden sincronizar.',
      null,
      false,
    );
  }

  // La lista destino debe ser una lista VIVA mía.
  const list = await prisma.board.findFirst({
    where: { id: data.listId, isList: true, workspaceId: personal.id, deletedAt: null },
    include: { columns: { where: { deletedAt: null }, orderBy: { position: 'asc' }, take: 1 } },
  });
  const columnId = list?.columns[0]?.id;
  if (!list || !columnId) {
    return rejected('DEPENDENCY_NOT_FOUND', 'La lista de la tarea no existe.');
  }

  if (!current) {
    const created = await tasksService.createTask(userId, {
      id: m.id,
      columnId,
      title: data.title,
      description: data.description ?? undefined,
      dueAt: data.dueAt ?? undefined,
      assigneeId: data.assigneeId ?? undefined,
      priority: data.priority,
      completedAt: data.completedAt ?? undefined,
      repeatUnit: data.repeatUnit,
      repeatInterval: data.repeatInterval,
      repeatWeekdays: data.repeatWeekdays,
      repeatAnchorDay: data.repeatAnchorDay,
      repeatSuccessorId: data.repeatSuccessorId,
    });
    // createTask siempre añade al final; si el cliente pidió otra posición se
    // reordena con el mismo servicio que usa la API.
    if (created.value.position !== data.position) {
      await reorderBestEffort(m.id, userId, columnId, data.position);
    }
    return applied(await reread());
  }

  const sameState = isSameTask(current, list.id, data);
  if (sameState) return applied(currentDto());
  if (decide(current, m, now) === 'conflict') return conflict(currentDto());

  const patch = buildTaskPatch(current, data);
  if (Object.keys(patch).length > 0) {
    await tasksService.updateTask(m.id, userId, patch);
  }
  if (current.column.boardId !== list.id || current.position !== data.position) {
    await reorderBestEffort(m.id, userId, columnId, data.position);
  }
  return applied(await reread());
}

/** Segundo paso de una mutación de tarea (mover/reordenar). El primer paso ya
 * se confirmó en su propia transacción, así que si este falla con un 4xx NO se
 * puede devolver `rejected` (el cliente revertiría algo que el servidor sí
 * guardó). Se devuelve `applied` con el registro tal como quedó y el cliente
 * adopta la posición/lista reales del servidor. Los 5xx sí se relanzan. */
async function reorderBestEffort(
  taskId: string,
  userId: string,
  columnId: string,
  position: number,
): Promise<void> {
  try {
    await tasksService.moveTask(taskId, userId, { columnId, position });
  } catch (err) {
    if (!(err instanceof AppError) || err.statusCode >= 500) throw err;
  }
}

type TaskRow = NonNullable<Awaited<ReturnType<typeof prisma.task.findUnique>>> & {
  column: { boardId: string };
};

const sameDate = (a: Date | null, b: string | null): boolean =>
  (a?.getTime() ?? null) === (b === null ? null : new Date(b).getTime());

function isSameTask(current: TaskRow, listId: string, d: TaskData): boolean {
  return (
    current.column.boardId === listId &&
    current.title === d.title &&
    current.description === d.description &&
    current.priority === d.priority &&
    sameDate(current.dueAt, d.dueAt) &&
    current.assigneeId === d.assigneeId &&
    current.position === d.position &&
    sameDate(current.completedAt, d.completedAt) &&
    current.repeatUnit === d.repeatUnit &&
    current.repeatInterval === d.repeatInterval &&
    current.repeatWeekdays === d.repeatWeekdays &&
    current.repeatAnchorDay === d.repeatAnchorDay &&
    current.repeatSuccessorId === d.repeatSuccessorId
  );
}

/** Solo los campos que cambian: así no se disparan efectos de más (p. ej. la
 * notificación TASK_ASSIGNED solo sale si el responsable cambió de verdad). */
function buildTaskPatch(current: TaskRow, d: TaskData): UpdateTaskInput {
  const patch: UpdateTaskInput = {};
  if (current.title !== d.title) patch.title = d.title;
  if (current.description !== d.description) patch.description = d.description;
  if (current.priority !== d.priority) patch.priority = d.priority;
  if (!sameDate(current.dueAt, d.dueAt)) patch.dueAt = d.dueAt;
  if (current.assigneeId !== d.assigneeId) patch.assigneeId = d.assigneeId;
  if (!sameDate(current.completedAt, d.completedAt)) patch.completedAt = d.completedAt;
  const repeatChanged =
    current.repeatUnit !== d.repeatUnit ||
    current.repeatInterval !== d.repeatInterval ||
    current.repeatWeekdays !== d.repeatWeekdays ||
    current.repeatAnchorDay !== d.repeatAnchorDay;
  if (repeatChanged) {
    patch.repeatUnit = d.repeatUnit;
    patch.repeatInterval = d.repeatInterval;
    patch.repeatWeekdays = d.repeatWeekdays;
    patch.repeatAnchorDay = d.repeatAnchorDay;
  }
  if (current.repeatSuccessorId !== d.repeatSuccessorId) {
    patch.repeatSuccessorId = d.repeatSuccessorId;
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Motor: idempotencia, orden y aislamiento
// ---------------------------------------------------------------------------

const KNOWN_ENTITIES = new Set(['list', 'board', 'column', 'task', 'subtask', 'myDay', 'reminder']);

async function applyMutation(userId: string, m: SyncMutationInput, now: number): Promise<Outcome> {
  if (m.entity === 'list') return listMutation(userId, m, now);
  if (m.entity === 'task') return taskMutation(userId, m, now);
  if (KNOWN_ENTITIES.has(m.entity)) {
    // Entidad del contrato que este despliegue aún no implementa: no se anuncia
    // en supportedEntities y no se guarda el rechazo.
    return rejected('UNKNOWN_ENTITY', 'Esa entidad todavía no se puede sincronizar.', null, false);
  }
  return rejected('UNKNOWN_ENTITY', 'Entidad desconocida.');
}

const STATUS_DB: Record<SyncPushStatus, SyncMutationStatus> = {
  applied: 'APPLIED',
  conflict: 'CONFLICT',
  rejected: 'REJECTED',
};

async function processOne(userId: string, m: SyncMutationInput): Promise<SyncPushResult> {
  const stored = await prisma.syncMutation.findUnique({
    where: { userId_clientMutationId: { userId, clientMutationId: m.clientMutationId } },
  });
  if (stored) return stored.resultJson as unknown as SyncPushResult;

  let outcome: Outcome;
  try {
    outcome = await applyMutation(userId, m, Date.now());
  } catch (err) {
    // Un 4xx de un service es un rechazo PERMANENTE de esta mutación. Cualquier
    // otro error (5xx, base caída...) NO se guarda ni se devuelve como
    // `rejected`: se relanza y toda la petición responde 5xx; el reenvío
    // devolverá lo ya guardado y reintentará el resto (§5.2).
    if (err instanceof AppError && err.statusCode < 500) outcome = toRejected(err);
    else throw err;
  }

  const result: SyncPushResult = {
    clientMutationId: m.clientMutationId,
    status: outcome.status,
    record: outcome.record,
    ...(outcome.error ? { error: outcome.error } : {}),
  };
  if (outcome.persist === false) return result;

  try {
    await prisma.syncMutation.create({
      data: {
        userId,
        clientMutationId: m.clientMutationId,
        status: STATUS_DB[outcome.status],
        resultJson: result as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    // Petición gemela (mismo clientMutationId) que terminó antes: se devuelve su
    // resultado guardado. Los efectos ya eran idempotentes por id.
    if (!isUniqueConstraintError(err)) throw err;
    const twin = await prisma.syncMutation.findUnique({
      where: { userId_clientMutationId: { userId, clientMutationId: m.clientMutationId } },
    });
    if (twin) return twin.resultJson as unknown as SyncPushResult;
    throw err;
  }
  return result;
}

// Los lotes de un mismo usuario se procesan de uno en uno: dos pushes
// simultáneos (reintento + ciclo nuevo) no se entrelazan. Entre instancias no
// hace falta: la idempotencia por clientMutationId y las reglas por id cubren
// la carrera.
const userQueues = new Map<string, Promise<unknown>>();

function runExclusive<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const previous = userQueues.get(userId) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.catch(() => undefined);
  userQueues.set(userId, tail);
  void tail.then(() => {
    if (userQueues.get(userId) === tail) userQueues.delete(userId);
  });
  return next;
}

let lastPurge = 0;
/** Purga perezosa: sin worker ni cron, una vez por hora como mucho. */
function maybePurge(): void {
  const now = Date.now();
  if (now - lastPurge < PURGE_EVERY_MS) return;
  lastPurge = now;
  void prisma.syncMutation
    .deleteMany({ where: { createdAt: { lt: new Date(now - MUTATION_RETENTION_MS) } } })
    .catch(() => undefined);
}

async function push(userId: string, mutations: SyncMutationInput[]): Promise<SyncPushResponse> {
  maybePurge();
  const results = await runExclusive(userId, async () => {
    const out: SyncPushResult[] = [];
    for (const m of mutations) out.push(await processOne(userId, m));
    return out;
  });
  return {
    contractVersion: SYNC_CONTRACT_VERSION,
    serverTime: new Date().toISOString(),
    results,
  };
}

export const syncPushService = { push };

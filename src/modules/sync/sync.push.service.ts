import type { Prisma, SyncMutationStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import { isUniqueConstraintError } from '../../utils/idempotent-create';
import { boardMutation, columnMutation } from './sync.push.board';
import {
  toSyncBoardDto,
  toSyncColumnDto,
  toSyncListDto,
  toSyncMyDayDto,
  toSyncReminderDto,
  toSyncSubtaskDto,
  toSyncTaskDto,
} from './sync.mappers';
import { listMutation } from './sync.push.list';
import { myDayMutation } from './sync.push.myday';
import { reminderMutation } from './sync.push.reminder';
import { memberWorkspaceIds, rejected, toRejected, type Outcome } from './sync.push.shared';
import { subtaskMutation } from './sync.push.subtask';
import { taskMutation } from './sync.push.task';
import type { SyncMutationInput } from './sync.schema';
import {
  SYNC_CONTRACT_VERSION,
  type SyncPushResponse,
  type SyncPushResult,
  type SyncPushStatus,
} from './sync.types';

// Escritura por lotes para la app móvil (contrato v1.0, §5.2 y §5.4). NO
// reimplementa reglas: cada mutación llama a los services existentes, así que
// los permisos, el WIP, la repetición y las notificaciones son los de la API
// normal. Lo propio de este módulo es (1) la idempotencia por clientMutationId,
// (2) el veredicto de conflictos (sync.push.shared.ts) y (3) traducir errores
// de los services a `rejected`. Cada entidad vive en su archivo sync.push.*.ts.
//
// El cuerpo de las mutaciones NUNCA se registra en logs: son datos del usuario.

// Las mutaciones procesadas se conservan para reenvíos ≥ 30 días (§5.2).
const MUTATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ACCESS_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PURGE_EVERY_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Motor: idempotencia, orden y aislamiento
// ---------------------------------------------------------------------------

const KNOWN_ENTITIES = new Set(['list', 'board', 'column', 'task', 'subtask', 'myDay', 'reminder']);

async function applyMutation(userId: string, m: SyncMutationInput, now: number): Promise<Outcome> {
  switch (m.entity) {
    case 'list':
      return listMutation(userId, m, now);
    case 'board':
      return boardMutation(userId, m, now);
    case 'column':
      return columnMutation(userId, m, now);
    case 'task':
      return taskMutation(userId, m, now);
    case 'subtask':
      return subtaskMutation(userId, m, now);
    case 'myDay':
      return myDayMutation(userId, m, now);
    case 'reminder':
      return reminderMutation(userId, m, now);
  }
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

/** Registro vigente de `m.id` si existe y el usuario puede verlo (mismos
 * límites de visibilidad que el resto del push); `null` si no existe o es
 * ajeno, para no revelar su existencia. */
async function visibleRecord(userId: string, m: SyncMutationInput): Promise<unknown> {
  const memberOf = await memberWorkspaceIds(userId);
  switch (m.entity) {
    case 'task': {
      const task = await prisma.task.findUnique({
        where: { id: m.id },
        include: {
          column: {
            select: { boardId: true, board: { select: { workspaceId: true, isList: true } } },
          },
        },
      });
      if (!task || !memberOf.has(task.column.board.workspaceId)) return null;
      return toSyncTaskDto(task, { id: task.column.boardId, isList: task.column.board.isList });
    }
    case 'column': {
      const column = await prisma.column.findUnique({
        where: { id: m.id },
        include: { board: { select: { workspaceId: true, isList: true } } },
      });
      if (!column || column.board.isList || !memberOf.has(column.board.workspaceId)) return null;
      return toSyncColumnDto(column);
    }
    case 'board':
    case 'list': {
      const board = await prisma.board.findUnique({ where: { id: m.id } });
      if (!board || board.isList !== (m.entity === 'list') || !memberOf.has(board.workspaceId)) {
        return null;
      }
      return m.entity === 'list' ? toSyncListDto(board) : toSyncBoardDto(board);
    }
    case 'subtask': {
      const subtask = await prisma.subtask.findUnique({
        where: { id: m.id },
        include: {
          task: { select: { column: { select: { board: { select: { workspaceId: true } } } } } },
        },
      });
      if (!subtask || !memberOf.has(subtask.task.column.board.workspaceId)) return null;
      return toSyncSubtaskDto(subtask);
    }
    case 'reminder': {
      const reminder = await prisma.reminder.findUnique({
        where: { id: m.id },
        include: {
          task: { select: { column: { select: { board: { select: { workspaceId: true } } } } } },
        },
      });
      const mine =
        reminder !== null &&
        reminder.origin === 'MOBILE' &&
        reminder.createdById === userId &&
        memberOf.has(reminder.task.column.board.workspaceId);
      return mine ? toSyncReminderDto(reminder) : null;
    }
    case 'myDay': {
      const mark = await prisma.myDayTask.findUnique({
        where: { userId_taskId: { userId, taskId: m.id } },
      });
      return mark ? toSyncMyDayDto(mark) : null;
    }
    default:
      return null;
  }
}

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
    if (err instanceof AppError && err.statusCode < 500) {
      outcome = toRejected(err);
      // §5.2: si la entidad ya existe y el usuario la ve, el rechazo trae el
      // registro vigente para que el cliente revierta.
      if (outcome.record === null) outcome.record = await visibleRecord(userId, m);
    } else throw err;
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
  // Los eventos de acceso viven tanto como el cursor de sync (90 días).
  void prisma.accessEvent
    .deleteMany({ where: { createdAt: { lt: new Date(now - ACCESS_EVENT_RETENTION_MS) } } })
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

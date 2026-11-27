import type { Prisma, SyncMutationStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import { isUniqueConstraintError } from '../../utils/idempotent-create';
import { boardMutation, columnMutation } from './sync.push.board';
import { listMutation } from './sync.push.list';
import { myDayMutation } from './sync.push.myday';
import { reminderMutation } from './sync.push.reminder';
import { rejected, toRejected, type Outcome } from './sync.push.shared';
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

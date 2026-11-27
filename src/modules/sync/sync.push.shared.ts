import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import type { SyncMutationInput } from './sync.schema';
import type { SyncPushStatus } from './sync.types';

// Piezas comunes de las mutaciones de `push` (contrato v1.0 §4 y §5.7).

// Tope de adelanto del reloj del cliente (§4.3.3): un dispositivo con la hora
// muy adelantada no puede "ganar" siempre.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
export interface Outcome {
  status: SyncPushStatus;
  record: unknown;
  error?: { code: string; message: string };
  /** false = no se guarda en SyncMutation (la mutación aún no es procesable en
   * este despliegue; reenviarla más adelante debe poder funcionar). */
  persist?: boolean;
}

export const applied = (record: unknown): Outcome => ({ status: 'applied', record });
export const conflict = (record: unknown): Outcome => ({ status: 'conflict', record });
export const rejected = (code: string, message: string, record: unknown = null, persist = true): Outcome => ({
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
export function decide(current: { updatedAt: Date }, m: SyncMutationInput, now: number): 'apply' | 'conflict' {
  const base = m.baseUpdatedAt ? new Date(m.baseUpdatedAt).getTime() : null;
  // El cliente conocía la versión vigente del servidor: se aplica sin comparar relojes.
  if (base !== null && current.updatedAt.getTime() <= base) return 'apply';
  // El servidor cambió después: gana el más reciente (reloj del cliente acotado).
  const clientClock = Math.min(new Date(m.clientUpdatedAt).getTime(), now + CLOCK_SKEW_MS);
  return clientClock > current.updatedAt.getTime() ? 'apply' : 'conflict';
}

/** Traduce un error de un service (AppError) al código del contrato. */
export function toRejected(err: AppError): Outcome {
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

export const invalid = (message: string): Outcome => rejected('INVALID_MUTATION', message);


export const sameDate = (a: Date | null, b: string | null): boolean =>
  (a?.getTime() ?? null) === (b === null ? null : new Date(b).getTime());

/** Segundo paso de una mutación (reordenar/mover dentro del mismo contenedor).
 * El primer paso ya se confirmó en su propia transacción, así que si este falla
 * con un 4xx NO se puede devolver `rejected` (el cliente revertiría algo que el
 * servidor sí guardó): se ignora y el `record` devuelto trae la posición real.
 * Los 5xx sí se relanzan. */
export async function bestEffort(step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (err) {
    if (!(err instanceof AppError) || err.statusCode >= 500) throw err;
  }
}

/** Ids de los workspaces VIVOS donde el usuario es miembro. Es el límite de
 * visibilidad de la sync: un id de tablero, columna, tarea o subtarea que
 * pertenezca a otro workspace se trata como ajeno (nunca se revela). Los
 * permisos de ESCRITURA (rol) los siguen aplicando los services. */
export async function memberWorkspaceIds(userId: string): Promise<Set<string>> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId, workspace: { deletedAt: null } },
    select: { workspaceId: true },
  });
  return new Set(memberships.map((m) => m.workspaceId));
}

/** La tarea sobre la que cuelga una marca de Mi día o un recordatorio: debe ser
 * una tarea VIVA de un tablero vivo de un workspace donde soy miembro. Si no
 * existe o no la veo, DEPENDENCY_NOT_FOUND. Devuelve null cuando es válida. */
export async function checkVisibleTask(userId: string, taskId: string): Promise<Outcome | null> {
  const task = await prisma.task.findFirst({
    where: {
      id: taskId,
      deletedAt: null,
      column: {
        deletedAt: null,
        board: {
          deletedAt: null,
          workspace: { deletedAt: null, members: { some: { userId } } },
        },
      },
    },
    select: { id: true },
  });
  return task ? null : rejected('DEPENDENCY_NOT_FOUND', 'La tarea no existe.');
}

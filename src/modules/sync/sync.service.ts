import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import { ensurePersonalWorkspace } from '../workspaces/personal-workspace';
import {
  toSyncBoardDto,
  toSyncColumnDto,
  toSyncListDto,
  toSyncSubtaskDto,
  toSyncTaskDto,
  toSyncWorkspaceDto,
} from './sync.mappers';
import {
  SYNC_CONTRACT_VERSION,
  type SyncChangeKey,
  type SyncChanges,
  type SyncChangesResponse,
  type SyncEntityName,
} from './sync.types';

// Lectura incremental para la app móvil offline-first (contrato v1.0, ver
// docs/backend-spec-movil.md §5.1). Solo lectura, así que no escribe en AuditLog.
//
// Permisos: requireAuth solo resuelve identidad. TODA consulta se acota por lo
// que el usuario autenticado puede ver y no existe ningún filtro controlado por
// el cliente: lo único que aporta es el cursor, que solo decide DESDE DÓNDE leer
// dentro de lo que ya es suyo. Un cursor manipulado nunca abre datos ajenos.
//
// Entrega por hitos (§8): solo se emiten las entidades de SUPPORTED_ENTITIES.
// Una entidad no implementada no devuelve datos parciales: sale vacía y no se
// anuncia en `supportedEntities`.

/** Entidades que este servidor implementa COMPLETAS. H2: listas, tableros,
 * columnas, tareas y subtareas del workspace Personal. */
export const SUPPORTED_ENTITIES: SyncEntityName[] = ['list', 'board', 'column', 'task', 'subtask'];

// Horizonte de estabilidad. Solo se sirven filas con updatedAt <= ahora - margen.
// `updatedAt` lo fija la escritura pero la fila solo es visible al COMMIT: una
// transacción lenta puede confirmar DESPUÉS de que el cliente avanzó su cursor
// más allá de ese updatedAt, y esa fila quedaría "detrás" y no se enviaría
// nunca. Con el margen el cursor no rebasa instantes que aún podrían recibir
// filas por commits tardíos. Una transacción más lenta que el margen sigue
// siendo un riesgo teórico; 3 s cubre de sobra las del API.
const SYNC_SETTLE_MS = 3000;

// Un cursor más viejo que esto responde INVALID_CURSOR (el cliente recarga el
// snapshot): los tombstones se conservan al menos tanto tiempo.
const CURSOR_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

// Rango fijo de cada entidad: desempata registros con el mismo milisegundo y
// garantiza padres antes que hijos dentro de la página (§5.1).
const RANK: Record<SyncChangeKey, number> = {
  workspaces: 1,
  boardAccess: 2,
  boards: 3,
  lists: 4,
  columns: 5,
  tasks: 6,
  subtasks: 7,
  myDay: 8,
  reminders: 9,
};
const MAX_RANK = 9;
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

function invalidCursor(): AppError {
  return new AppError(400, 'INVALID_CURSOR', 'El cursor no es válido.');
}

// ---------------------------------------------------------------------------
// Cursor opaco: base64url de JSON {t: ISO UTC, r: rango, i: id, s: 0|1}
// `s` = 1 mientras el flujo es un snapshot sin terminar.
// ---------------------------------------------------------------------------

interface Cursor {
  t: Date;
  r: number;
  i: string;
  s: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// base64url estricto: Buffer.from(..., 'base64url') ignora caracteres ajenos al
// alfabeto en silencio y un cursor con basura no debería aceptarse.
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function encodeCursor(c: Cursor): string {
  return Buffer.from(
    JSON.stringify({ t: c.t.toISOString(), r: c.r, i: c.i, s: c.s ? 1 : 0 }),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(raw: string, now: number): Cursor {
  if (!BASE64URL_RE.test(raw)) throw invalidCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalidCursor();
  const { t, r, i, s } = parsed as { t?: unknown; r?: unknown; i?: unknown; s?: unknown };
  if (typeof t !== 'string' || typeof i !== 'string' || !UUID_RE.test(i)) throw invalidCursor();
  if (typeof r !== 'number' || !Number.isInteger(r) || r < 0 || r > MAX_RANK) throw invalidCursor();
  if (s !== 0 && s !== 1) throw invalidCursor();
  const date = new Date(t);
  // El round-trip exige exactamente el formato que emitimos (toISOString).
  if (Number.isNaN(date.getTime()) || date.toISOString() !== t) throw invalidCursor();
  // Un cursor del futuro o más viejo que el horizonte de tombstones no sirve.
  if (date.getTime() > now + SYNC_SETTLE_MS || now - date.getTime() > CURSOR_MAX_AGE_MS) {
    throw invalidCursor();
  }
  return { t: date, r, i: i.toLowerCase(), s: s === 1 };
}

/** Filas estrictamente DESPUÉS del cursor en el orden (updatedAt, rango, id) y
 * dentro del horizonte de estabilidad, para una entidad de rango `rank`. */
function seekFor(cursor: Cursor | null, rank: number, horizon: Date) {
  if (!cursor) return { updatedAt: { lte: horizon } };
  const after =
    rank > cursor.r
      ? [{ updatedAt: { gt: cursor.t } }, { updatedAt: cursor.t }]
      : rank === cursor.r
        ? [{ updatedAt: { gt: cursor.t } }, { updatedAt: cursor.t, id: { gt: cursor.i } }]
        : [{ updatedAt: { gt: cursor.t } }];
  return { AND: [{ updatedAt: { lte: horizon } }, { OR: after }] };
}

// Fila ya mapeada a DTO y etiquetada con su entidad, lista para la mezcla.
interface Tagged {
  key: SyncChangeKey;
  updatedAt: Date;
  id: string;
  dto: unknown;
}

function compareTagged(a: Tagged, b: Tagged): number {
  const byDate = a.updatedAt.getTime() - b.updatedAt.getTime();
  if (byDate !== 0) return byDate;
  const byRank = RANK[a.key] - RANK[b.key];
  if (byRank !== 0) return byRank;
  // Comparación ordinal (no localeCompare): los ids se guardan en minúscula.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const ORDER = [{ updatedAt: 'asc' as const }, { id: 'asc' as const }];

async function getChanges(
  userId: string,
  rawCursor: string | undefined,
  limit: number,
): Promise<SyncChangesResponse> {
  const now = Date.now();
  const cursor = rawCursor === undefined ? null : decodeCursor(rawCursor, now);
  const horizon = new Date(now - SYNC_SETTLE_MS);
  // Una carga sin cursor es un snapshot; sus páginas siguientes lo siguen siendo
  // hasta la que trae hasMore = false.
  const isSnapshot = cursor === null || cursor.s;
  // limit + 1 por entidad: la fila extra solo sirve para saber si hay más.
  const take = limit + 1;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'La sesión no es válida.');

  // H2: todo el alcance es el workspace Personal del propio usuario (listas,
  // tableros, columnas, tareas y subtareas). Los workspaces compartidos llegan
  // con H5.
  const personal = await ensurePersonalWorkspace(prisma, userId);
  // Tableros/listas vivos del Personal: bajo un tablero borrado, su tombstone
  // basta para que el cliente retire columnas y tareas (§4.8).
  const liveBoard = { workspaceId: personal.id, deletedAt: null };
  const taskScope = { column: { board: liveBoard } };

  const [workspaces, boards, lists, columns, tasks, subtasks] = await Promise.all([
    prisma.workspace.findMany({
      where: { AND: [seekFor(cursor, RANK.workspaces, horizon), { id: personal.id }] },
      orderBy: ORDER,
      take,
    }),
    // Tableros normales del usuario, borrados incluidos (tombstone).
    prisma.board.findMany({
      where: {
        AND: [
          seekFor(cursor, RANK.boards, horizon),
          { workspaceId: personal.id, isList: false },
        ],
      },
      orderBy: ORDER,
      take,
    }),
    // Listas del usuario, borradas incluidas (tombstone).
    prisma.board.findMany({
      where: {
        AND: [seekFor(cursor, RANK.lists, horizon), { workspaceId: personal.id, isList: true }],
      },
      orderBy: ORDER,
      take,
    }),
    // Columnas de tableros normales vivos (la columna interna de una lista
    // NUNCA se expone). Las borradas llegan como tombstone.
    prisma.column.findMany({
      where: {
        AND: [seekFor(cursor, RANK.columns, horizon), { board: { ...liveBoard, isList: false } }],
      },
      orderBy: ORDER,
      take,
    }),
    // Tareas de tableros y de listas vivos, borradas incluidas (tombstone).
    prisma.task.findMany({
      where: { AND: [seekFor(cursor, RANK.tasks, horizon), taskScope] },
      include: { column: { select: { boardId: true, board: { select: { isList: true } } } } },
      orderBy: ORDER,
      take,
    }),
    // Subtareas de tareas VIVAS (si la tarea se borra, su tombstone basta).
    prisma.subtask.findMany({
      where: {
        AND: [seekFor(cursor, RANK.subtasks, horizon), { task: { ...taskScope, deletedAt: null } }],
      },
      orderBy: ORDER,
      take,
    }),
  ]);

  const tag = (key: SyncChangeKey, r: { id: string; updatedAt: Date }, dto: unknown): Tagged => ({
    key,
    updatedAt: r.updatedAt,
    id: r.id,
    dto,
  });

  const merged: Tagged[] = [
    // El personal siempre es del propio usuario, con rol OWNER.
    ...workspaces.map((r) => tag('workspaces', r, toSyncWorkspaceDto(r, 'OWNER'))),
    ...boards.map((r) => tag('boards', r, toSyncBoardDto(r))),
    ...lists.map((r) => tag('lists', r, toSyncListDto(r))),
    ...columns.map((r) => tag('columns', r, toSyncColumnDto(r))),
    ...tasks.map((r) =>
      tag('tasks', r, toSyncTaskDto(r, { id: r.column.boardId, isList: r.column.board.isList })),
    ),
    ...subtasks.map((r) => tag('subtasks', r, toSyncSubtaskDto(r))),
  ];

  merged.sort(compareTagged);
  const served = merged.slice(0, limit);

  // Hay más si la mezcla excedió el límite, o si alguna entidad llenó su
  // ventana de limit + 1 (pudo quedarse con filas fuera de la consulta).
  const hasMore = merged.length > limit || [workspaces, boards, lists, columns, tasks, subtasks].some((rows) => rows.length > limit);

  // Con hasMore el cursor avanza hasta la última fila SERVIDA. Sin hasMore todo
  // lo anterior al horizonte ya se sirvió, así que el cursor salta al horizonte
  // (rango y id máximos para no repetir lo de ese milisegundo): evita rescanear
  // y mantiene joven el cursor de una cuenta inactiva.
  const last = served[served.length - 1];
  const nextCursor = encodeCursor(
    hasMore && last
      ? { t: last.updatedAt, r: RANK[last.key], i: last.id, s: isSnapshot }
      : { t: horizon, r: MAX_RANK, i: MAX_UUID, s: false },
  );

  const changes: SyncChanges = {
    workspaces: [],
    boardAccess: [],
    boards: [],
    lists: [],
    columns: [],
    tasks: [],
    subtasks: [],
    myDay: [],
    reminders: [],
  };
  for (const row of served) {
    // El tipo de `dto` coincide con el de su clave por construcción (arriba).
    (changes[row.key] as unknown[]).push(row.dto);
  }

  return {
    contractVersion: SYNC_CONTRACT_VERSION,
    supportedEntities: SUPPORTED_ENTITIES,
    me: { userId },
    serverTime: new Date(now).toISOString(),
    isSnapshot,
    changes,
    nextCursor,
    hasMore,
  };
}

export const syncService = {
  getChanges,
};

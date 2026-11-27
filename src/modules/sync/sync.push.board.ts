import { prisma } from '../../config/prisma';
import { boardsService } from '../boards/boards.service';
import { toSyncBoardDto, toSyncColumnDto } from './sync.mappers';
import {
  applied,
  bestEffort,
  conflict,
  decide,
  invalid,
  memberWorkspaceIds,
  rejected,
  type Outcome,
} from './sync.push.shared';
import {
  boardDataSchema,
  columnDataSchema,
  type BoardData,
  type ColumnData,
  type SyncMutationInput,
} from './sync.schema';

// Mutaciones de `board` y `column` (contrato §5.4): tableros de cualquier
// workspace donde soy miembro. Todo pasa por boardsService, que aplica los
// mismos permisos y reglas que la API normal (solo OWNER/ADMIN gestionan).

// ---------------------------------------------------------------------------
// board
// ---------------------------------------------------------------------------

export async function boardMutation(
  userId: string,
  m: SyncMutationInput,
  now: number,
): Promise<Outcome> {
  const memberOf = await memberWorkspaceIds(userId);
  const current = await prisma.board.findUnique({ where: { id: m.id } });
  // Un id que existe pero no es un tablero normal de un workspace donde soy
  // miembro es ajeno (incluye las listas: se gestionan solo como `list`).
  const mine = current !== null && !current.isList && memberOf.has(current.workspaceId);
  if (current && !mine) {
    return m.op === 'delete'
      ? applied(null)
      : rejected('ID_ALREADY_IN_USE', 'Ese identificador ya está en uso.');
  }

  const reread = async () =>
    toSyncBoardDto(await prisma.board.findUniqueOrThrow({ where: { id: m.id } }));

  if (m.op === 'delete') {
    if (!current) return applied(null);
    if (current.deletedAt) return applied(toSyncBoardDto(current));
    if (decide(current, m, now) === 'conflict') return conflict(toSyncBoardDto(current));
    await boardsService.deleteBoard(current.workspaceId, m.id, userId);
    return applied(await reread());
  }

  const parsed = boardDataSchema.safeParse(m.data);
  if (!parsed.success) return invalid('Los datos del tablero no son válidos.');
  const data: BoardData = parsed.data;

  if (!current) {
    // El workspace del tablero nuevo debe ser uno donde soy miembro (el rol
    // OWNER/ADMIN lo exige el service: FORBIDDEN si no).
    if (!memberOf.has(data.workspaceId)) {
      return rejected('DEPENDENCY_NOT_FOUND', 'El workspace del tablero no existe.');
    }
    await boardsService.createBoard(data.workspaceId, userId, {
      id: m.id,
      name: data.name,
      columns: data.columns?.map((c) => ({
        id: c.id,
        name: c.name,
        position: c.position,
        wipLimit: c.wipLimit ?? null,
        isDoneColumn: c.isDoneColumn,
      })),
    });
    const board = await reread();
    const columns = await prisma.column.findMany({
      where: { boardId: m.id, deletedAt: null },
      orderBy: { position: 'asc' },
    });
    return applied({ ...board, columns: columns.map(toSyncColumnDto) });
  }

  // El tablero no se puede cambiar de workspace por sync.
  if (data.workspaceId !== current.workspaceId) {
    return invalid('No se puede cambiar el workspace de un tablero.');
  }
  // Un tombstone nunca se resucita.
  if (current.deletedAt) return conflict(toSyncBoardDto(current));
  if (current.name === data.name) return applied(toSyncBoardDto(current));
  if (decide(current, m, now) === 'conflict') return conflict(toSyncBoardDto(current));

  await boardsService.updateBoard(current.workspaceId, m.id, userId, { name: data.name });
  return applied(await reread());
}

// ---------------------------------------------------------------------------
// column
// ---------------------------------------------------------------------------

export async function columnMutation(
  userId: string,
  m: SyncMutationInput,
  now: number,
): Promise<Outcome> {
  const memberOf = await memberWorkspaceIds(userId);
  const current = await prisma.column.findUnique({
    where: { id: m.id },
    include: { board: { select: { workspaceId: true, isList: true } } },
  });
  // La columna interna de una lista nunca es visible como `column`.
  const mine =
    current !== null && !current.board.isList && memberOf.has(current.board.workspaceId);
  if (current && !mine) {
    return m.op === 'delete'
      ? applied(null)
      : rejected('ID_ALREADY_IN_USE', 'Ese identificador ya está en uso.');
  }

  const reread = async () =>
    toSyncColumnDto(await prisma.column.findUniqueOrThrow({ where: { id: m.id } }));

  if (m.op === 'delete') {
    if (!current) return applied(null);
    if (current.deletedAt) return applied(toSyncColumnDto(current));
    if (decide(current, m, now) === 'conflict') return conflict(toSyncColumnDto(current));
    try {
      await boardsService.deleteColumn(current.board.workspaceId, current.boardId, m.id, userId);
    } catch (err) {
      // COLUMN_NOT_EMPTY: se devuelve la columna vigente para que el cliente la adopte.
      if (isColumnNotEmpty(err)) {
        return rejected('COLUMN_NOT_EMPTY', (err as Error).message, toSyncColumnDto(current));
      }
      throw err;
    }
    return applied(await reread());
  }

  const parsed = columnDataSchema.safeParse(m.data);
  if (!parsed.success) return invalid('Los datos de la columna no son válidos.');
  const data: ColumnData = parsed.data;

  if (!current) {
    // El tablero debe ser un tablero normal vivo de un workspace donde soy miembro.
    const board = await prisma.board.findFirst({
      where: {
        id: data.boardId,
        workspaceId: { in: [...memberOf] },
        isList: false,
        deletedAt: null,
      },
      select: { id: true, workspaceId: true },
    });
    if (!board) return rejected('DEPENDENCY_NOT_FOUND', 'El tablero de la columna no existe.');

    const created = await boardsService.createColumn(board.workspaceId, board.id, userId, {
      id: m.id,
      name: data.name,
      wipLimit: data.wipLimit,
      isDoneColumn: data.isDoneColumn,
    });
    // createColumn añade al final; si el cliente pidió otra posición se reordena.
    if (created.value.position !== data.position) {
      await bestEffort(() =>
        boardsService.updateColumn(board.workspaceId, board.id, m.id, userId, {
          position: data.position,
        }),
      );
    }
    return applied(await reread());
  }

  if (data.boardId !== current.boardId) {
    return invalid('No se puede mover una columna a otro tablero.');
  }
  // Un tombstone nunca se resucita.
  if (current.deletedAt) return conflict(toSyncColumnDto(current));

  const same =
    current.name === data.name &&
    current.position === data.position &&
    current.wipLimit === data.wipLimit &&
    current.isDoneColumn === data.isDoneColumn;
  if (same) return applied(toSyncColumnDto(current));
  if (decide(current, m, now) === 'conflict') return conflict(toSyncColumnDto(current));

  await boardsService.updateColumn(current.board.workspaceId, current.boardId, m.id, userId, {
    ...(current.name !== data.name ? { name: data.name } : {}),
    ...(current.position !== data.position ? { position: data.position } : {}),
    ...(current.wipLimit !== data.wipLimit ? { wipLimit: data.wipLimit } : {}),
    ...(current.isDoneColumn !== data.isDoneColumn ? { isDoneColumn: data.isDoneColumn } : {}),
  });
  return applied(await reread());
}

function isColumnNotEmpty(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'COLUMN_NOT_EMPTY';
}

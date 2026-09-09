import { randomBytes } from 'node:crypto';
import type { WorkspaceMember, WorkspaceRole } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import type { CreateBoardInput, CreateColumnInput, UpdateBoardInput, UpdateColumnInput } from './boards.schema';
import type { BoardDetailDto, BoardDto, ColumnDto } from './boards.types';

// Roles con permiso para crear/renombrar/borrar boards y columnas — ver
// docs/02-modelo-datos.md, sección WorkspaceMember. EDITOR puede tocar Task
// dentro de columnas ya existentes, pero no boards/columnas.
const OWNER_LIKE_ROLES: WorkspaceRole[] = ['OWNER', 'ADMIN'];

// Columnas predefinidas con las que nace todo Board nuevo — ver
// docs/07-alcance-mvp.md, sección "Kanban". No se le pregunta al usuario cómo
// quiere empezar; puede agregar/reordenar columnas después.
const DEFAULT_COLUMN_NAMES = ['Por hacer', 'En progreso', 'Hecho'];

function toBoardDto(board: {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}): BoardDto {
  return {
    id: board.id,
    workspaceId: board.workspaceId,
    name: board.name,
    slug: board.slug,
    createdAt: board.createdAt.toISOString(),
    updatedAt: board.updatedAt.toISOString(),
  };
}

function toColumnDto(column: {
  id: string;
  boardId: string;
  name: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}): ColumnDto {
  return {
    id: column.id,
    boardId: column.boardId,
    name: column.name,
    position: column.position,
    createdAt: column.createdAt.toISOString(),
    updatedAt: column.updatedAt.toISOString(),
  };
}

/** Convierte un nombre en un slug URL-safe — mismo algoritmo que
 * workspaces.service.ts (duplicado a propósito, ver comentario ahí sobre
 * mover esto a un helper compartido si un tercer módulo lo necesita). */
const DIACRITICS_PATTERN = /[̀-ͯ]/g;

function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(DIACRITICS_PATTERN, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
}

const SLUG_COLLISION_MAX_ATTEMPTS = 5;

/** Genera un slug único a partir de `name`, resolviendo colisiones dentro del
 * mismo workspace (el slug de Board es único por workspace, no globalmente —
 * ver `@@unique([workspaceId, slug])` en schema.prisma). */
async function generateUniqueSlug(workspaceId: string, name: string): Promise<string> {
  const base = slugify(name) || 'board';

  for (let attempt = 0; attempt < SLUG_COLLISION_MAX_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
    const existing = await prisma.board.findUnique({
      where: { workspaceId_slug: { workspaceId, slug: candidate } },
    });
    if (!existing) {
      return candidate;
    }
  }

  throw new AppError(
    500,
    'SLUG_GENERATION_FAILED',
    'No se pudo generar un identificador único para el board. Intenta de nuevo.',
  );
}

/** Busca la membresía de `userId` en `workspaceId`, o null si no existe. */
function getMembership(workspaceId: string, userId: string): Promise<WorkspaceMember | null> {
  return prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
}

/** Resuelve el workspace (no borrado) y la membresía del usuario autenticado
 * a la vez. Si el workspace no existe, está soft-deleted, o el usuario no es
 * miembro, lanza 404 uniforme — mismo criterio que workspaces.service.ts. */
async function requireMembership(workspaceId: string, userId: string) {
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
  });

  if (!workspace) {
    throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'El workspace no existe.');
  }

  const membership = await getMembership(workspaceId, userId);
  if (!membership) {
    throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'El workspace no existe.');
  }

  return { workspace, membership };
}

function requireOwnerOrAdmin(membership: WorkspaceMember) {
  if (!OWNER_LIKE_ROLES.includes(membership.role)) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'Solo el propietario o un administrador del workspace pueden gestionar boards y columnas.',
    );
  }
}

/** Resuelve un board no borrado dentro del workspace dado, o 404 uniforme —
 * no distingue "no existe" de "pertenece a otro workspace/está borrado". */
async function requireBoard(workspaceId: string, boardId: string) {
  const board = await prisma.board.findFirst({
    where: { id: boardId, workspaceId, deletedAt: null },
  });

  if (!board) {
    throw new AppError(404, 'BOARD_NOT_FOUND', 'El board no existe.');
  }

  return board;
}

async function createBoard(
  workspaceId: string,
  userId: string,
  input: CreateBoardInput,
): Promise<BoardDto> {
  const { membership } = await requireMembership(workspaceId, userId);
  requireOwnerOrAdmin(membership);

  const slug = await generateUniqueSlug(workspaceId, input.name);

  const board = await prisma.$transaction(async (tx) => {
    const createdBoard = await tx.board.create({
      data: { workspaceId, name: input.name, slug },
    });

    // Siembra las columnas predefinidas en la misma transacción — un Board
    // nunca existe sin ellas (ver docs/07-alcance-mvp.md).
    await tx.column.createMany({
      data: DEFAULT_COLUMN_NAMES.map((name, position) => ({
        boardId: createdBoard.id,
        name,
        position,
      })),
    });

    return createdBoard;
  });

  return toBoardDto(board);
}

async function listBoards(workspaceId: string, userId: string): Promise<BoardDto[]> {
  await requireMembership(workspaceId, userId);

  const boards = await prisma.board.findMany({
    where: { workspaceId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });

  return boards.map(toBoardDto);
}

async function getBoardById(
  workspaceId: string,
  boardId: string,
  userId: string,
): Promise<BoardDetailDto> {
  await requireMembership(workspaceId, userId);
  const board = await requireBoard(workspaceId, boardId);

  const columns = await prisma.column.findMany({
    where: { boardId: board.id },
    orderBy: { position: 'asc' },
    include: {
      tasks: {
        where: { deletedAt: null },
        orderBy: { position: 'asc' },
      },
    },
  });

  return {
    ...toBoardDto(board),
    columns: columns.map((column) => ({
      ...toColumnDto(column),
      tasks: column.tasks.map((task) => ({
        id: task.id,
        columnId: task.columnId,
        title: task.title,
        description: task.description,
        dueAt: task.dueAt ? task.dueAt.toISOString() : null,
        position: task.position,
        assigneeId: task.assigneeId,
      })),
    })),
  };
}

async function updateBoard(
  workspaceId: string,
  boardId: string,
  userId: string,
  input: UpdateBoardInput,
): Promise<BoardDto> {
  const { membership } = await requireMembership(workspaceId, userId);
  requireOwnerOrAdmin(membership);
  await requireBoard(workspaceId, boardId);

  if (input.slug !== undefined) {
    const existing = await prisma.board.findUnique({
      where: { workspaceId_slug: { workspaceId, slug: input.slug } },
    });
    if (existing && existing.id !== boardId) {
      throw new AppError(409, 'SLUG_ALREADY_TAKEN', 'Ese identificador ya está en uso en este workspace.');
    }
  }

  const updated = await prisma.board.update({
    where: { id: boardId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
    },
  });

  return toBoardDto(updated);
}

async function deleteBoard(workspaceId: string, boardId: string, userId: string): Promise<void> {
  const { membership } = await requireMembership(workspaceId, userId);
  requireOwnerOrAdmin(membership);
  await requireBoard(workspaceId, boardId);

  await prisma.$transaction([
    // Soft delete — nunca DELETE directo (docs/02-modelo-datos.md).
    prisma.board.update({
      where: { id: boardId },
      data: { deletedAt: new Date() },
    }),
    // Evento de seguridad explícito en CLAUDE.md — se audita.
    prisma.auditLog.create({
      data: {
        userId,
        action: 'board.deleted',
        metadata: { workspaceId, boardId },
      },
    }),
  ]);
}

async function createColumn(
  workspaceId: string,
  boardId: string,
  userId: string,
  input: CreateColumnInput,
): Promise<ColumnDto> {
  const { membership } = await requireMembership(workspaceId, userId);
  requireOwnerOrAdmin(membership);
  await requireBoard(workspaceId, boardId);

  const highestPosition = await prisma.column.aggregate({
    where: { boardId },
    _max: { position: true },
  });
  const nextPosition = (highestPosition._max.position ?? -1) + 1;

  const column = await prisma.column.create({
    data: { boardId, name: input.name, position: nextPosition },
  });

  return toColumnDto(column);
}

async function updateColumn(
  workspaceId: string,
  boardId: string,
  columnId: string,
  userId: string,
  input: UpdateColumnInput,
): Promise<ColumnDto> {
  const { membership } = await requireMembership(workspaceId, userId);
  requireOwnerOrAdmin(membership);
  await requireBoard(workspaceId, boardId);

  const column = await prisma.column.findFirst({ where: { id: columnId, boardId } });
  if (!column) {
    throw new AppError(404, 'COLUMN_NOT_FOUND', 'La columna no existe.');
  }

  if (input.position === undefined) {
    const updated = await prisma.column.update({
      where: { id: columnId },
      data: { name: input.name },
    });
    return toColumnDto(updated);
  }

  // Reacomoda el position de las demás columnas del mismo board de forma
  // consistente — mismo principio que el reordenamiento de Task en
  // tasks.service.ts (moveTask), aplicado a una sola lista en vez de dos.
  const siblings = await prisma.column.findMany({
    where: { boardId },
    orderBy: { position: 'asc' },
  });

  const withoutMoved = siblings.filter((sibling) => sibling.id !== columnId);
  const clampedPosition = Math.max(0, Math.min(input.position, withoutMoved.length));
  withoutMoved.splice(clampedPosition, 0, column);

  const results = await prisma.$transaction([
    ...withoutMoved.map((sibling, index) =>
      prisma.column.update({
        where: { id: sibling.id },
        data: { position: index },
      }),
    ),
    prisma.column.update({
      where: { id: columnId },
      data: { name: input.name ?? column.name, position: clampedPosition },
    }),
  ]);

  const updatedColumn = results[results.length - 1];
  return toColumnDto(updatedColumn);
}

async function deleteColumn(
  workspaceId: string,
  boardId: string,
  columnId: string,
  userId: string,
): Promise<void> {
  const { membership } = await requireMembership(workspaceId, userId);
  requireOwnerOrAdmin(membership);
  await requireBoard(workspaceId, boardId);

  const column = await prisma.column.findFirst({ where: { id: columnId, boardId } });
  if (!column) {
    throw new AppError(404, 'COLUMN_NOT_FOUND', 'La columna no existe.');
  }

  // Column no tiene deletedAt en el schema y su relación con Task usa
  // onDelete: Cascade a nivel de base de datos — si se permitiera borrar una
  // columna con tareas, el cascade borraría filas de Task físicamente sin
  // pasar por deletedAt, violando la regla de soft delete de CLAUDE.md.
  // Por eso se cuenta CUALQUIER Task de la columna, incluidas las ya
  // soft-deleted, y se bloquea el borrado si hay alguna — nunca se deja que
  // el cascade se dispare sobre nada.
  const taskCount = await prisma.task.count({ where: { columnId } });
  if (taskCount > 0) {
    throw new AppError(
      409,
      'COLUMN_NOT_EMPTY',
      'No puedes borrar una columna que todavía tiene tareas. Muévelas o bórralas primero.',
    );
  }

  // Hard delete real — Column no soporta soft delete en el schema actual.
  await prisma.column.delete({ where: { id: columnId } });
}

export const boardsService = {
  createBoard,
  listBoards,
  getBoardById,
  updateBoard,
  deleteBoard,
  createColumn,
  updateColumn,
  deleteColumn,
};

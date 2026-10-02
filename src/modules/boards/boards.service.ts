import { randomBytes } from 'node:crypto';
import type { WorkspaceMember, WorkspaceRole } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import { pushNotification } from '../notifications/notifications.stream';
import type {
  CreateBoardInput,
  CreateColumnInput,
  SetBoardMemberOverrideInput,
  UpdateBoardInput,
  UpdateColumnInput,
} from './boards.schema';
import type { BoardDetailDto, BoardDto, BoardMemberOverrideDto, ColumnDto } from './boards.types';

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
  wipLimit: number | null;
  createdAt: Date;
  updatedAt: Date;
}): ColumnDto {
  return {
    id: column.id,
    boardId: column.boardId,
    name: column.name,
    position: column.position,
    wipLimit: column.wipLimit,
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

function requireOwnerOrAdmin(role: WorkspaceRole) {
  if (!OWNER_LIKE_ROLES.includes(role)) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'Solo el propietario o un administrador pueden gestionar boards y columnas.',
    );
  }
}

/** Resuelve el rol EFECTIVO de un usuario en un board puntual — el rol de
 * `BoardMemberOverride` si existe uno para ese board, si no el rol crudo de
 * `WorkspaceMember`. Reemplaza (no combina) en ambas direcciones: puede
 * subir o bajar el rol respecto al de workspace (confirmado con el
 * usuario), y de facto habilita gestionar columnas/board en ese board
 * puntual si el override es a OWNER/ADMIN, aunque el rol de workspace sea
 * menor.
 *
 * NUNCA usar esto para decidir quién puede gestionar los overrides en sí —
 * ver setBoardMemberOverride/removeBoardMemberOverride/
 * listBoardMemberOverrides, que siempre usan `membership.role` crudo. Si se
 * usara acá, alguien con un override a OWNER en un board podría gestionar
 * overrides de otros usuarios en ese mismo board, escalando más allá de lo
 * que el verdadero OWNER/ADMIN del workspace autorizó. */
async function resolveEffectiveRole(
  boardId: string,
  membership: WorkspaceMember,
): Promise<WorkspaceRole> {
  const override = await prisma.boardMemberOverride.findUnique({
    where: { boardId_userId: { boardId, userId: membership.userId } },
  });
  return override?.role ?? membership.role;
}

function toBoardMemberOverrideDto(override: {
  id: string;
  boardId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: Date;
  updatedAt: Date;
}): BoardMemberOverrideDto {
  return {
    id: override.id,
    boardId: override.boardId,
    userId: override.userId,
    role: override.role,
    createdAt: override.createdAt.toISOString(),
    updatedAt: override.updatedAt.toISOString(),
  };
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
  // Sin resolveEffectiveRole acá — el board todavía no existe, no puede
  // haber un override sobre él. Crear boards siempre depende del rol de
  // workspace crudo.
  requireOwnerOrAdmin(membership.role);

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
  const { membership } = await requireMembership(workspaceId, userId);
  const board = await requireBoard(workspaceId, boardId);
  // El rol EFECTIVO de quien pide el detalle — el Frontend lo necesita para
  // saber qué botones mostrar en ESTE board puntual, que puede diferir del
  // rol de workspace si hay un BoardMemberOverride (ver resolveEffectiveRole
  // arriba). Nunca se expone el rol efectivo de OTRO usuario acá — cada
  // quien solo ve el suyo propio, resuelto contra su propia membership.
  const viewerEffectiveRole = await resolveEffectiveRole(board.id, membership);

  const columns = await prisma.column.findMany({
    where: { boardId: board.id },
    orderBy: { position: 'asc' },
    include: {
      tasks: {
        where: { deletedAt: null },
        orderBy: { position: 'asc' },
        include: {
          // Solo se necesita el booleano para contar hechos/total — traer
          // los subtasks completos de cada tarea del board de una vez es
          // barato (son listas chicas) y evita una request por tarjeta.
          subtasks: { select: { completed: true } },
        },
      },
    },
  });

  return {
    ...toBoardDto(board),
    viewerEffectiveRole,
    columns: columns.map((column) => ({
      ...toColumnDto(column),
      tasks: column.tasks.map((task) => ({
        id: task.id,
        columnId: task.columnId,
        title: task.title,
        description: task.description,
        dueAt: task.dueAt ? task.dueAt.toISOString() : null,
        priority: task.priority,
        position: task.position,
        assigneeId: task.assigneeId,
        subtaskTotal: task.subtasks.length,
        subtaskCompletado: task.subtasks.filter((s) => s.completed).length,
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
  await requireBoard(workspaceId, boardId);
  requireOwnerOrAdmin(await resolveEffectiveRole(boardId, membership));

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
  await requireBoard(workspaceId, boardId);
  requireOwnerOrAdmin(await resolveEffectiveRole(boardId, membership));

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
  await requireBoard(workspaceId, boardId);
  requireOwnerOrAdmin(await resolveEffectiveRole(boardId, membership));

  const highestPosition = await prisma.column.aggregate({
    where: { boardId },
    _max: { position: true },
  });
  const nextPosition = (highestPosition._max.position ?? -1) + 1;

  const column = await prisma.column.create({
    data: { boardId, name: input.name, position: nextPosition, wipLimit: input.wipLimit ?? null },
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
  await requireBoard(workspaceId, boardId);
  requireOwnerOrAdmin(await resolveEffectiveRole(boardId, membership));

  const column = await prisma.column.findFirst({ where: { id: columnId, boardId } });
  if (!column) {
    throw new AppError(404, 'COLUMN_NOT_FOUND', 'La columna no existe.');
  }

  if (input.position === undefined) {
    const updated = await prisma.column.update({
      where: { id: columnId },
      data: { name: input.name, wipLimit: input.wipLimit },
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
      data: {
        name: input.name ?? column.name,
        position: clampedPosition,
        wipLimit: input.wipLimit !== undefined ? input.wipLimit : column.wipLimit,
      },
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
  await requireBoard(workspaceId, boardId);
  requireOwnerOrAdmin(await resolveEffectiveRole(boardId, membership));

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

// --- Roles por tablero individual (overrides) ---

/** Más estricto que un simple requireOwnerOrAdmin(membership.role): exige
 * que quien gestiona overrides sea OWNER/ADMIN tanto en su rol de
 * workspace CRUDO (para que nadie escale vía un override propio, ver
 * resolveEffectiveRole) COMO en su rol EFECTIVO en este board puntual.
 * Ese segundo chequeo es lo que evita que un ADMIN real de workspace, a
 * quien OTRO admin restringió en este board puntual (override a
 * EDITOR/VIEWER), pueda usar su rol de workspace para revertir esa
 * restricción él mismo — confirmado con el usuario: si no tiene permiso
 * de ver/gestionar roles en ESTE board, no debe ver el panel siquiera. */
async function requireCanManageBoardOverrides(
  boardId: string,
  membership: WorkspaceMember,
): Promise<void> {
  requireOwnerOrAdmin(membership.role);
  requireOwnerOrAdmin(await resolveEffectiveRole(boardId, membership));
}

async function listBoardMemberOverrides(
  workspaceId: string,
  boardId: string,
  userId: string,
): Promise<BoardMemberOverrideDto[]> {
  const { membership } = await requireMembership(workspaceId, userId);
  await requireBoard(workspaceId, boardId);
  await requireCanManageBoardOverrides(boardId, membership);

  const overrides = await prisma.boardMemberOverride.findMany({ where: { boardId } });
  return overrides.map(toBoardMemberOverrideDto);
}

async function setBoardMemberOverride(
  workspaceId: string,
  boardId: string,
  targetUserId: string,
  userId: string,
  input: SetBoardMemberOverrideInput,
): Promise<BoardMemberOverrideDto> {
  const { membership } = await requireMembership(workspaceId, userId);
  const board = await requireBoard(workspaceId, boardId);
  await requireCanManageBoardOverrides(boardId, membership);

  // El destinatario del override debe ser miembro del mismo workspace — no
  // tiene sentido darle un rol efectivo en un board a alguien ajeno.
  const targetMembership = await getMembership(workspaceId, targetUserId);
  if (!targetMembership) {
    throw new AppError(
      422,
      'USER_NOT_WORKSPACE_MEMBER',
      'Esa persona debe ser miembro de este workspace.',
    );
  }

  const [override] = await prisma.$transaction([
    prisma.boardMemberOverride.upsert({
      where: { boardId_userId: { boardId, userId: targetUserId } },
      create: { boardId, userId: targetUserId, role: input.role },
      update: { role: input.role },
    }),
    // Evento de seguridad explícito en CLAUDE.md ("cambio de rol") — se
    // audita igual que deleteBoard/board.deleted arriba. Este override
    // puede llegar a dar de facto un rol OWNER/ADMIN sobre el board, así
    // que dejar rastro de quién se lo dio a quién es tan importante como
    // auditar un cambio de rol de workspace.
    prisma.auditLog.create({
      data: {
        userId,
        action: 'board_member_override.set',
        metadata: { workspaceId, boardId, targetUserId, role: input.role },
      },
    }),
  ]);

  // Notifica a la persona afectada — mismo motivo que en
  // workspaces.service.ts::updateMemberRole: sin esto, su rol efectivo en
  // este board cambiaba sin que se enterara si ya tenía el tablero abierto
  // (bug reportado por el usuario probando esta feature: dos pestañas
  // mostraban roles inconsistentes entre sí porque una de las dos nunca se
  // enteraba del cambio). Fuera de la transacción — best-effort.
  if (targetUserId !== userId) {
    const notification = await prisma.notification.create({
      data: {
        userId: targetUserId,
        type: 'ROLE_CHANGED',
        title: 'Tu rol en un tablero cambió',
        body: `Ahora sos ${input.role} en el tablero "${board.name}".`,
      },
    });
    pushNotification(notification);
  }

  return toBoardMemberOverrideDto(override);
}

async function removeBoardMemberOverride(
  workspaceId: string,
  boardId: string,
  targetUserId: string,
  userId: string,
): Promise<void> {
  const { membership } = await requireMembership(workspaceId, userId);
  const board = await requireBoard(workspaceId, boardId);
  await requireCanManageBoardOverrides(boardId, membership);

  // deleteMany (no delete) — quitar un override que ya no existe es un
  // no-op válido, no un error: el estado final deseado ("sin override para
  // este usuario en este board") ya se cumple. Se audita de todos modos,
  // incluso si no había nada que borrar — mismo criterio de "cambio de
  // rol" que setBoardMemberOverride arriba.
  await prisma.$transaction([
    prisma.boardMemberOverride.deleteMany({ where: { boardId, userId: targetUserId } }),
    prisma.auditLog.create({
      data: {
        userId,
        action: 'board_member_override.removed',
        metadata: { workspaceId, boardId, targetUserId },
      },
    }),
  ]);

  // Mismo motivo que en setBoardMemberOverride — notifica a la persona
  // afectada para que su pestaña abierta (si tiene una) se entere del
  // cambio en vez de quedar con un rol efectivo desactualizado.
  if (targetUserId !== userId) {
    const notification = await prisma.notification.create({
      data: {
        userId: targetUserId,
        type: 'ROLE_CHANGED',
        title: 'Tu rol en un tablero cambió',
        body: `Tu rol especial en el tablero "${board.name}" se quitó — volvés a tu rol de workspace ahí.`,
      },
    });
    pushNotification(notification);
  }
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
  listBoardMemberOverrides,
  setBoardMemberOverride,
  removeBoardMemberOverride,
  // Usado desde modules/tasks/tasks.service.ts para que la creación/edición/
  // movimiento de tareas también respete el rol efectivo por board, no solo
  // el de workspace — primer import entre módulos de dominio en el Backend,
  // deliberado: la lógica de permisos no se duplica (a diferencia de
  // slugify, que sí se duplica a propósito) porque un drift entre dos
  // copias de esta regla sería un bug de seguridad, no solo de estilo.
  resolveEffectiveRole,
};

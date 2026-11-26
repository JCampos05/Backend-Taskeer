import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import {
  idAlreadyInUseError,
  isUniqueConstraintError,
  type CreatedResult,
} from '../../utils/idempotent-create';
import { lockWorkspaceRow } from '../../utils/workspace-lock';
import { ensurePersonalWorkspace } from '../workspaces/personal-workspace';
import type { CreateListInput, UpdateListInput } from './lists.schema';
import type { ListDto } from './lists.types';

// Una "lista plana" de la app móvil (incluida la bandeja "Tareas") es un Board
// OCULTO (`isList`) de UNA sola columna dentro del workspace Personal del
// usuario. Este módulo es la única vía para gestionarlas; los endpoints de
// tableros/columnas no tocan boards con isList = true.
//
// Permisos: las listas viven SIEMPRE en el workspace Personal del propio
// usuario (él es su único miembro, OWNER), así que en vez de consultar
// WorkspaceMember se filtra por `workspace.ownerId = userId AND isPersonal`.
// Eso equivale a la verificación de membresía/rol: una lista ajena nunca
// aparece en ninguna consulta de este archivo, y por eso todo "no existe o no
// es tuya" responde un 404 uniforme que no revela listas de otros.

type Tx = Prisma.TransactionClient;

// Nombre y posición de la única columna de una lista. La columna es un detalle
// interno (el cliente solo necesita su id para colgar tareas de ella).
const LIST_COLUMN_NAME = 'Lista';

// El timeout por defecto de Prisma (5 s) se queda corto al borrar una lista con
// muchas tareas contra una base remota (un update por tarea, ver deleteList).
const TX_OPTIONS = { timeout: 30_000, maxWait: 5_000 };

function listNotFound(): AppError {
  return new AppError(404, 'LIST_NOT_FOUND', 'La lista no existe.');
}

function listNameTaken(): AppError {
  return new AppError(409, 'LIST_NAME_TAKEN', 'Ya tienes una lista con ese nombre.');
}

function toListDto(
  board: { id: string; name: string; listPosition: number; createdAt: Date; updatedAt: Date },
  columnId: string,
): ListDto {
  return {
    id: board.id,
    name: board.name,
    position: board.listPosition,
    columnId,
    createdAt: board.createdAt.toISOString(),
    updatedAt: board.updatedAt.toISOString(),
  };
}

/** Serializa las mutaciones de listas de un mismo usuario bloqueando la fila de
 * su workspace Personal (`SELECT ... FOR UPDATE`) hasta que termine la
 * transacción. Sin esto, dos peticiones simultáneas podrían: crear dos listas
 * con el mismo nombre (la unicidad se comprueba con una lectura, no con un
 * índice), dejar posiciones duplicadas, o borrar a la vez las dos últimas
 * listas saltándose LAST_LIST. Solo compiten peticiones del mismo usuario, así
 * que el costo es despreciable. Debe ser lo primero que hace la transacción. */
async function lockPersonalWorkspace(tx: Tx, workspaceId: string): Promise<void> {
  await lockWorkspaceRow(tx, workspaceId);
}

/** Columnas vivas de un board-lista. Siempre hay exactamente una (se crea junto
 * con la lista y la API no permite tocarla); si falta, es una inconsistencia de
 * datos y se falla en voz alta en vez de devolver una lista inutilizable. */
async function requireListColumnId(db: Tx | typeof prisma, boardId: string): Promise<string> {
  const column = await db.column.findFirst({
    where: { boardId, deletedAt: null },
    orderBy: { position: 'asc' },
    select: { id: true },
  });
  if (!column) {
    throw new AppError(500, 'LIST_WITHOUT_COLUMN', 'La lista está en un estado inconsistente.');
  }
  return column.id;
}

/** Resuelve una lista viva del usuario, o 404 uniforme (no distingue "no existe"
 * de "es de otro usuario", "ya está borrada" o "es un tablero normal"). */
async function requireOwnList(db: Tx | typeof prisma, userId: string, listId: string) {
  const board = await db.board.findFirst({
    where: {
      id: listId,
      isList: true,
      deletedAt: null,
      workspace: { ownerId: userId, isPersonal: true, deletedAt: null },
    },
  });
  if (!board) throw listNotFound();
  return board;
}

/** Listas vivas de un workspace Personal en su orden canónico: `listPosition`
 * y, para desempatar (posiciones repetidas tras una carrera antigua o datos
 * migrados), la fecha de creación. */
function aliveListsOrdered(db: Tx, workspaceId: string) {
  return db.board.findMany({
    where: { workspaceId, isList: true, deletedAt: null },
    orderBy: [{ listPosition: 'asc' }, { createdAt: 'asc' }],
  });
}

/** Comprueba que no haya otra lista viva del usuario con ese nombre. La
 * collation por defecto de MySQL compara sin distinguir mayúsculas, así que
 * `equals` ya cubre "Compras" vs "compras" sin necesidad de `mode`. */
async function assertNameFree(
  tx: Tx,
  workspaceId: string,
  name: string,
  excludeListId?: string,
): Promise<void> {
  const clash = await tx.board.findFirst({
    where: {
      workspaceId,
      isList: true,
      deletedAt: null,
      name: { equals: name },
      ...(excludeListId ? { id: { not: excludeListId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw listNameTaken();
}

/** Creación idempotente por `id` del cliente: si ya existe, es una lista viva y
 * es del MISMO usuario (su workspace Personal), se devuelve tal cual; en
 * cualquier otro caso (otro contexto, tablero normal o lista borrada) 409
 * genérico — nunca revela de quién ni qué es el id ocupado. */
async function resolveExistingList(
  db: Tx | typeof prisma,
  existing: {
    id: string;
    name: string;
    listPosition: number;
    createdAt: Date;
    updatedAt: Date;
    workspaceId: string;
    isList: boolean;
    deletedAt: Date | null;
  },
  workspaceId: string,
): Promise<CreatedResult<ListDto>> {
  if (existing.workspaceId !== workspaceId || !existing.isList || existing.deletedAt !== null) {
    throw idAlreadyInUseError();
  }
  const columnId = await requireListColumnId(db, existing.id);
  return { value: toListDto(existing, columnId), created: false };
}

async function listLists(userId: string): Promise<ListDto[]> {
  const workspace = await ensurePersonalWorkspace(prisma, userId);

  const boards = await prisma.board.findMany({
    where: { workspaceId: workspace.id, isList: true, deletedAt: null },
    orderBy: [{ listPosition: 'asc' }, { createdAt: 'asc' }],
    // Una sola consulta con la columna viva de cada lista en vez de N+1.
    include: {
      columns: { where: { deletedAt: null }, orderBy: { position: 'asc' }, take: 1 },
    },
  });

  return boards.map((board) => {
    const column = board.columns[0];
    if (!column) {
      throw new AppError(500, 'LIST_WITHOUT_COLUMN', 'La lista está en un estado inconsistente.');
    }
    return toListDto(board, column.id);
  });
}

async function createList(
  userId: string,
  input: CreateListInput,
): Promise<CreatedResult<ListDto>> {
  const workspace = await ensurePersonalWorkspace(prisma, userId);
  // El slug se deriva del id (único globalmente), así que nunca colisiona con
  // el de otra lista ni depende del nombre (que puede repetirse tras un borrado).
  const id = input.id ?? randomUUID();

  try {
    return await prisma.$transaction(async (tx) => {
      await lockPersonalWorkspace(tx, workspace.id);

      // Se reintenta la idempotencia DENTRO del bloqueo: si una petición gemela
      // (mismo id) acaba de confirmarse, esta debe devolver su lista con 200 y
      // no chocar contra la regla de nombre único que sí cumple la propia lista.
      if (input.id) {
        const existing = await tx.board.findUnique({ where: { id } });
        if (existing) return resolveExistingList(tx, existing, workspace.id);
      }

      await assertNameFree(tx, workspace.id, input.name);

      const alive = await aliveListsOrdered(tx, workspace.id);

      let position: number;
      if (input.position === undefined) {
        // Al final: máximo + 1 (no `length`, porque puede haber huecos tras
        // borrados); la primera lista queda en 0.
        position = alive.length === 0 ? 0 : Math.max(...alive.map((l) => l.listPosition)) + 1;
      } else {
        // Se inserta en la posición pedida (acotada al final) y las demás se
        // reacomodan a 0..n sin hueco — mismo criterio que updateColumn.
        position = Math.min(input.position, alive.length);
        for (const [index, sibling] of alive.entries()) {
          const target = index < position ? index : index + 1;
          if (sibling.listPosition !== target) {
            await tx.board.update({ where: { id: sibling.id }, data: { listPosition: target } });
          }
        }
      }

      const board = await tx.board.create({
        data: {
          id,
          workspaceId: workspace.id,
          name: input.name,
          slug: `lista-${id.replace(/-/g, '')}`,
          isList: true,
          listPosition: position,
          // La columna única nace en la misma transacción: una lista nunca
          // existe sin ella.
          columns: {
            create: { name: LIST_COLUMN_NAME, position: 0, isDoneColumn: false, wipLimit: null },
          },
        },
        include: { columns: true },
      });

      return { value: toListDto(board, board.columns[0].id), created: true };
    }, TX_OPTIONS);
  } catch (err) {
    // Carrera entre dos usuarios (o dos transacciones sin el mismo bloqueo)
    // con el mismo id: la perdedora cae en P2002. Si el id ya existe se
    // resuelve igual que un reintento (200 si es nuestra lista, 409 si no);
    // si no existe, el P2002 era por otra cosa y se relanza.
    if (input.id && isUniqueConstraintError(err)) {
      const existing = await prisma.board.findUnique({ where: { id: input.id } });
      if (existing) return resolveExistingList(prisma, existing, workspace.id);
    }
    throw err;
  }
}

async function updateList(
  userId: string,
  listId: string,
  input: UpdateListInput,
): Promise<ListDto> {
  // Lectura previa solo para dar 404 rápido y conocer el workspace a bloquear;
  // todo se revalida dentro de la transacción.
  const board = await requireOwnList(prisma, userId, listId);

  return prisma.$transaction(async (tx) => {
    await lockPersonalWorkspace(tx, board.workspaceId);

    // Puede haberse borrado mientras esperábamos el bloqueo.
    const current = await requireOwnList(tx, userId, listId);

    if (input.name !== undefined) {
      // Se excluye a sí misma: renombrar "Compras" a "compras" es válido.
      await assertNameFree(tx, current.workspaceId, input.name, current.id);
    }

    let newPosition: number | undefined;
    if (input.position !== undefined) {
      const siblings = await aliveListsOrdered(tx, current.workspaceId);
      const others = siblings.filter((sibling) => sibling.id !== current.id);
      newPosition = Math.min(input.position, others.length);
      others.splice(newPosition, 0, current);

      // Solo se escriben las que cambian de posición: subir `updatedAt` de listas
      // que no se movieron haría que los clientes que sincronizan por fecha las
      // vuelvan a descargar sin necesidad. La movida se actualiza abajo.
      for (const [index, sibling] of others.entries()) {
        if (sibling.id !== current.id && sibling.listPosition !== index) {
          await tx.board.update({ where: { id: sibling.id }, data: { listPosition: index } });
        }
      }
    }

    const updated = await tx.board.update({
      where: { id: current.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(newPosition !== undefined ? { listPosition: newPosition } : {}),
      },
    });

    return toListDto(updated, await requireListColumnId(tx, updated.id));
  }, TX_OPTIONS);
}

async function deleteList(userId: string, listId: string): Promise<void> {
  const board = await requireOwnList(prisma, userId, listId);

  await prisma.$transaction(async (tx) => {
    await lockPersonalWorkspace(tx, board.workspaceId);

    const current = await requireOwnList(tx, userId, listId);

    // Lista por defecto resultante: la viva de menor posición que quede.
    const remaining = (await aliveListsOrdered(tx, current.workspaceId)).filter(
      (list) => list.id !== current.id,
    );
    const target = remaining[0];
    if (!target) {
      // Siempre debe quedar al menos una lista: es donde caen las tareas y a
      // donde apunta la bandeja "Tareas" de la app móvil.
      throw new AppError(409, 'LAST_LIST', 'No puedes borrar tu última lista.');
    }
    const targetColumnId = await requireListColumnId(tx, target.id);

    // Soft delete — nunca DELETE directo (docs/02-modelo-datos.md). Condicionado
    // a deletedAt null como respaldo del bloqueo: si algo la borró en medio, no
    // se pisa la fecha y se responde 404.
    const deleted = await tx.board.updateMany({
      where: { id: current.id, isList: true, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (deleted.count !== 1) throw listNotFound();

    // Las tareas VIVAS pasan al final de la lista por defecto conservando su
    // orden relativo. Las ya borradas (tombstones) se quedan donde están.
    const tasks = await tx.task.findMany({
      where: { deletedAt: null, column: { boardId: current.id } },
      orderBy: [{ column: { position: 'asc' } }, { position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });

    if (tasks.length > 0) {
      const highest = await tx.task.aggregate({
        where: { columnId: targetColumnId, deletedAt: null },
        _max: { position: true },
      });
      const firstPosition = (highest._max.position ?? -1) + 1;

      // Un update por tarea (no updateMany) porque cada una necesita su propia
      // `position`; `update` además sube `@updatedAt`, que es lo que hace que los
      // clientes que sincronizan por fecha vean que la tarea cambió de lista.
      for (const [index, task] of tasks.entries()) {
        await tx.task.update({
          where: { id: task.id },
          data: { columnId: targetColumnId, position: firstPosition + index },
        });
      }
    }

    // Borrado de board = evento de seguridad relevante (CLAUDE.md): se audita en
    // la misma transacción, igual que boards.service.ts::deleteBoard.
    await tx.auditLog.create({
      data: {
        userId,
        action: 'list.deleted',
        metadata: { listId: current.id, targetListId: target.id, tasksMoved: tasks.length },
      },
    });
  }, TX_OPTIONS);
}

export const listsService = {
  listLists,
  createList,
  updateList,
  deleteList,
};

import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import { listsService } from '../lists/lists.service';
import { ensurePersonalWorkspace } from '../workspaces/personal-workspace';
import { toSyncListDto } from './sync.mappers';
import { listDataSchema, type ListData, type SyncMutationInput } from './sync.schema';
import { applied, conflict, decide, invalid, rejected, type Outcome } from './sync.push.shared';

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function listMutation(userId: string, m: SyncMutationInput, now: number): Promise<Outcome> {
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


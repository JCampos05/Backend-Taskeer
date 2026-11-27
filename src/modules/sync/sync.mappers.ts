import type { SyncListDto, SyncTaskDto } from './sync.types';

// Mapeo fila → DTO del contrato de sync. Lo comparten `changes` y `push` para
// que el `record` de una mutación tenga EXACTAMENTE la misma forma que el de
// `changes`.

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toSyncListDto(board: {
  id: string;
  name: string;
  listPosition: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}): SyncListDto {
  return {
    id: board.id,
    name: board.name,
    position: board.listPosition,
    createdAt: iso(board.createdAt),
    updatedAt: iso(board.updatedAt),
    deletedAt: isoOrNull(board.deletedAt),
  };
}

/** Tarea de LISTA plana: `listId` = id del tablero-lista; la columna interna no
 * se expone (`columnId` y `boardId` van nulos). */
export function toSyncListTaskDto(
  task: {
    id: string;
    title: string;
    description: string | null;
    priority: SyncTaskDto['priority'];
    dueAt: Date | null;
    assigneeId: string | null;
    position: number;
    completedAt: Date | null;
    repeatUnit: string | null;
    repeatInterval: number | null;
    repeatWeekdays: number | null;
    repeatAnchorDay: number | null;
    repeatSuccessorId: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  },
  listId: string,
): SyncTaskDto {
  return {
    id: task.id,
    boardId: null,
    columnId: null,
    listId,
    title: task.title,
    description: task.description,
    priority: task.priority,
    dueAt: isoOrNull(task.dueAt),
    assigneeId: task.assigneeId,
    position: task.position,
    completedAt: isoOrNull(task.completedAt),
    repeatUnit: task.repeatUnit,
    repeatInterval: task.repeatInterval,
    repeatWeekdays: task.repeatWeekdays,
    repeatAnchorDay: task.repeatAnchorDay,
    repeatSuccessorId: task.repeatSuccessorId,
    createdAt: iso(task.createdAt),
    updatedAt: iso(task.updatedAt),
    deletedAt: isoOrNull(task.deletedAt),
  };
}

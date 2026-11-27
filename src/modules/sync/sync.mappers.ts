import type {
  SyncBoardDto,
  SyncColumnDto,
  SyncListDto,
  SyncMyDayDto,
  SyncReminderDto,
  SyncSubtaskDto,
  SyncTaskDto,
  SyncWorkspaceDto,
} from './sync.types';

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

type TaskRow = {
  id: string;
  columnId: string;
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
};

/** Una tarea de LISTA plana viaja con `listId` (id del tablero-lista) y sin
 * `columnId`/`boardId`: la columna interna de la lista nunca se expone. Una de
 * tablero viaja con `columnId` y `boardId` y `listId` nulo. */
export function toSyncTaskDto(
  task: TaskRow,
  container: { id: string; isList: boolean },
): SyncTaskDto {
  return {
    id: task.id,
    boardId: container.isList ? null : container.id,
    columnId: container.isList ? null : task.columnId,
    listId: container.isList ? container.id : null,
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

export function toSyncWorkspaceDto(
  workspace: { id: string; name: string; isPersonal: boolean; updatedAt: Date; deletedAt: Date | null },
  myRole: string,
): SyncWorkspaceDto {
  return {
    id: workspace.id,
    name: workspace.name,
    isPersonal: workspace.isPersonal,
    myRole,
    updatedAt: iso(workspace.updatedAt),
    deletedAt: isoOrNull(workspace.deletedAt),
  };
}

export function toSyncBoardDto(board: {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}): SyncBoardDto {
  return {
    id: board.id,
    workspaceId: board.workspaceId,
    name: board.name,
    createdAt: iso(board.createdAt),
    updatedAt: iso(board.updatedAt),
    deletedAt: isoOrNull(board.deletedAt),
  };
}

export function toSyncColumnDto(column: {
  id: string;
  boardId: string;
  name: string;
  position: number;
  wipLimit: number | null;
  isDoneColumn: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}): SyncColumnDto {
  return {
    id: column.id,
    boardId: column.boardId,
    name: column.name,
    position: column.position,
    wipLimit: column.wipLimit,
    isDoneColumn: column.isDoneColumn,
    createdAt: iso(column.createdAt),
    updatedAt: iso(column.updatedAt),
    deletedAt: isoOrNull(column.deletedAt),
  };
}

export function toSyncSubtaskDto(subtask: {
  id: string;
  taskId: string;
  title: string;
  completed: boolean;
  position: number;
  assigneeId: string | null;
  dueAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}): SyncSubtaskDto {
  return {
    id: subtask.id,
    taskId: subtask.taskId,
    title: subtask.title,
    completed: subtask.completed,
    position: subtask.position,
    assigneeId: subtask.assigneeId,
    dueAt: isoOrNull(subtask.dueAt),
    createdAt: iso(subtask.createdAt),
    updatedAt: iso(subtask.updatedAt),
    deletedAt: isoOrNull(subtask.deletedAt),
  };
}

export function toSyncMyDayDto(mark: {
  taskId: string;
  addedAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}): SyncMyDayDto {
  return {
    id: mark.taskId,
    taskId: mark.taskId,
    addedAt: iso(mark.addedAt),
    updatedAt: iso(mark.updatedAt),
    deletedAt: isoOrNull(mark.deletedAt),
  };
}

export function toSyncReminderDto(reminder: {
  id: string;
  taskId: string;
  remindAt: Date;
  status: SyncReminderDto['status'];
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}): SyncReminderDto {
  return {
    id: reminder.id,
    taskId: reminder.taskId,
    remindAt: iso(reminder.remindAt),
    status: reminder.status,
    sentAt: isoOrNull(reminder.sentAt),
    origin: 'MOBILE',
    createdAt: iso(reminder.createdAt),
    updatedAt: iso(reminder.updatedAt),
    deletedAt: isoOrNull(reminder.deletedAt),
  };
}

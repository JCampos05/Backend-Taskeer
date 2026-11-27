// DTOs propios del módulo sync (contrato de sincronización móvil v1.0, ver
// docs/backend-spec-movil.md). El Backend no comparte paquete de tipos con la
// app móvil — cada uno define los suyos. Todas las fechas son ISO 8601 UTC con
// milisegundos y todos los identificadores son UUID; nunca se exponen ids
// autoincrementales, tokenHash ni passwordHash.

import type { TaskPriority } from '@prisma/client';

/** Versión del contrato que implementa este servidor. */
export const SYNC_CONTRACT_VERSION = '1.0';
export const SYNC_CONTRACT_MAJOR = 1;

/** Nombre de cada clave dentro de `changes`. */
export type SyncChangeKey =
  | 'workspaces'
  | 'boardAccess'
  | 'boards'
  | 'lists'
  | 'columns'
  | 'tasks'
  | 'subtasks'
  | 'myDay'
  | 'reminders';

/** Nombre de entidad tal como lo usa `push` y `supportedEntities`. */
export type SyncEntityName = 'list' | 'board' | 'column' | 'task' | 'subtask' | 'myDay' | 'reminder';

export interface SyncListDto {
  id: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** Una tarea de lista plana viaja con `listId` y sin `columnId`/`boardId` (la
 * columna interna de la lista nunca se expone); una de tablero, al revés. */
export interface SyncTaskDto {
  id: string;
  boardId: string | null;
  columnId: string | null;
  listId: string | null;
  title: string;
  description: string | null;
  priority: TaskPriority;
  dueAt: string | null;
  assigneeId: string | null;
  position: number;
  completedAt: string | null;
  repeatUnit: string | null;
  repeatInterval: number | null;
  repeatWeekdays: number | null;
  repeatAnchorDay: number | null;
  repeatSuccessorId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface SyncChanges {
  workspaces: unknown[];
  boardAccess: unknown[];
  boards: unknown[];
  lists: SyncListDto[];
  columns: unknown[];
  tasks: SyncTaskDto[];
  subtasks: unknown[];
  myDay: unknown[];
  reminders: unknown[];
}

export interface SyncChangesResponse {
  contractVersion: string;
  supportedEntities: SyncEntityName[];
  me: { userId: string };
  serverTime: string;
  isSnapshot: boolean;
  changes: SyncChanges;
  nextCursor: string;
  hasMore: boolean;
}

export type SyncPushStatus = 'applied' | 'conflict' | 'rejected';

export interface SyncPushResult {
  clientMutationId: string;
  status: SyncPushStatus;
  record: unknown;
  error?: { code: string; message: string };
}

export interface SyncPushResponse {
  contractVersion: string;
  serverTime: string;
  results: SyncPushResult[];
}

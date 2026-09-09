// DTOs propios del módulo boards. El Backend no comparte paquete de tipos
// con el Frontend por ahora — cada uno define los suyos (ver
// docs/01-arquitectura.md).

export interface BoardDto {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface ColumnDto {
  id: string;
  boardId: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

// Resumen de tarea embebido en el detalle de un board — no es el DTO completo
// de modules/tasks (ese vive en tasks.types.ts), solo lo necesario para
// renderizar las tarjetas del kanban de una sola llamada.
export interface TaskSummaryDto {
  id: string;
  columnId: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  position: number;
  assigneeId: string | null;
}

export interface ColumnWithTasksDto extends ColumnDto {
  tasks: TaskSummaryDto[];
}

export interface BoardDetailDto extends BoardDto {
  columns: ColumnWithTasksDto[];
}

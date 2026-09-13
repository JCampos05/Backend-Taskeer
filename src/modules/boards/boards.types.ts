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
  // null = sin límite de tareas simultáneas en esta columna.
  wipLimit: number | null;
  createdAt: string;
  updatedAt: string;
}

// Espejo de modules/tasks/tasks.types.ts (TaskPriority) — cada módulo define
// sus propios tipos, sin compartir paquete (ver docs/01-arquitectura.md).
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

// Resumen de tarea embebido en el detalle de un board — no es el DTO completo
// de modules/tasks (ese vive en tasks.types.ts), solo lo necesario para
// renderizar las tarjetas del kanban de una sola llamada.
export interface TaskSummaryDto {
  id: string;
  columnId: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  priority: TaskPriority;
  position: number;
  assigneeId: string | null;
  // Progreso del checklist de la tarea (modules/tasks, Subtask) — se manda
  // ya calculado acá para que la tarjeta del kanban pueda mostrar "x/y" sin
  // pedir los subtasks de cada tarea por separado.
  subtaskTotal: number;
  subtaskCompletado: number;
}

export interface ColumnWithTasksDto extends ColumnDto {
  tasks: TaskSummaryDto[];
}

// Espejo de WorkspaceRole (Backend/prisma/schema.prisma) — cada módulo
// define sus propios tipos, sin compartir paquete.
export type WorkspaceRoleDto = 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER';

export interface BoardDetailDto extends BoardDto {
  // Rol EFECTIVO de quien pidió este detalle en ESTE board puntual — ya
  // resuelto contra un posible BoardMemberOverride, para que el Frontend no
  // tenga que adivinar ni pedir los overrides (acceso restringido a
  // OWNER/ADMIN) solo para saber su propio rol acá.
  viewerEffectiveRole: WorkspaceRoleDto;
  columns: ColumnWithTasksDto[];
}

export interface BoardMemberOverrideDto {
  id: string;
  boardId: string;
  userId: string;
  role: WorkspaceRoleDto;
  createdAt: string;
  updatedAt: string;
}

// DTOs propios del módulo tasks. El Backend no comparte paquete de tipos con
// el Frontend por ahora — cada uno define los suyos (ver
// docs/01-arquitectura.md).

export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export interface TaskDto {
  id: string;
  columnId: string;
  assigneeId: string | null;
  title: string;
  description: string | null;
  // Siempre UTC, tal cual se guardó — la conversión a hora local es
  // responsabilidad del frontend (UserPreferences.timezoneId), nunca del
  // backend (ver CLAUDE.md, reglas no negociables).
  dueAt: string | null;
  priority: TaskPriority;
  position: number;
  createdAt: string;
  updatedAt: string;
}

// Para "Mi día" — tarea que el propio usuario marcó personalmente (sea que
// esté asignada a él o no), con el contexto de tablero/workspace ya resuelto
// (mismo motivo que UpcomingReminderDto en reminders.types.ts: el Frontend
// arma el link directo sin pedir nada más).
export interface MyDayTaskDto {
  addedAt: string;
  task: TaskDto;
  board: { id: string; name: string };
  workspaceId: string;
}

export interface SubtaskDto {
  id: string;
  taskId: string;
  assigneeId: string | null;
  title: string;
  dueAt: string | null;
  completed: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

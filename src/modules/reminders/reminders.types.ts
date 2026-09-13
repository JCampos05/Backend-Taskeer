// DTOs propios del módulo reminders. El Backend no comparte paquete de tipos
// con el Frontend por ahora — cada uno define los suyos (ver
// docs/01-arquitectura.md).

export interface ReminderDto {
  id: string;
  taskId: string;
  // Siempre UTC, tal cual se guardó — la conversión a hora local es
  // responsabilidad del frontend (UserPreferences.timezoneId), nunca del
  // backend (ver CLAUDE.md, reglas no negociables).
  remindAt: string;
  status: 'PENDING' | 'SENT' | 'DISMISSED';
  sentAt: string | null;
  createdAt: string;
}

// Para el dashboard de Inicio — a diferencia de ReminderDto (recordatorios
// de UNA tarea puntual), esto cruza todos los workspaces del usuario, así
// que trae ya resuelto el contexto (tarea/tablero/workspace) que el
// Frontend necesita para armar el link directo sin pedir nada más.
export interface UpcomingReminderDto {
  id: string;
  remindAt: string;
  task: { id: string; title: string };
  board: { id: string; name: string };
  workspaceId: string;
}

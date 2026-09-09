// DTOs propios del módulo tasks. El Backend no comparte paquete de tipos con
// el Frontend por ahora — cada uno define los suyos (ver
// docs/01-arquitectura.md).

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
  position: number;
  createdAt: string;
  updatedAt: string;
}

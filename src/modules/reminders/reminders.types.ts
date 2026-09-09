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

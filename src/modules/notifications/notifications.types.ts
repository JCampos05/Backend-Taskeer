// DTOs propios del módulo notifications. El Backend no comparte paquete de
// tipos con el Frontend por ahora — cada uno define los suyos (ver
// docs/01-arquitectura.md).

export interface NotificationDto {
  id: string;
  userId: string;
  type: 'REMINDER' | 'INVITATION' | 'ROLE_CHANGED' | 'MENTION' | 'RECOVERY_CODE_USED' | 'TASK_ASSIGNED';
  title: string;
  body: string | null;
  taskId: string | null;
  // null = no leída. El "centro de notificaciones" del frontend filtra por esto.
  readAt: string | null;
  createdAt: string;
}

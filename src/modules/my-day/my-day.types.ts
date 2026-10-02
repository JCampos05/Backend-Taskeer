// DTOs propios del módulo my-day. No introduce ningún concepto de dato
// nuevo propio — compone DTOs que ya existen en reminders/tasks/workspaces
// (ver my-day.service.ts). El Backend no comparte paquete de tipos con el
// Frontend por ahora — cada uno define los suyos (ver docs/01-arquitectura.md).

import type { MyDayTaskDto, TaskDto } from '../tasks/tasks.types';
import type { UpcomingReminderDto } from '../reminders/reminders.types';
import type { MyInvitationDto } from '../workspaces/workspaces.types';

export interface MyDayDto {
  // Agregadas a mano por el propio usuario (MyDayTask) — ver tasks.service.ts.
  pinnedTasks: MyDayTaskDto[];
  // Asignadas automáticamente al usuario y con fecha límite — ver
  // tasksService.listAssignedWithDueDate.
  assignedTasks: TaskDto[];
  // Recordatorios pendientes de sus tareas asignadas — reusa
  // remindersService.listUpcomingForUser tal cual (misma fuente que ya
  // consume views/inicio).
  reminders: UpcomingReminderDto[];
  // Invitaciones a workspace pendientes — reusa
  // workspacesService.listMyInvitations tal cual.
  invitations: MyInvitationDto[];
}

// Módulo de agregación, sin tabla propia (salvo MyDayTask, que vive en
// modules/tasks por ser un hijo de Task — ver schema.prisma). No duplica
// ninguna regla de permisos: cada función que compone ya hace su propia
// verificación de membresía/acceso (remindersService.listUpcomingForUser,
// workspacesService.listMyInvitations, tasksService.listAssignedWithDueDate,
// tasksService.listMyDayTasks) — este service solo las junta en una sola
// respuesta para /me/my-day.
import { remindersService } from '../reminders/reminders.service';
import { tasksService } from '../tasks/tasks.service';
import { workspacesService } from '../workspaces/workspaces.service';
import type { MyDayDto } from './my-day.types';

async function getMyDay(userId: string, userEmail: string): Promise<MyDayDto> {
  const [pinnedTasks, assignedTasks, reminders, invitations] = await Promise.all([
    tasksService.listMyDayTasks(userId),
    tasksService.listAssignedWithDueDate(userId),
    remindersService.listUpcomingForUser(userId),
    workspacesService.listMyInvitations(userEmail),
  ]);

  return { pinnedTasks, assignedTasks, reminders, invitations };
}

export const myDayService = {
  getMyDay,
};

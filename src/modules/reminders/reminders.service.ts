import type { WorkspaceMember, WorkspaceRole } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import type { CreateReminderInput } from './reminders.schema';
import type { ReminderDto } from './reminders.types';

// Reminder cuelga de Task y no tiene reglas de permiso propias — hereda
// exactamente los mismos permisos que mutar/leer la tarea a la que
// pertenece (docs/02-modelo-datos.md: "un Reminder avisa sobre la tarea, no
// a una persona en particular"). Mismos roles de mutación que
// modules/tasks/tasks.service.ts.
const MUTATION_ROLES: WorkspaceRole[] = ['OWNER', 'ADMIN', 'EDITOR'];

function toReminderDto(reminder: {
  id: string;
  taskId: string;
  remindAt: Date;
  status: ReminderDto['status'];
  sentAt: Date | null;
  createdAt: Date;
}): ReminderDto {
  return {
    id: reminder.id,
    taskId: reminder.taskId,
    remindAt: reminder.remindAt.toISOString(),
    status: reminder.status,
    sentAt: reminder.sentAt ? reminder.sentAt.toISOString() : null,
    createdAt: reminder.createdAt.toISOString(),
  };
}

function getMembership(workspaceId: string, userId: string): Promise<WorkspaceMember | null> {
  return prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
}

function requireMutationRole(membership: WorkspaceMember) {
  if (!MUTATION_ROLES.includes(membership.role)) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'No tienes permisos suficientes para modificar recordatorios en este workspace.',
    );
  }
}

/** Resuelve una tarea no borrada junto con su workspace y verifica que
 * `userId` sea miembro. Deliberadamente duplicado de requireTaskAccess() en
 * modules/tasks/tasks.service.ts en vez de importado desde ahí — cada módulo
 * es autocontenido (docs/01-arquitectura.md, "Arquitectura MVC con módulos
 * híbridos"); mismo criterio de 404 uniforme si la tarea no existe, está
 * soft-deleted, su board está borrado, o el usuario no es miembro — nunca
 * revela que un recurso ajeno existe. */
async function requireTaskAccess(taskId: string, userId: string) {
  const notFoundError = new AppError(404, 'TASK_NOT_FOUND', 'La tarea no existe.');

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { column: { include: { board: true } } },
  });

  if (!task || task.deletedAt !== null || task.column.board.deletedAt !== null) {
    throw notFoundError;
  }

  const workspaceId = task.column.board.workspaceId;
  const membership = await getMembership(workspaceId, userId);
  if (!membership) {
    throw notFoundError;
  }

  return { task, workspaceId, membership };
}

/** Resuelve un recordatorio junto con la tarea/workspace a la que pertenece,
 * mismo criterio de 404 uniforme que requireTaskAccess(). */
async function requireReminderAccess(reminderId: string, userId: string) {
  const notFoundError = new AppError(404, 'REMINDER_NOT_FOUND', 'El recordatorio no existe.');

  const reminder = await prisma.reminder.findUnique({
    where: { id: reminderId },
    include: { task: { include: { column: { include: { board: true } } } } },
  });

  if (
    !reminder ||
    reminder.task.deletedAt !== null ||
    reminder.task.column.board.deletedAt !== null
  ) {
    throw notFoundError;
  }

  const workspaceId = reminder.task.column.board.workspaceId;
  const membership = await getMembership(workspaceId, userId);
  if (!membership) {
    throw notFoundError;
  }

  return { reminder, task: reminder.task, workspaceId, membership };
}

async function createReminder(
  taskId: string,
  userId: string,
  input: CreateReminderInput,
): Promise<ReminderDto> {
  const { task, membership } = await requireTaskAccess(taskId, userId);
  requireMutationRole(membership);

  // status nace en PENDING por default del schema — no se fija aquí.
  const reminder = await prisma.reminder.create({
    data: {
      taskId: task.id,
      remindAt: new Date(input.remindAt),
    },
  });

  return toReminderDto(reminder);
}

async function listRemindersByTask(taskId: string, userId: string): Promise<ReminderDto[]> {
  // Cualquier miembro del workspace puede leer, no solo quien puede mutar.
  await requireTaskAccess(taskId, userId);

  // Todos los estados, no solo PENDING — el frontend filtra si quiere.
  const reminders = await prisma.reminder.findMany({
    where: { taskId },
    orderBy: { remindAt: 'asc' },
  });

  return reminders.map(toReminderDto);
}

async function cancelReminder(reminderId: string, userId: string): Promise<ReminderDto> {
  const { reminder, membership } = await requireReminderAccess(reminderId, userId);
  requireMutationRole(membership);

  if (reminder.status !== 'PENDING') {
    throw new AppError(
      400,
      'REMINDER_NOT_PENDING',
      'Solo se puede cancelar un recordatorio que sigue pendiente.',
    );
  }

  // Nunca se borra la fila — se marca DISMISSED. Reminder no tiene su propio
  // deletedAt en el schema; este status cumple el mismo rol de "borrado
  // lógico" para este modelo puntual.
  const updated = await prisma.reminder.update({
    where: { id: reminder.id },
    data: { status: 'DISMISSED' },
  });

  return toReminderDto(updated);
}

export const remindersService = {
  createReminder,
  listRemindersByTask,
  cancelReminder,
};

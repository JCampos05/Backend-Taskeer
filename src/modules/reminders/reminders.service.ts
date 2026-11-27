import type { WorkspaceMember, WorkspaceRole } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import { idAlreadyInUseError, isUniqueConstraintError } from '../../utils/idempotent-create';
import type { CreateReminderInput } from './reminders.schema';
import type { ReminderDto, UpcomingReminderDto } from './reminders.types';

const UPCOMING_REMINDERS_LIMIT = 5;

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
    reminder.deletedAt !== null ||
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
    // Los recordatorios MOBILE son de quien los creó: nadie más los ve.
    where: { taskId, deletedAt: null, OR: [{ origin: 'SERVER' }, { createdById: userId }] },
    orderBy: { remindAt: 'asc' },
  });

  return reminders.map(toReminderDto);
}

async function cancelReminder(reminderId: string, userId: string): Promise<ReminderDto> {
  const { reminder, membership } = await requireReminderAccess(reminderId, userId);
  requireMutationRole(membership);

  // Un recordatorio creado desde el móvil es de quien lo creó: nadie más lo cancela.
  if (reminder.origin === 'MOBILE' && reminder.createdById !== userId) {
    throw new AppError(404, 'REMINDER_NOT_FOUND', 'El recordatorio no existe.');
  }

  if (reminder.status !== 'PENDING') {
    throw new AppError(
      400,
      'REMINDER_NOT_PENDING',
      'Solo se puede cancelar un recordatorio que sigue pendiente.',
    );
  }

  // Nunca se borra la fila — se marca DISMISSED (cancelado, sigue visible).
  // El borrado lógico propio de la sync móvil es `deletedAt`.
  const updated = await prisma.reminder.update({
    where: { id: reminder.id },
    data: { status: 'DISMISSED' },
  });

  return toReminderDto(updated);
}

/** Para el dashboard de Inicio — los próximos recordatorios de tareas
 * asignadas al usuario, cruzando todos sus workspaces (a diferencia de
 * listRemindersByTask, que es de una sola tarea). Filtra por membresía
 * vigente además de `assigneeId`: si a alguien lo sacaron de un workspace
 * después de que le asignaran una tarea ahí, esa asignación queda huérfana
 * en el modelo (no hay limpieza automática) y no debería seguir apareciendo
 * en su propio dashboard. */
async function listUpcomingForUser(userId: string): Promise<UpcomingReminderDto[]> {
  const reminders = await prisma.reminder.findMany({
    where: {
      status: 'PENDING',
      deletedAt: null,
      OR: [{ origin: 'SERVER' }, { createdById: userId }],
      task: {
        assigneeId: userId,
        deletedAt: null,
        column: {
          deletedAt: null,
          board: {
            deletedAt: null,
            // workspace.deletedAt también, no solo board.deletedAt — un
            // workspace borrado no cascadea a sus Board (ver mismo hallazgo
            // corregido en tasks.service.ts::requireTaskAccess/listTasksByBoard).
            workspace: { deletedAt: null, members: { some: { userId } } },
          },
        },
      },
    },
    orderBy: { remindAt: 'asc' },
    take: UPCOMING_REMINDERS_LIMIT,
    include: {
      task: {
        select: {
          id: true,
          title: true,
          column: { select: { board: { select: { id: true, name: true, workspaceId: true } } } },
        },
      },
    },
  });

  return reminders.map((reminder) => ({
    id: reminder.id,
    remindAt: reminder.remindAt.toISOString(),
    task: { id: reminder.task.id, title: reminder.task.title },
    board: { id: reminder.task.column.board.id, name: reminder.task.column.board.name },
    workspaceId: reminder.task.column.board.workspaceId,
  }));
}

// --- Sync móvil (POST /sync/push) ---------------------------------------------
// Los recordatorios que crea la app llevan origin MOBILE y el dueño que los
// creó: el worker del backend los ignora (la app los avisa en local) y solo su
// dueño los ve. Pueden ser varios por tarea. Mismos permisos que mutar la tarea.

interface MobileReminderInput {
  id: string;
  remindAt: Date;
  status: ReminderDto['status'];
  sentAt: Date | null;
}

/** Solo el creador toca un recordatorio MOBILE; para cualquier otro, 404 uniforme. */
function requireOwnMobileReminder(
  reminder: { origin: string; createdById: string | null },
  userId: string,
) {
  if (reminder.origin !== 'MOBILE' || reminder.createdById !== userId) {
    throw new AppError(404, 'REMINDER_NOT_FOUND', 'El recordatorio no existe.');
  }
}

async function createMobileReminder(taskId: string, userId: string, input: MobileReminderInput) {
  const { task, membership } = await requireTaskAccess(taskId, userId);
  requireMutationRole(membership);
  try {
    return await prisma.reminder.create({
      data: {
        id: input.id,
        taskId: task.id,
        remindAt: input.remindAt,
        status: input.status,
        sentAt: input.sentAt,
        origin: 'MOBILE',
        createdById: userId,
      },
    });
  } catch (err) {
    // Carrera por el mismo id de cliente: 409 genérico y no un 500.
    if (isUniqueConstraintError(err)) throw idAlreadyInUseError();
    throw err;
  }
}

async function updateMobileReminder(
  reminderId: string,
  userId: string,
  input: Omit<MobileReminderInput, 'id'>,
) {
  const { reminder, membership } = await requireReminderAccess(reminderId, userId);
  requireMutationRole(membership);
  requireOwnMobileReminder(reminder, userId);
  // SENT / DISMISSED son estados finales: no vuelven a PENDING.
  if (input.status === 'PENDING' && reminder.status !== 'PENDING') {
    throw new AppError(
      400,
      'REMINDER_NOT_PENDING',
      'Un recordatorio ya enviado o cancelado no puede volver a pendiente.',
    );
  }
  return prisma.reminder.update({
    where: { id: reminder.id },
    data: { remindAt: input.remindAt, status: input.status, sentAt: input.sentAt },
  });
}

async function deleteMobileReminder(reminderId: string, userId: string): Promise<void> {
  const { reminder, membership } = await requireReminderAccess(reminderId, userId);
  requireMutationRole(membership);
  requireOwnMobileReminder(reminder, userId);
  // Borrado lógico (tombstone): condicionado a deletedAt null para que dos
  // borrados simultáneos no pisen la fecha.
  await prisma.reminder.updateMany({
    where: { id: reminder.id, deletedAt: null },
    data: { deletedAt: new Date() },
  });
}

export const remindersService = {
  createMobileReminder,
  updateMobileReminder,
  deleteMobileReminder,
  createReminder,
  listRemindersByTask,
  cancelReminder,
  listUpcomingForUser,
};

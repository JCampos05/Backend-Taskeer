import type { WorkspaceMember, WorkspaceRole } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import { pushNotification } from '../notifications/notifications.stream';
import type { CreateTaskInput, MoveTaskInput, UpdateTaskInput } from './tasks.schema';
import type { TaskDto } from './tasks.types';

// EDITOR sí puede crear/mover/editar/borrar Task dentro de columnas ya
// existentes (a diferencia de boards/columnas, exclusivas de OWNER/ADMIN) —
// ver docs/02-modelo-datos.md, sección WorkspaceMember. VIEWER no muta nada.
const MUTATION_ROLES: WorkspaceRole[] = ['OWNER', 'ADMIN', 'EDITOR'];

function toTaskDto(task: {
  id: string;
  columnId: string;
  assigneeId: string | null;
  title: string;
  description: string | null;
  dueAt: Date | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}): TaskDto {
  return {
    id: task.id,
    columnId: task.columnId,
    assigneeId: task.assigneeId,
    title: task.title,
    description: task.description,
    dueAt: task.dueAt ? task.dueAt.toISOString() : null,
    position: task.position,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
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
      'No tienes permisos suficientes para modificar tareas en este workspace.',
    );
  }
}

/** Resuelve una columna (y su board/workspace) no borrados a partir de su id.
 * Column no tiene deletedAt propio, pero se considera inexistente si su Board
 * está soft-deleted. Usado antes de crear/mover una tarea hacia esa columna. */
async function requireColumnContext(columnId: string) {
  const column = await prisma.column.findUnique({
    where: { id: columnId },
    include: { board: true },
  });

  if (!column || column.board.deletedAt !== null) {
    throw new AppError(404, 'COLUMN_NOT_FOUND', 'La columna no existe.');
  }

  return { column, board: column.board };
}

/** Resuelve una tarea no borrada junto con su columna/board/workspace y
 * verifica que `userId` sea miembro de ese workspace. Si la tarea no existe,
 * está soft-deleted, su board está borrado, o el usuario no es miembro, lanza
 * el mismo 404 uniforme — no revela si el recurso existe pero es ajeno (mismo
 * criterio que modules/workspaces). */
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

  return { task, column: task.column, board: task.column.board, workspaceId, membership };
}

/** Si `assigneeId` viene, verifica que esa persona sea miembro del mismo
 * workspace de la tarea — nunca se puede asignar a alguien ajeno. */
async function assertAssigneeIsMember(workspaceId: string, assigneeId: string | null | undefined) {
  if (!assigneeId) return;

  const assigneeMembership = await getMembership(workspaceId, assigneeId);
  if (!assigneeMembership) {
    throw new AppError(
      422,
      'ASSIGNEE_NOT_WORKSPACE_MEMBER',
      'La persona asignada debe ser miembro de este workspace.',
    );
  }
}

/** Notifica a la persona asignada, salvo que se haya asignado la tarea a sí
 * misma (ya lo sabe, no hace falta avisarle). Nunca lanza si falla el push
 * en vivo — `Notification` ya quedó creada, que es la fuente de verdad
 * (ver docs/01-arquitectura.md); la entrega en vivo es solo un plus. */
async function notifyTaskAssigned(
  taskId: string,
  taskTitle: string,
  assigneeId: string,
  actingUserId: string,
): Promise<void> {
  if (assigneeId === actingUserId) return;

  const notification = await prisma.notification.create({
    data: {
      userId: assigneeId,
      type: 'TASK_ASSIGNED',
      title: 'Te asignaron una tarea',
      body: taskTitle,
      taskId,
    },
  });

  pushNotification(notification);
}

async function createTask(userId: string, input: CreateTaskInput): Promise<TaskDto> {
  const { column, board } = await requireColumnContext(input.columnId);

  const membership = await getMembership(board.workspaceId, userId);
  if (!membership) {
    throw new AppError(404, 'COLUMN_NOT_FOUND', 'La columna no existe.');
  }
  requireMutationRole(membership);

  await assertAssigneeIsMember(board.workspaceId, input.assigneeId);

  // Decisión: la siguiente posición se calcula sobre tareas no borradas —
  // las soft-deleted no ocupan un lugar visible en la columna, así que no
  // tiene sentido dejarles espacio en el nuevo orden.
  const highestPosition = await prisma.task.aggregate({
    where: { columnId: column.id, deletedAt: null },
    _max: { position: true },
  });
  const nextPosition = (highestPosition._max.position ?? -1) + 1;

  const task = await prisma.task.create({
    data: {
      columnId: input.columnId,
      assigneeId: input.assigneeId ?? null,
      title: input.title,
      description: input.description ?? null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      position: nextPosition,
    },
  });

  if (task.assigneeId) {
    await notifyTaskAssigned(task.id, task.title, task.assigneeId, userId);
  }

  return toTaskDto(task);
}

async function listTasksByBoard(boardId: string, userId: string): Promise<TaskDto[]> {
  const board = await prisma.board.findFirst({ where: { id: boardId, deletedAt: null } });
  if (!board) {
    throw new AppError(404, 'BOARD_NOT_FOUND', 'El board no existe.');
  }

  const membership = await getMembership(board.workspaceId, userId);
  if (!membership) {
    throw new AppError(404, 'BOARD_NOT_FOUND', 'El board no existe.');
  }

  const tasks = await prisma.task.findMany({
    where: { deletedAt: null, column: { boardId } },
    orderBy: [{ column: { position: 'asc' } }, { position: 'asc' }],
  });

  return tasks.map(toTaskDto);
}

async function getTaskById(taskId: string, userId: string): Promise<TaskDto> {
  const { task } = await requireTaskAccess(taskId, userId);
  return toTaskDto(task);
}

async function updateTask(taskId: string, userId: string, input: UpdateTaskInput): Promise<TaskDto> {
  const { task, workspaceId, membership } = await requireTaskAccess(taskId, userId);
  requireMutationRole(membership);

  if (input.assigneeId !== undefined) {
    await assertAssigneeIsMember(workspaceId, input.assigneeId);
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt ? new Date(input.dueAt) : null } : {}),
      ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
    },
  });

  // Solo notifica si el assigneeId cambió a alguien nuevo y específico —
  // no en un unassign (input.assigneeId === null) ni si quedó igual.
  if (
    input.assigneeId !== undefined &&
    input.assigneeId !== null &&
    input.assigneeId !== task.assigneeId
  ) {
    await notifyTaskAssigned(updated.id, updated.title, input.assigneeId, userId);
  }

  return toTaskDto(updated);
}

async function moveTask(taskId: string, userId: string, input: MoveTaskInput): Promise<TaskDto> {
  const { task, column: sourceColumn, board: sourceBoard, membership } = await requireTaskAccess(
    taskId,
    userId,
  );
  requireMutationRole(membership);

  const { column: destinationColumn, board: destinationBoard } = await requireColumnContext(
    input.columnId,
  );

  // Antes de decidir qué error mostrar, confirma que el usuario sea miembro
  // del workspace de la columna destino — si no lo es, responde el mismo
  // 404 uniforme que "la columna no existe" (nunca reveles con un 400 que
  // una columna ajena, en un workspace al que no perteneces, sí existe).
  // Solo si el usuario SÍ es miembro de ese otro workspace (pertenece a
  // varios) es seguro revelar el 400 de negocio de abajo.
  const destinationMembership = await getMembership(destinationBoard.workspaceId, userId);
  if (!destinationMembership) {
    throw new AppError(404, 'COLUMN_NOT_FOUND', 'La columna no existe.');
  }

  // Una tarea no puede saltar de workspace moviéndose a una columna de otro
  // board/workspace — la columna destino debe pertenecer al mismo workspace.
  if (destinationBoard.workspaceId !== sourceBoard.workspaceId) {
    throw new AppError(
      400,
      'CROSS_WORKSPACE_MOVE',
      'No puedes mover una tarea a una columna de otro workspace.',
    );
  }

  const isSameColumn = sourceColumn.id === destinationColumn.id;

  const updatedTask = await prisma.$transaction(async (tx) => {
    if (isSameColumn) {
      const siblings = await tx.task.findMany({
        where: { columnId: sourceColumn.id, deletedAt: null },
        orderBy: { position: 'asc' },
      });

      const withoutMoved = siblings.filter((sibling) => sibling.id !== taskId);
      const clampedPosition = Math.max(0, Math.min(input.position, withoutMoved.length));
      withoutMoved.splice(clampedPosition, 0, task);

      await Promise.all(
        withoutMoved.map((sibling, index) =>
          tx.task.update({
            where: { id: sibling.id },
            data: { position: index },
          }),
        ),
      );

      return tx.task.findUniqueOrThrow({ where: { id: taskId } });
    }

    const sourceSiblings = await tx.task.findMany({
      where: { columnId: sourceColumn.id, deletedAt: null, id: { not: taskId } },
      orderBy: { position: 'asc' },
    });
    const destinationSiblings = await tx.task.findMany({
      where: { columnId: destinationColumn.id, deletedAt: null },
      orderBy: { position: 'asc' },
    });

    const clampedPosition = Math.max(0, Math.min(input.position, destinationSiblings.length));
    destinationSiblings.splice(clampedPosition, 0, task);

    await Promise.all([
      ...sourceSiblings.map((sibling, index) =>
        tx.task.update({ where: { id: sibling.id }, data: { position: index } }),
      ),
      ...destinationSiblings.map((sibling, index) =>
        tx.task.update({
          where: { id: sibling.id },
          data: {
            position: index,
            ...(sibling.id === taskId ? { columnId: destinationColumn.id } : {}),
          },
        }),
      ),
    ]);

    return tx.task.findUniqueOrThrow({ where: { id: taskId } });
  });

  return toTaskDto(updatedTask);
}

async function deleteTask(taskId: string, userId: string): Promise<void> {
  const { task, membership } = await requireTaskAccess(taskId, userId);
  requireMutationRole(membership);

  // Soft delete — nunca DELETE directo (docs/02-modelo-datos.md). No es un
  // evento de seguridad en el sentido de CLAUDE.md (login, cambio de rol,
  // borrado de workspace/board), así que no genera AuditLog — a diferencia
  // de board.deleted, que sí es explícito ahí.
  await prisma.task.update({
    where: { id: task.id },
    data: { deletedAt: new Date() },
  });
}

export const tasksService = {
  createTask,
  listTasksByBoard,
  getTaskById,
  updateTask,
  moveTask,
  deleteTask,
};

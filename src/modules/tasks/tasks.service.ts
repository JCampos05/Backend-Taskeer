import type { TaskPriority as PrismaTaskPriority, WorkspaceMember, WorkspaceRole } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import { boardsService } from '../boards/boards.service';
import { pushNotification } from '../notifications/notifications.stream';
import type {
  CreateSubtaskInput,
  CreateTaskInput,
  ListTasksQuery,
  MoveTaskInput,
  UpdateSubtaskInput,
  UpdateTaskInput,
} from './tasks.schema';
import type { MyDayTaskDto, SubtaskDto, TaskDto } from './tasks.types';

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
  priority: PrismaTaskPriority;
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
    priority: task.priority,
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

function requireMutationRole(role: WorkspaceRole) {
  if (!MUTATION_ROLES.includes(role)) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'No tienes permisos suficientes para modificar tareas en este workspace.',
    );
  }
}

/** Resuelve el rol EFECTIVO de `membership` en el board `boardId` — delega
 * a boards.service.ts (ver ese comentario para el detalle de por qué esto
 * se importa entre módulos en vez de duplicarse: es lógica de permisos,
 * un drift entre dos copias sería un bug de seguridad). Task hereda el
 * override de su Board dueño — no tiene uno propio. */
function resolveEffectiveRole(boardId: string, membership: WorkspaceMember): Promise<WorkspaceRole> {
  return boardsService.resolveEffectiveRole(boardId, membership);
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
 * está soft-deleted, su board o su workspace están borrados, o el usuario no
 * es miembro, lanza el mismo 404 uniforme — no revela si el recurso existe
 * pero es ajeno (mismo criterio que modules/workspaces).
 *
 * Hallazgo de security-reviewer (feature "Mi día"): hasta esta corrección
 * solo se chequeaba `board.deletedAt`, nunca `workspace.deletedAt` —
 * `deleteWorkspace` (workspaces.service.ts) no cascadea el soft-delete a sus
 * Board ni limpia WorkspaceMember, así que una tarea de un workspace ya
 * "borrado" seguía siendo accesible por id mientras la membresía no se
 * limpiara (que tampoco ocurre hoy). Corregido acá, en el único punto común,
 * para cubrir de una sola vez a todo lo que depende de requireTaskAccess. */
async function requireTaskAccess(taskId: string, userId: string) {
  const notFoundError = new AppError(404, 'TASK_NOT_FOUND', 'La tarea no existe.');

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { column: { include: { board: { include: { workspace: true } } } } },
  });

  if (
    !task ||
    task.deletedAt !== null ||
    task.column.board.deletedAt !== null ||
    task.column.board.workspace.deletedAt !== null
  ) {
    throw notFoundError;
  }

  const workspaceId = task.column.board.workspaceId;
  const membership = await getMembership(workspaceId, userId);
  if (!membership) {
    throw notFoundError;
  }

  return { task, column: task.column, board: task.column.board, workspaceId, membership };
}

/** Rechaza con 409 si agregar una tarea más a `columnId` superaría su
 * `wipLimit` (null = ilimitado, no valida nada). Cuenta solo tareas no
 * borradas — mismo criterio que el resto de conteos/reordenamiento de
 * position en este módulo.
 *
 * Nota de concurrencia, mismo criterio ya aceptado para el reordenamiento
 * de `position` (ver Historial en PROGRESS.md, 2026-08-26): dos requests
 * casi simultáneas contra la misma columna casi llena podrían pasar ambas
 * este chequeo antes de que cualquiera cree/mueva su tarea, dejando la
 * columna un poco por encima del límite en el peor caso — tolerable al
 * volumen esperado del MVP, no se agrega locking pesimista por esto. */
async function assertWipLimitNotReached(columnId: string, wipLimit: number | null): Promise<void> {
  if (wipLimit === null) return;

  const count = await prisma.task.count({ where: { columnId, deletedAt: null } });
  if (count >= wipLimit) {
    throw new AppError(
      409,
      'COLUMN_WIP_LIMIT_REACHED',
      `Esta columna ya tiene ${wipLimit} tareas, su límite configurado.`,
    );
  }
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
  requireMutationRole(await resolveEffectiveRole(board.id, membership));

  await assertAssigneeIsMember(board.workspaceId, input.assigneeId);
  await assertWipLimitNotReached(column.id, column.wipLimit);

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
      priority: input.priority ?? 'MEDIUM',
      position: nextPosition,
    },
  });

  if (task.assigneeId) {
    await notifyTaskAssigned(task.id, task.title, task.assigneeId, userId);
  }

  return toTaskDto(task);
}

async function listTasksByBoard(
  boardId: string,
  userId: string,
  priority?: ListTasksQuery['priority'],
): Promise<TaskDto[]> {
  // Chequea también workspace.deletedAt, no solo board.deletedAt — un
  // workspace borrado (DELETE /workspaces/:id) no cascadea el soft-delete a
  // sus Board, así que sin esto un board de un workspace ya "borrado" seguía
  // siendo listable mientras la membresía no se limpiara (que tampoco ocurre
  // hoy). Mismo hallazgo de security-reviewer ya corregido en
  // requireTaskAccess — ver ese comentario para el detalle completo.
  const board = await prisma.board.findFirst({
    where: { id: boardId, deletedAt: null, workspace: { deletedAt: null } },
  });
  if (!board) {
    throw new AppError(404, 'BOARD_NOT_FOUND', 'El board no existe.');
  }

  const membership = await getMembership(board.workspaceId, userId);
  if (!membership) {
    throw new AppError(404, 'BOARD_NOT_FOUND', 'El board no existe.');
  }

  const tasks = await prisma.task.findMany({
    where: { deletedAt: null, column: { boardId }, ...(priority ? { priority } : {}) },
    orderBy: [{ column: { position: 'asc' } }, { position: 'asc' }],
  });

  return tasks.map(toTaskDto);
}

async function getTaskById(taskId: string, userId: string): Promise<TaskDto> {
  const { task } = await requireTaskAccess(taskId, userId);
  return toTaskDto(task);
}

async function updateTask(taskId: string, userId: string, input: UpdateTaskInput): Promise<TaskDto> {
  const { task, board, workspaceId, membership } = await requireTaskAccess(taskId, userId);
  requireMutationRole(await resolveEffectiveRole(board.id, membership));

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
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
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
  requireMutationRole(await resolveEffectiveRole(sourceBoard.id, membership));

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

  // El board destino puede ser distinto del origen (mismo workspace, otro
  // board) y tener su propio override — sin este chequeo, alguien sin
  // permiso de mutar tareas en el board destino (ej. VIEWER por override
  // ahí) podría "colar" una tarea vía un board origen donde sí es EDITOR.
  if (destinationBoard.id !== sourceBoard.id) {
    requireMutationRole(await resolveEffectiveRole(destinationBoard.id, destinationMembership));
  }

  const isSameColumn = sourceColumn.id === destinationColumn.id;

  // Solo aplica al entrar a una columna DISTINTA — reordenar dentro de la
  // misma columna no cambia cuántas tareas tiene, así que nunca puede violar
  // su propio límite.
  if (!isSameColumn) {
    await assertWipLimitNotReached(destinationColumn.id, destinationColumn.wipLimit);
  }

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
  const { task, board, membership } = await requireTaskAccess(taskId, userId);
  requireMutationRole(await resolveEffectiveRole(board.id, membership));

  // Soft delete — nunca DELETE directo (docs/02-modelo-datos.md). No es un
  // evento de seguridad en el sentido de CLAUDE.md (login, cambio de rol,
  // borrado de workspace/board), así que no genera AuditLog — a diferencia
  // de board.deleted, que sí es explícito ahí.
  await prisma.task.update({
    where: { id: task.id },
    data: { deletedAt: new Date() },
  });
}

function toSubtaskDto(subtask: {
  id: string;
  taskId: string;
  assigneeId: string | null;
  title: string;
  dueAt: Date | null;
  completed: boolean;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}): SubtaskDto {
  return {
    id: subtask.id,
    taskId: subtask.taskId,
    assigneeId: subtask.assigneeId,
    title: subtask.title,
    dueAt: subtask.dueAt ? subtask.dueAt.toISOString() : null,
    completed: subtask.completed,
    position: subtask.position,
    createdAt: subtask.createdAt.toISOString(),
    updatedAt: subtask.updatedAt.toISOString(),
  };
}

/** Resuelve un subtask no borrado que pertenezca a `taskId` — 404 uniforme
 * si no existe o pertenece a otra tarea (nunca revela que un subtask ajeno
 * sí existe con un ID válido). Asume que quien llama ya corrió
 * requireTaskAccess sobre esa misma taskId. */
async function requireSubtask(taskId: string, subtaskId: string) {
  const notFoundError = new AppError(404, 'SUBTASK_NOT_FOUND', 'El paso no existe.');

  const subtask = await prisma.subtask.findUnique({ where: { id: subtaskId } });
  if (!subtask || subtask.taskId !== taskId) {
    throw notFoundError;
  }

  return subtask;
}

async function listSubtasks(taskId: string, userId: string): Promise<SubtaskDto[]> {
  await requireTaskAccess(taskId, userId);

  const subtasks = await prisma.subtask.findMany({
    where: { taskId },
    orderBy: { position: 'asc' },
  });

  return subtasks.map(toSubtaskDto);
}

async function createSubtask(
  taskId: string,
  userId: string,
  input: CreateSubtaskInput,
): Promise<SubtaskDto> {
  const { board, workspaceId, membership } = await requireTaskAccess(taskId, userId);
  requireMutationRole(await resolveEffectiveRole(board.id, membership));

  await assertAssigneeIsMember(workspaceId, input.assigneeId);

  const highestPosition = await prisma.subtask.aggregate({
    where: { taskId },
    _max: { position: true },
  });
  const nextPosition = (highestPosition._max.position ?? -1) + 1;

  const subtask = await prisma.subtask.create({
    data: {
      taskId,
      assigneeId: input.assigneeId ?? null,
      title: input.title,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      position: nextPosition,
    },
  });

  return toSubtaskDto(subtask);
}

async function updateSubtask(
  taskId: string,
  subtaskId: string,
  userId: string,
  input: UpdateSubtaskInput,
): Promise<SubtaskDto> {
  const { board, workspaceId, membership } = await requireTaskAccess(taskId, userId);
  requireMutationRole(await resolveEffectiveRole(board.id, membership));
  const subtask = await requireSubtask(taskId, subtaskId);

  if (input.assigneeId !== undefined) {
    await assertAssigneeIsMember(workspaceId, input.assigneeId);
  }

  // Marcar completado nunca se valida contra en qué columna está la Task
  // dueña — el checklist de una tarea es independiente de si esa tarea ya
  // se movió a "Terminado" o no (confirmado explícitamente por el usuario:
  // no debe bloquear ni exigir nada sobre el estado de la Task).
  if (input.position === undefined) {
    const updated = await prisma.subtask.update({
      where: { id: subtask.id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.dueAt !== undefined ? { dueAt: input.dueAt ? new Date(input.dueAt) : null } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
        ...(input.completed !== undefined ? { completed: input.completed } : {}),
      },
    });
    return toSubtaskDto(updated);
  }

  // Reordenamiento — mismo patrón que updateColumn en boards.service.ts:
  // reacomoda el position de los demás subtasks de la misma tarea.
  const updatedSubtask = await prisma.$transaction(async (tx) => {
    const siblings = await tx.subtask.findMany({
      where: { taskId },
      orderBy: { position: 'asc' },
    });

    const withoutMoved = siblings.filter((sibling) => sibling.id !== subtaskId);
    const clampedPosition = Math.max(0, Math.min(input.position!, withoutMoved.length));
    withoutMoved.splice(clampedPosition, 0, subtask);

    await Promise.all(
      withoutMoved.map((sibling, index) =>
        tx.subtask.update({
          where: { id: sibling.id },
          data: {
            position: index,
            ...(sibling.id === subtaskId
              ? {
                  ...(input.title !== undefined ? { title: input.title } : {}),
                  ...(input.dueAt !== undefined
                    ? { dueAt: input.dueAt ? new Date(input.dueAt) : null }
                    : {}),
                  ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
                  ...(input.completed !== undefined ? { completed: input.completed } : {}),
                }
              : {}),
          },
        }),
      ),
    );

    return tx.subtask.findUniqueOrThrow({ where: { id: subtaskId } });
  });

  return toSubtaskDto(updatedSubtask);
}

async function deleteSubtask(taskId: string, subtaskId: string, userId: string): Promise<void> {
  const { board, membership } = await requireTaskAccess(taskId, userId);
  requireMutationRole(await resolveEffectiveRole(board.id, membership));
  const subtask = await requireSubtask(taskId, subtaskId);

  // Hard delete — a diferencia de Task, Subtask no tiene deletedAt propio
  // (mismo criterio que Column, ver schema.prisma): es un hijo desechable,
  // se borra tal cual.
  await prisma.subtask.delete({ where: { id: subtask.id } });
}

const ASSIGNED_WITH_DUE_DATE_LIMIT = 10;

/** Para la parte automática de "Mi día" — tareas asignadas al usuario que
 * tienen una fecha límite (`dueAt`), cruzando todos sus workspaces, mismo
 * criterio de membresía vigente que remindersService.listUpcomingForUser.
 * Decisión: las asignadas SIN fecha límite no entran acá automáticamente
 * (no hay forma de ordenarlas por "urgencia hoy" sin convertir fechas en el
 * backend, algo que CLAUDE.md prohíbe) — si el usuario las quiere ver en su
 * día, las agrega a mano vía MyDayTask. Documentado en PROGRESS.md. */
async function listAssignedWithDueDate(userId: string): Promise<TaskDto[]> {
  const tasks = await prisma.task.findMany({
    where: {
      assigneeId: userId,
      deletedAt: null,
      dueAt: { not: null },
      column: {
        board: {
          deletedAt: null,
          workspace: { deletedAt: null, members: { some: { userId } } },
        },
      },
    },
    orderBy: { dueAt: 'asc' },
    take: ASSIGNED_WITH_DUE_DATE_LIMIT,
  });

  return tasks.map(toTaskDto);
}

// --- "Mi día" (MyDayTask): marca personal, sin rol/permiso de mutación de
// por medio — cualquier miembro del workspace (incluido VIEWER) puede
// agregar/quitar una tarea de SU PROPIO "Mi día", esté o no asignada a él.
// requireTaskAccess ya basta como chequeo de permisos: no se exige
// requireMutationRole porque esto no modifica la tarea en sí, solo un
// marcador privado del usuario que la agrega.

/** Usado por el Frontend al abrir el modal de una tarea existente, para
 * saber si el botón de "Mi día" debe mostrarse activo. */
async function isTaskInMyDay(taskId: string, userId: string): Promise<boolean> {
  await requireTaskAccess(taskId, userId);

  const entry = await prisma.myDayTask.findUnique({
    where: { userId_taskId: { userId, taskId } },
  });
  return entry !== null;
}

/** Idempotente: si ya estaba agregada, no hace nada (no es un error). */
async function addTaskToMyDay(taskId: string, userId: string): Promise<void> {
  await requireTaskAccess(taskId, userId);

  await prisma.myDayTask.upsert({
    where: { userId_taskId: { userId, taskId } },
    update: {},
    create: { userId, taskId },
  });
}

/** Idempotente: si no estaba agregada, no hace nada (no es un error) — a
 * diferencia de deleteSubtask, acá no tiene sentido un 404 por "ya no está":
 * el resultado final que le importa al usuario (que no esté en su Mi día)
 * ya se cumple sin que haga falta distinguir el caso. */
async function removeTaskFromMyDay(taskId: string, userId: string): Promise<void> {
  await requireTaskAccess(taskId, userId);

  await prisma.myDayTask.deleteMany({ where: { userId, taskId } });
}

/** Tareas que el usuario agregó a su "Mi día", cruzando todos sus workspaces
 * — mismo criterio que remindersService.listUpcomingForUser: filtra por
 * membresía vigente y tarea/board no borrados, para que una marca vieja no
 * resucite una tarea ya inaccesible. Más reciente agregada primero. */
async function listMyDayTasks(userId: string): Promise<MyDayTaskDto[]> {
  const entries = await prisma.myDayTask.findMany({
    where: {
      userId,
      task: {
        deletedAt: null,
        column: {
          board: {
            deletedAt: null,
            workspace: { deletedAt: null, members: { some: { userId } } },
          },
        },
      },
    },
    orderBy: { addedAt: 'desc' },
    include: {
      task: {
        include: { column: { include: { board: true } } },
      },
    },
  });

  return entries.map((entry) => ({
    addedAt: entry.addedAt.toISOString(),
    task: toTaskDto(entry.task),
    board: { id: entry.task.column.board.id, name: entry.task.column.board.name },
    workspaceId: entry.task.column.board.workspaceId,
  }));
}

export const tasksService = {
  createTask,
  listTasksByBoard,
  getTaskById,
  updateTask,
  moveTask,
  deleteTask,
  listSubtasks,
  createSubtask,
  updateSubtask,
  deleteSubtask,
  isTaskInMyDay,
  addTaskToMyDay,
  removeTaskFromMyDay,
  listMyDayTasks,
  listAssignedWithDueDate,
};

import { randomBytes, createHash } from 'node:crypto';
import type { InvitationStatus, WorkspaceMember, WorkspaceRole } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import { entitlementsService } from '../billing/entitlements.service';
import { mailService } from '../../services/mail/mail.service';
import { pushNotification } from '../notifications/notifications.stream';
import type {
  CreateInvitationInput,
  CreateWorkspaceInput,
  TransferOwnershipInput,
  UpdateMemberRoleInput,
  UpdateWorkspaceInput,
} from './workspaces.schema';
import type {
  AcceptInvitationResultDto,
  InvitationDecisionResultDto,
  InvitationDto,
  MyInvitationDto,
  WorkspaceDto,
  WorkspaceListItemDto,
  WorkspaceMemberDto,
} from './workspaces.types';

const INVITATION_TTL_MS = 72 * 60 * 60 * 1000; // 72h
// Plazo para que un OWNER/ADMIN apruebe una invitación ya aceptada. Pasado
// esto la solicitud caduca y hay que volver a invitar.
const APPROVAL_TTL_MS = 48 * 60 * 60 * 1000; // 48h
// Mínimo entre dos invitaciones al mismo correo en el mismo workspace: frena
// el reenvío en ráfaga (spam hacia una dirección) sin impedir reintentar.
const INVITATION_RESEND_COOLDOWN_MS = 5 * 60 * 1000; // 5 min
// Cuánto tiempo se sigue mostrando al invitado una invitación caducada, para
// poder decirle que pida que se la reenvíen.
const EXPIRED_INVITATION_VISIBLE_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
// Solicitudes esperando aprobación a la vez en un mismo workspace.
const MAX_AWAITING_APPROVALS_PER_WORKSPACE = 20;

// Roles con los mismos permisos que OWNER excepto transferir/borrar el
// workspace — ver docs/02-modelo-datos.md, sección WorkspaceMember.
const OWNER_LIKE_ROLES: WorkspaceRole[] = ['OWNER', 'ADMIN'];

function toWorkspaceDto(workspace: {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}): WorkspaceDto {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    ownerId: workspace.ownerId,
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: workspace.updatedAt.toISOString(),
  };
}

function toInvitationDto(invitation: {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  status: InvitationDto['status'];
  invitedById: string;
  expiresAt: Date;
  createdAt: Date;
}, inviteeDisplayName: string | null = null, inviteeEmailVerified: boolean | null = null): InvitationDto {
  return {
    id: invitation.id,
    workspaceId: invitation.workspaceId,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    invitedById: invitation.invitedById,
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
    inviteeDisplayName,
    inviteeEmailVerified,
  };
}

/** Genera un token aleatorio de 32 bytes y su hash SHA-256, mismo patrón que
 * `generateOpaqueToken()` en modules/auth/auth.service.ts (verificación de
 * correo, refresh tokens). Se duplica aquí en vez de importarse desde auth
 * porque auth.service.ts no lo exporta — si en el futuro un tercer módulo lo
 * necesita, vale la pena moverlo a un helper compartido (ej. src/utils/token.ts). */
function generateOpaqueToken(): { plain: string; hash: string } {
  const plain = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(plain).digest('hex');
  return { plain, hash };
}

/** Convierte un nombre en un slug URL-safe: minúsculas, sin acentos, espacios
 * y caracteres raros colapsados a un solo guión, sin guiones al inicio/fin. */
const DIACRITICS_PATTERN = /[̀-ͯ]/g;

function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(DIACRITICS_PATTERN, '') // quita diacríticos (acentos)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140); // deja margen dentro del límite de 160 para el sufijo de colisión
}

const SLUG_COLLISION_MAX_ATTEMPTS = 5;

/** Genera un slug único a partir de `name`, resolviendo colisiones (el slug
 * de Workspace es único globalmente) con un sufijo aleatorio corto. */
async function generateUniqueSlug(name: string): Promise<string> {
  const base = slugify(name) || 'workspace';

  for (let attempt = 0; attempt < SLUG_COLLISION_MAX_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
    const existing = await prisma.workspace.findUnique({ where: { slug: candidate } });
    if (!existing) {
      return candidate;
    }
  }

  throw new AppError(
    500,
    'SLUG_GENERATION_FAILED',
    'No se pudo generar un identificador único para el workspace. Intenta de nuevo.',
  );
}

/** Busca la membresía de `userId` en `workspaceId`, o null si no existe. No
 * distingue "workspace no existe" de "usuario no es miembro" — eso lo decide
 * quien llama (normalmente ambos casos deben responder 404 uniforme). */
function getMembership(workspaceId: string, userId: string): Promise<WorkspaceMember | null> {
  return prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
}

// Mismo criterio que auth.service.ts::register — detecta la violación del
// `@unique` de Prisma (P2002) sin importar `instanceof` de una clase de
// error específica del cliente generado.
function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  );
}

/** Resuelve el workspace (no borrado) y la membresía del usuario autenticado
 * a la vez. Si el workspace no existe, está soft-deleted, o el usuario no es
 * miembro, lanza 404 uniforme — nunca un 403 que revele que el recurso existe
 * pero el usuario no tiene acceso (mismo principio que en auth.service.ts). */
async function requireMembership(workspaceId: string, userId: string) {
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
  });

  if (!workspace) {
    throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'El workspace no existe.');
  }

  const membership = await getMembership(workspaceId, userId);
  if (!membership) {
    throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'El workspace no existe.');
  }

  return { workspace, membership };
}

function requireOwnerOrAdmin(membership: WorkspaceMember) {
  if (!OWNER_LIKE_ROLES.includes(membership.role)) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'No tienes permisos suficientes para realizar esta acción en el workspace.',
    );
  }
}

async function createWorkspace(userId: string, input: CreateWorkspaceInput): Promise<WorkspaceDto> {
  // "workspaces.owned.max" cuenta solo lo que el usuario POSEE
  // (Workspace.ownerId), no los workspaces donde solo es miembro — ver
  // docs/08-planes-suscripciones.md. Nunca cuenta los ya soft-deleted.
  const limiteWorkspaces = await entitlementsService.getWorkspacesOwnedMax(userId);

  if (limiteWorkspaces !== null) {
    const cantidadActual = await prisma.workspace.count({
      where: { ownerId: userId, deletedAt: null },
    });

    if (cantidadActual >= limiteWorkspaces) {
      throw new AppError(
        403,
        'WORKSPACE_LIMIT_REACHED',
        `Tu plan permite hasta ${limiteWorkspaces} workspaces propios. Sube de plan o borra uno existente para crear otro.`,
      );
    }
  }

  const slug = await generateUniqueSlug(input.name);

  const workspace = await prisma.$transaction(async (tx) => {
    const createdWorkspace = await tx.workspace.create({
      data: { name: input.name, slug, ownerId: userId },
    });

    await tx.workspaceMember.create({
      data: { workspaceId: createdWorkspace.id, userId, role: 'OWNER' },
    });

    return createdWorkspace;
  });

  return toWorkspaceDto(workspace);
}

async function listWorkspaces(userId: string): Promise<WorkspaceListItemDto[]> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId, workspace: { deletedAt: null } },
    include: { workspace: true },
    orderBy: { workspace: { createdAt: 'desc' } },
  });

  return memberships.map((membership) => ({
    ...toWorkspaceDto(membership.workspace),
    myRole: membership.role,
  }));
}

async function getWorkspaceById(workspaceId: string, userId: string): Promise<WorkspaceDto> {
  const { workspace } = await requireMembership(workspaceId, userId);
  return toWorkspaceDto(workspace);
}

async function updateWorkspace(
  workspaceId: string,
  userId: string,
  input: UpdateWorkspaceInput,
): Promise<WorkspaceDto> {
  const { membership } = await requireMembership(workspaceId, userId);
  requireOwnerOrAdmin(membership);

  if (input.slug !== undefined) {
    const existing = await prisma.workspace.findUnique({ where: { slug: input.slug } });
    if (existing && existing.id !== workspaceId) {
      throw new AppError(409, 'SLUG_ALREADY_TAKEN', 'Ese identificador ya está en uso.');
    }
  }

  const updated = await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
    },
  });

  return toWorkspaceDto(updated);
}

async function deleteWorkspace(workspaceId: string, userId: string): Promise<void> {
  const { membership } = await requireMembership(workspaceId, userId);

  // Ni siquiera ADMIN puede borrar el workspace — exclusivo del OWNER (ver
  // docs/02-modelo-datos.md).
  if (membership.role !== 'OWNER') {
    throw new AppError(
      403,
      'FORBIDDEN',
      'Solo el propietario del workspace puede borrarlo.',
    );
  }

  await prisma.$transaction([
    // Soft delete — nunca DELETE directo (docs/02-modelo-datos.md).
    prisma.workspace.update({
      where: { id: workspaceId },
      data: { deletedAt: new Date() },
    }),
    prisma.auditLog.create({
      data: {
        userId,
        action: 'workspace.deleted',
        metadata: { workspaceId },
      },
    }),
  ]);
}

async function listMembers(workspaceId: string, userId: string): Promise<WorkspaceMemberDto[]> {
  await requireMembership(workspaceId, userId);

  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    include: { user: true },
    orderBy: { createdAt: 'asc' },
  });

  return members.map((member) => ({
    userId: member.userId,
    email: member.user.email,
    displayName: member.user.displayName,
    role: member.role,
    createdAt: member.createdAt.toISOString(),
  }));
}

async function updateMemberRole(
  workspaceId: string,
  actingUserId: string,
  targetUserId: string,
  input: UpdateMemberRoleInput,
): Promise<WorkspaceMemberDto> {
  const { workspace, membership: actingMembership } = await requireMembership(
    workspaceId,
    actingUserId,
  );
  requireOwnerOrAdmin(actingMembership);

  const targetMembership = await getMembership(workspaceId, targetUserId);
  if (!targetMembership) {
    throw new AppError(404, 'MEMBER_NOT_FOUND', 'Ese miembro no pertenece al workspace.');
  }

  // Nadie puede degradar al OWNER por esta vía, ni siquiera otro ADMIN — el
  // rol del OWNER solo cambia como efecto de transfer-ownership.
  if (targetMembership.role === 'OWNER') {
    throw new AppError(
      400,
      'CANNOT_CHANGE_OWNER_ROLE',
      'El rol del propietario no se puede cambiar por esta vía. Usa transferencia de propiedad.',
    );
  }

  const previousRole = targetMembership.role;

  const [updated] = await prisma.$transaction([
    prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      data: { role: input.role },
      include: { user: true },
    }),
    prisma.auditLog.create({
      data: {
        userId: actingUserId,
        action: 'workspace.member_role_changed',
        metadata: { workspaceId, targetUserId, previousRole, newRole: input.role },
      },
    }),
  ]);

  // Notifica a la persona afectada — sin esto, su rol cambiaba sin que se
  // enterara hasta la próxima vez que recargara la página a mano (bug
  // reportado por el usuario probando roles por tablero: la pestaña ya
  // abierta de la persona afectada nunca se enteraba). No se notifica si se
  // cambia el rol a sí mismo (ya lo sabe, fue quien lo hizo). Fuera de la
  // transacción de arriba a propósito — best-effort, nunca debe poder
  // tumbar el cambio de rol en sí si algo saliera mal acá.
  if (targetUserId !== actingUserId) {
    const notification = await prisma.notification.create({
      data: {
        userId: targetUserId,
        type: 'ROLE_CHANGED',
        title: 'Tu rol cambió',
        body: `Ahora sos ${input.role} en el workspace "${workspace.name}".`,
      },
    });
    pushNotification(notification);
  }

  return {
    userId: updated.userId,
    email: updated.user.email,
    displayName: updated.user.displayName,
    role: updated.role,
    createdAt: updated.createdAt.toISOString(),
  };
}

async function removeMember(
  workspaceId: string,
  actingUserId: string,
  targetUserId: string,
): Promise<void> {
  const { membership: actingMembership } = await requireMembership(workspaceId, actingUserId);

  const targetMembership = await getMembership(workspaceId, targetUserId);
  if (!targetMembership) {
    throw new AppError(404, 'MEMBER_NOT_FOUND', 'Ese miembro no pertenece al workspace.');
  }

  const isSelfRemoval = actingUserId === targetUserId;

  if (targetMembership.role === 'OWNER') {
    // El OWNER no puede "salir" sin transferir la propiedad primero, y nadie
    // más (ni ADMIN) puede expulsarlo — exclusivo de transfer-ownership.
    if (isSelfRemoval) {
      throw new AppError(
        400,
        'OWNER_MUST_TRANSFER_OWNERSHIP',
        'Debes transferir la propiedad del workspace antes de salir de él.',
      );
    }
    throw new AppError(403, 'FORBIDDEN', 'No puedes expulsar al propietario del workspace.');
  }

  if (!isSelfRemoval) {
    requireOwnerOrAdmin(actingMembership);
  }

  await prisma.$transaction([
    prisma.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    }),
    prisma.auditLog.create({
      data: {
        userId: actingUserId,
        action: 'workspace.member_removed',
        metadata: { workspaceId, targetUserId, selfRemoval: isSelfRemoval },
      },
    }),
  ]);
}

async function transferOwnership(
  workspaceId: string,
  actingUserId: string,
  input: TransferOwnershipInput,
): Promise<WorkspaceDto> {
  const { workspace, membership: actingMembership } = await requireMembership(
    workspaceId,
    actingUserId,
  );

  if (actingMembership.role !== 'OWNER') {
    throw new AppError(
      403,
      'FORBIDDEN',
      'Solo el propietario actual puede transferir la propiedad del workspace.',
    );
  }

  if (input.newOwnerUserId === actingUserId) {
    throw new AppError(
      400,
      'CANNOT_TRANSFER_TO_SELF',
      'Ya eres el propietario de este workspace.',
    );
  }

  const newOwnerMembership = await getMembership(workspaceId, input.newOwnerUserId);
  if (!newOwnerMembership) {
    throw new AppError(
      404,
      'MEMBER_NOT_FOUND',
      'El nuevo propietario debe ser miembro del workspace.',
    );
  }

  const [updatedWorkspace] = await prisma.$transaction([
    prisma.workspace.update({
      where: { id: workspaceId },
      data: { ownerId: input.newOwnerUserId },
    }),
    prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: actingUserId } },
      data: { role: 'ADMIN' },
    }),
    prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: input.newOwnerUserId } },
      data: { role: 'OWNER' },
    }),
    prisma.auditLog.create({
      data: {
        userId: actingUserId,
        action: 'workspace.ownership_transferred',
        metadata: {
          workspaceId,
          previousOwnerId: actingUserId,
          newOwnerId: input.newOwnerUserId,
        },
      },
    }),
  ]);

  return toWorkspaceDto(updatedWorkspace);
}

async function createInvitation(
  workspaceId: string,
  actingUserId: string,
  input: CreateInvitationInput,
): Promise<InvitationDto> {
  const { workspace, membership: actingMembership } = await requireMembership(
    workspaceId,
    actingUserId,
  );
  requireOwnerOrAdmin(actingMembership);

  const actingUser = await prisma.user.findUnique({ where: { id: actingUserId } });
  if (!actingUser) {
    throw new AppError(401, 'UNAUTHENTICATED', 'La sesión no es válida.');
  }

  // Solo se puede invitar si el propio invitador verificó su correo o, sin
  // correo transaccional disponible, demostró tener un código de recuperación
  // (inviteVerifiedAt) — ver docs/07-alcance-mvp.md, "Colaboración e invitaciones".
  if (!actingUser.emailVerifiedAt && !actingUser.inviteVerifiedAt) {
    throw new AppError(
      403,
      'EMAIL_NOT_VERIFIED',
      'Debes verificar tu correo antes de invitar a alguien a este workspace.',
    );
  }

  // Una solicitud ya aceptada y esperando aprobación no se pisa con una
  // invitación nueva: primero hay que aprobarla o rechazarla.
  const awaiting = await prisma.invitation.findFirst({
    where: {
      workspaceId,
      email: input.email,
      status: 'AWAITING_APPROVAL',
      expiresAt: { gt: new Date() },
    },
  });
  if (awaiting) {
    throw new AppError(
      409,
      'INVITATION_AWAITING_APPROVAL',
      'Esa persona ya aceptó la invitación y está esperando aprobación. Apruébala o recházala.',
    );
  }

  // Tiempo mínimo entre invitaciones al mismo correo. Una invitación REVOKED
  // no cuenta: revocar y corregir (ej. otro rol) es una acción deliberada.
  const lastInvitation = await prisma.invitation.findFirst({
    where: { workspaceId, email: input.email, status: { not: 'REVOKED' } },
    orderBy: { createdAt: 'desc' },
  });
  if (lastInvitation) {
    const waitMs = lastInvitation.createdAt.getTime() + INVITATION_RESEND_COOLDOWN_MS - Date.now();
    if (waitMs > 0) {
      throw new AppError(
        429,
        'INVITATION_COOLDOWN',
        `Ya enviaste una invitación a este correo hace poco. Espera ${Math.ceil(waitMs / 60000)} min para volver a enviarla.`,
      );
    }
  }

  const invitationToken = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  // Decisión: si ya existe una invitación PENDING para el mismo correo en
  // este workspace, se reemplaza (se revoca la anterior y se crea una nueva
  // con token/expiración frescos) en vez de rechazar la operación — un
  // OWNER/ADMIN reintentando una invitación que no llegó o que quiere
  // refrescar es el caso más común, y no tiene sentido obligarlo a revocar
  // manualmente primero.
  const invitation = await prisma.$transaction(async (tx) => {
    await tx.invitation.updateMany({
      where: { workspaceId, email: input.email, status: 'PENDING' },
      data: { status: 'REVOKED' },
    });

    const created = await tx.invitation.create({
      data: {
        workspaceId,
        email: input.email,
        role: input.role,
        tokenHash: invitationToken.hash,
        invitedById: actingUserId,
        expiresAt,
      },
    });

    // Conceder acceso a un workspace es tan sensible como cambiar un rol —
    // mismo criterio de auditoría que el resto de eventos de este módulo.
    await tx.auditLog.create({
      data: {
        userId: actingUserId,
        action: 'workspace.invitation_created',
        metadata: { workspaceId, invitationId: created.id, email: input.email, role: input.role },
      },
    });

    return created;
  });

  // No await: el envío de correo nunca debe bloquear ni poder tumbar la
  // creación de la invitación (mail.service ya absorbe sus propios errores).
  void mailService.sendWorkspaceInvitationEmail(
    input.email,
    invitationToken.plain,
    workspace.name,
  );

  // Decisión: si el correo invitado ya pertenece a una cuenta existente, se
  // crea además una fila en Notification (tipo INVITATION) para que la vea
  // en su centro de notificaciones al iniciar sesión, y se empuja en vivo
  // por WebSocket si tiene una pestaña abierta ahora mismo. Si el correo no
  // tiene cuenta todavía, no hay userId al cual asociar la notificación —
  // el aviso llega solo por correo.
  const invitedExistingUser = await prisma.user.findUnique({ where: { email: input.email } });
  if (invitedExistingUser) {
    const notification = await prisma.notification.create({
      data: {
        userId: invitedExistingUser.id,
        type: 'INVITATION',
        title: 'Nueva invitación a un workspace',
        body: `Te invitaron a unirte al workspace "${workspace.name}".`,
      },
    });

    pushNotification(notification);
  }

  return toInvitationDto(invitation);
}

async function listInvitations(workspaceId: string, actingUserId: string): Promise<InvitationDto[]> {
  const { membership } = await requireMembership(workspaceId, actingUserId);
  requireOwnerOrAdmin(membership);

  // Decisión: se devuelven todas las invitaciones (cualquier status), no
  // solo PENDING — el frontend puede filtrar por `status` si solo quiere
  // mostrar las pendientes; conservar el historial completo (aceptadas,
  // vencidas, revocadas) es útil para que OWNER/ADMIN vean qué pasó con una
  // invitación sin tener que consultar AuditLog aparte.
  const invitations = await prisma.invitation.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
  });

  // Para las solicitudes esperando aprobación, el nombre de la cuenta que
  // aceptó (el correo es único, así que es exactamente esa cuenta).
  const awaitingEmails = invitations
    .filter((invitation) => invitation.status === 'AWAITING_APPROVAL')
    .map((invitation) => invitation.email);
  const invitees = awaitingEmails.length
    ? await prisma.user.findMany({
        where: { email: { in: awaitingEmails } },
        select: { email: true, displayName: true, emailVerifiedAt: true },
      })
    : [];
  const inviteeByEmail = new Map(invitees.map((user) => [user.email, user]));

  return invitations.map((invitation) => {
    const invitee = inviteeByEmail.get(invitation.email);
    return toInvitationDto(
      invitation,
      invitee?.displayName ?? null,
      invitee ? invitee.emailVerifiedAt !== null : null,
    );
  });
}

async function revokeInvitation(
  workspaceId: string,
  actingUserId: string,
  invitationId: string,
): Promise<void> {
  const { membership } = await requireMembership(workspaceId, actingUserId);
  requireOwnerOrAdmin(membership);

  const invitation = await prisma.invitation.findFirst({
    where: { id: invitationId, workspaceId },
  });

  if (!invitation || invitation.status !== 'PENDING') {
    throw new AppError(404, 'INVITATION_NOT_FOUND', 'Esa invitación no existe o ya no está pendiente.');
  }

  await prisma.$transaction(async (tx) => {
    // Condicionado a PENDING: si el invitado aceptó mientras tanto (pasó a
    // AWAITING_APPROVAL) no se pisa ese estado; la solicitud se decide con
    // aprobar/rechazar.
    const { count } = await tx.invitation.updateMany({
      where: { id: invitation.id, status: 'PENDING' },
      data: { status: 'REVOKED' },
    });
    if (count === 0) {
      throw new AppError(
        404,
        'INVITATION_NOT_FOUND',
        'Esa invitación no existe o ya no está pendiente.',
      );
    }

    await tx.auditLog.create({
      data: {
        userId: actingUserId,
        action: 'workspace.invitation_revoked',
        metadata: { workspaceId, invitationId: invitation.id, email: invitation.email },
      },
    });
  });
}

type WorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Aceptar una invitación (por token o por id) YA NO crea la membresía: deja
 * la invitación en AWAITING_APPROVAL y avisa a los OWNER/ADMIN del workspace,
 * que deben confirmar que quien aceptó es la persona esperada. Sin este paso,
 * cualquiera podía registrarse con el correo invitado antes que el invitado
 * real y entrar al workspace (el correo no se puede verificar sin correo
 * transaccional).
 *
 * Excepción: si el usuario ya era miembro no hay nada que aprobar — se marca
 * la invitación ACCEPTED sin duplicar la fila ni cambiar su rol. Es idempotente:
 * aceptar de nuevo una solicitud ya en espera no vuelve a notificar. */
async function requestInvitationApproval(
  invitation: {
    id: string;
    workspaceId: string;
    email: string;
    role: WorkspaceRole;
    status: InvitationStatus;
  },
  workspace: WorkspaceRow,
  user: { id: string; displayName: string; emailVerifiedAt: Date | null },
): Promise<AcceptInvitationResultDto> {
  const workspaceDto = toWorkspaceDto(workspace);

  const existingMember = await prisma.workspaceMember.findFirst({
    where: { workspaceId: invitation.workspaceId, userId: user.id },
  });
  if (existingMember) {
    await prisma.invitation.updateMany({
      where: { id: invitation.id, status: { in: ['PENDING', 'AWAITING_APPROVAL'] } },
      data: { status: 'ACCEPTED' },
    });
    return { workspace: workspaceDto, alreadyMember: true, awaitingApproval: false };
  }

  if (invitation.status === 'AWAITING_APPROVAL') {
    return { workspace: workspaceDto, alreadyMember: false, awaitingApproval: true };
  }

  // Tope de solicitudes esperando aprobación por workspace: sin él, una
  // cuenta con permiso de invitar podría inundar de notificaciones a todos
  // los OWNER/ADMIN invitando a muchos correos que aceptan al instante.
  const awaitingCount = await prisma.invitation.count({
    where: {
      workspaceId: invitation.workspaceId,
      status: 'AWAITING_APPROVAL',
      expiresAt: { gt: new Date() },
    },
  });
  if (awaitingCount >= MAX_AWAITING_APPROVALS_PER_WORKSPACE) {
    throw new AppError(
      429,
      'TOO_MANY_PENDING_APPROVALS',
      'Este workspace tiene demasiadas solicitudes esperando aprobación. Intenta de nuevo más tarde.',
    );
  }

  // Aviso explícito cuando la cuenta no tiene el correo verificado: cualquiera
  // pudo registrarse con ese correo, y el nombre lo elige quien se registra.
  const unverifiedNote = user.emailVerifiedAt
    ? ''
    : ' Ojo: su cuenta no tiene el correo verificado, confirma por otro medio que es esa persona.';

  // updateMany condicionado a PENDING: dos aceptaciones simultáneas solo
  // notifican una vez.
  const notifications = await prisma.$transaction(async (tx) => {
    const { count } = await tx.invitation.updateMany({
      where: { id: invitation.id, status: 'PENDING' },
      data: {
        status: 'AWAITING_APPROVAL',
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      },
    });
    if (count === 0) {
      return [];
    }

    const approvers = await tx.workspaceMember.findMany({
      where: { workspaceId: invitation.workspaceId, role: { in: OWNER_LIKE_ROLES } },
      select: { userId: true },
    });

    const created = [];
    for (const approver of approvers) {
      created.push(
        await tx.notification.create({
          data: {
            userId: approver.userId,
            type: 'INVITATION_REQUEST',
            title: 'Solicitud para unirse a un workspace',
            body: `${user.displayName} (${invitation.email}) aceptó la invitación a "${workspace.name}" como ${invitation.role}. Confirma que es quien esperabas.${unverifiedNote}`,
          },
        }),
      );
    }

    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: 'workspace.invitation_approval_requested',
        metadata: { workspaceId: invitation.workspaceId, invitationId: invitation.id },
      },
    });

    return created;
  });

  // Fuera de la transacción: un fallo del push en vivo no debe revertir la
  // solicitud ya registrada (la fila en Notification es la fuente de verdad).
  for (const notification of notifications) {
    pushNotification(notification);
  }

  return { workspace: workspaceDto, alreadyMember: false, awaitingApproval: true };
}

/** OWNER/ADMIN aprueba una solicitud: recién ahora se crea la membresía, con
 * el rol de la invitación. La cuenta que se une es la que tiene el correo de
 * la invitación (único en User, y aceptar exigió coincidir con él). */
async function approveInvitation(
  workspaceId: string,
  actingUserId: string,
  invitationId: string,
): Promise<InvitationDecisionResultDto> {
  const { workspace, membership } = await requireMembership(workspaceId, actingUserId);
  requireOwnerOrAdmin(membership);

  const notFoundError = new AppError(
    404,
    'INVITATION_NOT_FOUND',
    'Esa solicitud no existe o ya no está esperando aprobación.',
  );

  const invitation = await prisma.invitation.findFirst({
    where: { id: invitationId, workspaceId },
  });
  if (!invitation || invitation.status !== 'AWAITING_APPROVAL') {
    throw notFoundError;
  }
  if (invitation.expiresAt < new Date()) {
    throw new AppError(
      410,
      'INVITATION_EXPIRED',
      'La solicitud caducó. Vuelve a invitar a esa persona.',
    );
  }

  const invitee = await prisma.user.findUnique({ where: { email: invitation.email } });
  if (!invitee) {
    throw notFoundError;
  }

  const notification = await prisma.$transaction(async (tx) => {
    // Reclama la solicitud de forma atómica: si otro OWNER/ADMIN la decidió
    // mientras tanto, count es 0 y se aborta sin crear nada.
    const { count } = await tx.invitation.updateMany({
      where: { id: invitation.id, status: 'AWAITING_APPROVAL', expiresAt: { gt: new Date() } },
      data: { status: 'ACCEPTED' },
    });
    if (count === 0) {
      throw notFoundError;
    }

    // skipDuplicates: si por otra vía ya era miembro no se duplica ni se
    // cambia su rol, y la transacción no se aborta por la restricción única.
    await tx.workspaceMember.createMany({
      data: [{ workspaceId, userId: invitee.id, role: invitation.role }],
      skipDuplicates: true,
    });

    await tx.auditLog.create({
      data: {
        userId: actingUserId,
        action: 'workspace.invitation_approved',
        metadata: {
          workspaceId,
          invitationId: invitation.id,
          inviteeId: invitee.id,
          role: invitation.role,
        },
      },
    });

    return tx.notification.create({
      data: {
        userId: invitee.id,
        type: 'INVITATION_DECISION',
        title: 'Te aprobaron en un workspace',
        body: `Ya eres parte de "${workspace.name}".`,
      },
    });
  });

  pushNotification(notification);

  return {
    invitation: toInvitationDto({ ...invitation, status: 'ACCEPTED' }, invitee.displayName),
  };
}

/** OWNER/ADMIN rechaza una solicitud: la invitación queda REVOKED y quien
 * aceptó no entra. */
async function rejectInvitation(
  workspaceId: string,
  actingUserId: string,
  invitationId: string,
): Promise<InvitationDecisionResultDto> {
  const { workspace, membership } = await requireMembership(workspaceId, actingUserId);
  requireOwnerOrAdmin(membership);

  const notFoundError = new AppError(
    404,
    'INVITATION_NOT_FOUND',
    'Esa solicitud no existe o ya no está esperando aprobación.',
  );

  const invitation = await prisma.invitation.findFirst({
    where: { id: invitationId, workspaceId },
  });
  if (!invitation || invitation.status !== 'AWAITING_APPROVAL') {
    throw notFoundError;
  }

  const invitee = await prisma.user.findUnique({ where: { email: invitation.email } });

  const notification = await prisma.$transaction(async (tx) => {
    const { count } = await tx.invitation.updateMany({
      where: { id: invitation.id, status: 'AWAITING_APPROVAL' },
      data: { status: 'REVOKED' },
    });
    if (count === 0) {
      throw notFoundError;
    }

    await tx.auditLog.create({
      data: {
        userId: actingUserId,
        action: 'workspace.invitation_rejected',
        metadata: {
          workspaceId,
          invitationId: invitation.id,
          inviteeId: invitee?.id ?? null,
        },
      },
    });

    if (!invitee) {
      return null;
    }

    return tx.notification.create({
      data: {
        userId: invitee.id,
        type: 'INVITATION_DECISION',
        title: 'Rechazaron tu solicitud',
        body: `No se aprobó tu ingreso a "${workspace.name}".`,
      },
    });
  });

  if (notification) {
    pushNotification(notification);
  }

  return {
    invitation: toInvitationDto({ ...invitation, status: 'REVOKED' }, invitee?.displayName ?? null),
  };
}

async function acceptInvitation(
  userId: string,
  userEmail: string,
  tokenPlain: string,
): Promise<AcceptInvitationResultDto> {
  const invalidError = new AppError(
    400,
    'INVALID_OR_EXPIRED_INVITATION',
    'La invitación no es válida o venció.',
  );

  const tokenHash = createHash('sha256').update(tokenPlain).digest('hex');
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash },
    include: { workspace: true },
  });

  if (
    !invitation ||
    (invitation.status !== 'PENDING' && invitation.status !== 'AWAITING_APPROVAL') ||
    invitation.expiresAt < new Date() ||
    invitation.workspace.deletedAt !== null
  ) {
    throw invalidError;
  }

  // Defensa adicional no pedida explícitamente en el enunciado pero necesaria
  // para no permitir que una sesión distinta a la del correo invitado use un
  // token que llegó, por ejemplo, a una bandeja compartida: solo la cuenta
  // cuyo email coincide con el de la invitación puede aceptarla. Mismo error
  // uniforme que "no existe/venció" (nunca un código distinto que confirme
  // que el token sí correspondía a una invitación real, solo que era ajena
  // — mismo principio ya aplicado en requireMembership de este módulo).
  if (invitation.email !== userEmail) {
    throw invalidError;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, displayName: true, emailVerifiedAt: true },
  });
  if (!user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'La sesión no es válida.');
  }

  return requestInvitationApproval(invitation, invitation.workspace, user);
}

/** Invitaciones PENDING dirigidas al correo del usuario autenticado — la
 * bandeja "invitaciones para mí" dentro de la app, independiente de que el
 * correo de invitación haya llegado o no (ver mailService.sendWorkspaceInvitationEmail
 * y la limitación conocida de Resend con el dominio de pruebas,
 * docs/01-arquitectura.md). El invitado ya puede ver y aceptar desde acá
 * aunque el email nunca le haya llegado. */
async function listMyInvitations(userEmail: string): Promise<MyInvitationDto[]> {
  const now = new Date();
  // También las caducadas de los últimos días (con `expired: true`): así el
  // invitado ve "caducó, pide que te la vuelvan a enviar" en vez de que la
  // invitación desaparezca sin explicación. Las AWAITING_APPROVAL se listan
  // para que vea que su solicitud está en espera.
  const invitations = await prisma.invitation.findMany({
    where: {
      email: userEmail,
      status: { in: ['PENDING', 'AWAITING_APPROVAL'] },
      expiresAt: { gt: new Date(now.getTime() - EXPIRED_INVITATION_VISIBLE_MS) },
    },
    include: { workspace: true },
    orderBy: { createdAt: 'desc' },
  });

  return invitations
    .filter((invitation) => invitation.workspace.deletedAt === null)
    .map((invitation) => ({
      ...toInvitationDto(invitation),
      workspaceName: invitation.workspace.name,
      expired: invitation.expiresAt < now,
    }));
}

/** Igual que acceptInvitation, pero identificando la invitación por id en
 * vez de por el token del correo — para aceptar desde la bandeja dentro de
 * la app. La seguridad real es la misma en ambos casos: coincidir con
 * `invitation.email`, el token solo era necesario para que el link de
 * correo pudiera identificar la invitación sin que el usuario tuviera que
 * buscarla; acá ya viene autenticado y la lista ya está filtrada por su
 * propio correo. */
async function acceptInvitationById(
  userId: string,
  userEmail: string,
  invitationId: string,
): Promise<AcceptInvitationResultDto> {
  const notFoundError = new AppError(
    404,
    'INVITATION_NOT_FOUND',
    'Esa invitación no existe o ya no está pendiente.',
  );

  const invitation = await prisma.invitation.findUnique({
    where: { id: invitationId },
    include: { workspace: true },
  });

  // Mismo criterio que acceptInvitation: nunca dejar que una cuenta acepte
  // una invitación dirigida a otro correo, aunque conozca el id. Se comprueba
  // ANTES de distinguir "caducó", para que ese aviso específico solo lo vea
  // el dueño del correo y no filtre nada a terceros.
  if (
    !invitation ||
    invitation.workspace.deletedAt !== null ||
    invitation.email !== userEmail ||
    (invitation.status !== 'PENDING' && invitation.status !== 'AWAITING_APPROVAL')
  ) {
    throw notFoundError;
  }

  if (invitation.expiresAt < new Date()) {
    throw new AppError(
      410,
      'INVITATION_EXPIRED',
      'La invitación caducó. Pide que te la vuelvan a enviar.',
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, displayName: true, emailVerifiedAt: true },
  });
  if (!user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'La sesión no es válida.');
  }

  return requestInvitationApproval(invitation, invitation.workspace, user);
}

export const workspacesService = {
  createWorkspace,
  listWorkspaces,
  getWorkspaceById,
  updateWorkspace,
  deleteWorkspace,
  listMembers,
  updateMemberRole,
  removeMember,
  transferOwnership,
  createInvitation,
  listInvitations,
  revokeInvitation,
  approveInvitation,
  rejectInvitation,
  acceptInvitation,
  listMyInvitations,
  acceptInvitationById,
};

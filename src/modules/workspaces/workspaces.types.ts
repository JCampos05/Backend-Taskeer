import type { InvitationStatus, WorkspaceRole } from '@prisma/client';

// DTOs propios del módulo workspaces. El Backend no comparte paquete de
// tipos con el Frontend por ahora — cada uno define los suyos (ver
// docs/01-arquitectura.md).

export interface WorkspaceDto {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMemberDto {
  userId: string;
  email: string;
  displayName: string;
  role: WorkspaceRole;
  createdAt: string;
}

export interface InvitationDto {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  status: InvitationStatus;
  invitedById: string;
  expiresAt: string;
  createdAt: string;
}

// Invitación pendiente vista por quien la recibió (todavía no es miembro,
// así que no puede pedir GET /workspaces/:id para saber el nombre — se
// incluye acá para que la bandeja de "invitaciones para mí" no necesite una
// segunda llamada).
export interface MyInvitationDto extends InvitationDto {
  workspaceName: string;
}

export interface AcceptInvitationResultDto {
  workspace: WorkspaceDto;
  // true si el usuario ya era miembro del workspace antes de aceptar (no se
  // duplicó membresía, la invitación igual se marca ACCEPTED) — ver decisión
  // documentada en workspaces.service.ts, acceptInvitation().
  alreadyMember: boolean;
}

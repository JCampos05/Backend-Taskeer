import type { InvitationStatus, WorkspaceRole } from '@prisma/client';

// DTOs propios del módulo workspaces. El Backend no comparte paquete de
// tipos con el Frontend por ahora — cada uno define los suyos (ver
// docs/01-arquitectura.md).

export interface WorkspaceDto {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  // Workspace "Personal" del usuario: no se borra, no se transfiere, no se
  // invita a nadie y no cuenta contra el límite de workspaces del plan.
  isPersonal: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Elemento de GET /workspaces: el workspace más el rol que tiene quien lo pide
 * (para decidir en la UI qué acciones mostrar). */
export interface WorkspaceListItemDto extends WorkspaceDto {
  myRole: 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER';
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
  // Solo se llena en GET /workspaces/:id/invitations para las que están en
  // AWAITING_APPROVAL: nombre de la cuenta que aceptó, para que quien aprueba
  // pueda decidir si es la persona que esperaba. null en el resto.
  inviteeDisplayName: string | null;
  // Solo en la misma lista y para las mismas solicitudes: true si la cuenta
  // que aceptó tiene el correo verificado de verdad (hoy, solo por Google).
  // false = cualquiera pudo registrarse con ese correo, así que quien aprueba
  // debe confirmar por otro medio que es la persona esperada. null en el resto.
  inviteeEmailVerified: boolean | null;
}

// Invitación pendiente vista por quien la recibió (todavía no es miembro,
// así que no puede pedir GET /workspaces/:id para saber el nombre — se
// incluye acá para que la bandeja de "invitaciones para mí" no necesite una
// segunda llamada).
export interface MyInvitationDto extends InvitationDto {
  workspaceName: string;
  // true si ya pasó expiresAt: se sigue listando unos días para poder decir
  // "caducó, pide que te la vuelvan a enviar" en vez de que desaparezca sin
  // explicación.
  expired: boolean;
}

export interface AcceptInvitationResultDto {
  workspace: WorkspaceDto;
  // true si el usuario ya era miembro del workspace antes de aceptar (no se
  // duplicó membresía, la invitación igual se marca ACCEPTED) — ver decisión
  // documentada en workspaces.service.ts, acceptInvitation().
  alreadyMember: boolean;
  // true si aceptar NO te hizo miembro todavía: la solicitud quedó esperando
  // que un OWNER/ADMIN la apruebe (ver InvitationStatus.AWAITING_APPROVAL).
  awaitingApproval: boolean;
}

export interface InvitationDecisionResultDto {
  invitation: InvitationDto;
}

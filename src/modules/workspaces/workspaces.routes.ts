import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../../middlewares/requireAuth';
import { validate } from '../../middlewares/validate';
import { workspacesController } from './workspaces.controller';
import {
  acceptInvitationByIdSchema,
  acceptInvitationSchema,
  createInvitationSchema,
  createWorkspaceSchema,
  listInvitationsSchema,
  memberParamsSchema,
  revokeInvitationSchema,
  transferOwnershipSchema,
  updateMemberRoleSchema,
  updateWorkspaceSchema,
  workspaceIdParamSchema,
} from './workspaces.schema';

export const workspacesRouter = Router();

// Aunque ya exige sesión + rol OWNER/ADMIN + correo verificado, sin límite
// propio cualquier cuenta legítima podría spamear invitaciones a direcciones
// ajenas — superficie de abuso de reputación de envío, no de auth.
const invitationRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Demasiadas invitaciones enviadas. Intenta de nuevo más tarde.',
    },
  },
});

// Todo lo de workspaces requiere sesión activa — requireAuth solo resuelve
// identidad (req.auth), nunca el nivel de permiso dentro del workspace; cada
// método de workspaces.service.ts verifica membresía/rol explícitamente
// contra WorkspaceMember antes de cada acción.

workspacesRouter.post(
  '/workspaces',
  requireAuth,
  validate(createWorkspaceSchema),
  workspacesController.create,
);

workspacesRouter.get('/workspaces', requireAuth, workspacesController.list);

workspacesRouter.get(
  '/workspaces/:id',
  requireAuth,
  validate(workspaceIdParamSchema),
  workspacesController.getById,
);

workspacesRouter.patch(
  '/workspaces/:id',
  requireAuth,
  validate(updateWorkspaceSchema),
  workspacesController.update,
);

workspacesRouter.delete(
  '/workspaces/:id',
  requireAuth,
  validate(workspaceIdParamSchema),
  workspacesController.remove,
);

workspacesRouter.get(
  '/workspaces/:id/members',
  requireAuth,
  validate(workspaceIdParamSchema),
  workspacesController.listMembers,
);

workspacesRouter.patch(
  '/workspaces/:id/members/:userId',
  requireAuth,
  validate(updateMemberRoleSchema),
  workspacesController.updateMemberRole,
);

workspacesRouter.delete(
  '/workspaces/:id/members/:userId',
  requireAuth,
  validate(memberParamsSchema),
  workspacesController.removeMember,
);

workspacesRouter.post(
  '/workspaces/:id/transfer-ownership',
  requireAuth,
  validate(transferOwnershipSchema),
  workspacesController.transferOwnership,
);

workspacesRouter.post(
  '/workspaces/:id/invitations',
  requireAuth,
  invitationRateLimit,
  validate(createInvitationSchema),
  workspacesController.createInvitation,
);

workspacesRouter.get(
  '/workspaces/:id/invitations',
  requireAuth,
  validate(listInvitationsSchema),
  workspacesController.listInvitations,
);

workspacesRouter.delete(
  '/workspaces/:id/invitations/:invitationId',
  requireAuth,
  validate(revokeInvitationSchema),
  workspacesController.revokeInvitation,
);

// Nivel raíz del módulo (no anidada bajo /workspaces/:id) porque quien acepta
// no conoce de antemano el id del workspace — solo el token de invitación.
workspacesRouter.post(
  '/invitations/accept',
  requireAuth,
  validate(acceptInvitationSchema),
  workspacesController.acceptInvitation,
);

// Bandeja de invitaciones pendientes dirigidas al correo del usuario
// autenticado — no depende de que el correo de invitación haya llegado
// (ver limitación conocida de Resend en docs/01-arquitectura.md). Nivel
// raíz por el mismo motivo que /invitations/accept: quien las ve no conoce
// de antemano en qué workspace están.
workspacesRouter.get('/invitations/mine', requireAuth, workspacesController.listMyInvitations);

workspacesRouter.post(
  '/invitations/:invitationId/accept',
  requireAuth,
  validate(acceptInvitationByIdSchema),
  workspacesController.acceptInvitationById,
);

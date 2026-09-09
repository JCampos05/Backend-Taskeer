import type { Request, Response, NextFunction } from 'express';
import { workspacesService } from './workspaces.service';
import type {
  AcceptInvitationByIdParams,
  AcceptInvitationInput,
  CreateInvitationInput,
  CreateWorkspaceInput,
  MemberParams,
  RevokeInvitationParams,
  TransferOwnershipInput,
  UpdateMemberRoleInput,
  UpdateWorkspaceInput,
  WorkspaceIdParams,
} from './workspaces.schema';

// El controller nunca llama a Prisma directamente ni contiene lógica de
// negocio — solo adapta req/res y delega todo a workspaces.service.

async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const input = req.body as CreateWorkspaceInput;
    const workspace = await workspacesService.createWorkspace(req.auth!.sub, input);
    res.status(201).json({ workspace });
  } catch (err) {
    next(err);
  }
}

async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const workspaces = await workspacesService.listWorkspaces(req.auth!.sub);
    res.status(200).json({ workspaces });
  } catch (err) {
    next(err);
  }
}

async function getById(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params as unknown as WorkspaceIdParams;
    const workspace = await workspacesService.getWorkspaceById(id, req.auth!.sub);
    res.status(200).json({ workspace });
  } catch (err) {
    next(err);
  }
}

async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params as unknown as WorkspaceIdParams;
    const input = req.body as UpdateWorkspaceInput;
    const workspace = await workspacesService.updateWorkspace(id, req.auth!.sub, input);
    res.status(200).json({ workspace });
  } catch (err) {
    next(err);
  }
}

async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params as unknown as WorkspaceIdParams;
    await workspacesService.deleteWorkspace(id, req.auth!.sub);
    res.status(200).json({ deleted: true });
  } catch (err) {
    next(err);
  }
}

async function listMembers(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params as unknown as WorkspaceIdParams;
    const members = await workspacesService.listMembers(id, req.auth!.sub);
    res.status(200).json({ members });
  } catch (err) {
    next(err);
  }
}

async function updateMemberRole(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, userId } = req.params as unknown as MemberParams;
    const input = req.body as UpdateMemberRoleInput;
    const member = await workspacesService.updateMemberRole(id, req.auth!.sub, userId, input);
    res.status(200).json({ member });
  } catch (err) {
    next(err);
  }
}

async function removeMember(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, userId } = req.params as unknown as MemberParams;
    await workspacesService.removeMember(id, req.auth!.sub, userId);
    res.status(200).json({ removed: true });
  } catch (err) {
    next(err);
  }
}

async function transferOwnership(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params as unknown as WorkspaceIdParams;
    const input = req.body as TransferOwnershipInput;
    const workspace = await workspacesService.transferOwnership(id, req.auth!.sub, input);
    res.status(200).json({ workspace });
  } catch (err) {
    next(err);
  }
}

async function createInvitation(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params as unknown as WorkspaceIdParams;
    const input = req.body as CreateInvitationInput;
    const invitation = await workspacesService.createInvitation(id, req.auth!.sub, input);
    res.status(201).json({ invitation });
  } catch (err) {
    next(err);
  }
}

async function listInvitations(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params as unknown as WorkspaceIdParams;
    const invitations = await workspacesService.listInvitations(id, req.auth!.sub);
    res.status(200).json({ invitations });
  } catch (err) {
    next(err);
  }
}

async function revokeInvitation(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, invitationId } = req.params as unknown as RevokeInvitationParams;
    await workspacesService.revokeInvitation(id, req.auth!.sub, invitationId);
    res.status(200).json({ revoked: true });
  } catch (err) {
    next(err);
  }
}

async function acceptInvitation(req: Request, res: Response, next: NextFunction) {
  try {
    const { token } = req.query as unknown as AcceptInvitationInput;
    const result = await workspacesService.acceptInvitation(
      req.auth!.sub,
      req.auth!.email,
      token,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function listMyInvitations(req: Request, res: Response, next: NextFunction) {
  try {
    const invitations = await workspacesService.listMyInvitations(req.auth!.email);
    res.status(200).json({ invitations });
  } catch (err) {
    next(err);
  }
}

async function acceptInvitationById(req: Request, res: Response, next: NextFunction) {
  try {
    const { invitationId } = req.params as unknown as AcceptInvitationByIdParams;
    const result = await workspacesService.acceptInvitationById(
      req.auth!.sub,
      req.auth!.email,
      invitationId,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export const workspacesController = {
  create,
  list,
  getById,
  update,
  remove,
  listMembers,
  updateMemberRole,
  removeMember,
  transferOwnership,
  createInvitation,
  listInvitations,
  revokeInvitation,
  acceptInvitation,
  listMyInvitations,
  acceptInvitationById,
};

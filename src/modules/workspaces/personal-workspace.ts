import type { Prisma, PrismaClient } from '@prisma/client';

// Workspace "Personal" de cada usuario (Workspace.isPersonal). Vive en su
// propio archivo, sin depender de workspaces.service.ts, para que auth.service
// pueda crearlo en la misma transacción del registro sin importar todo el
// servicio de workspaces (correo, entitlements, notificaciones).

type Db = Prisma.TransactionClient | PrismaClient;

/** Slug estable y único por usuario (el id es único); mismo criterio que la
 * migración que rellena a los usuarios existentes. */
export function personalWorkspaceSlug(userId: string): string {
  return `personal-${userId.replace(/-/g, '')}`;
}

/** Crea el workspace Personal del usuario y su membresía OWNER. Pensado para
 * llamarse dentro de la transacción que crea al usuario. */
export async function createPersonalWorkspace(db: Db, userId: string) {
  const workspace = await db.workspace.create({
    data: {
      name: 'Personal',
      slug: personalWorkspaceSlug(userId),
      ownerId: userId,
      isPersonal: true,
    },
  });

  await db.workspaceMember.create({
    data: { workspaceId: workspace.id, userId, role: 'OWNER' },
  });

  return workspace;
}

/** Devuelve el workspace Personal del usuario, creándolo si falta (cuentas
 * anteriores a la migración que no hayan quedado rellenadas, o creadas por
 * otra vía). Idempotente y tolerante a la carrera: si dos peticiones lo crean
 * a la vez, la perdedora vuelve a leer el de la ganadora. */
export async function ensurePersonalWorkspace(db: PrismaClient, userId: string) {
  const existing = await db.workspace.findFirst({
    where: { ownerId: userId, isPersonal: true, deletedAt: null },
  });
  if (existing) return existing;

  try {
    return await db.$transaction((tx) => createPersonalWorkspace(tx, userId));
  } catch (err) {
    // P2002: el slug (único por usuario) ya lo creó una petición concurrente.
    if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002') {
      const created = await db.workspace.findFirst({
        where: { ownerId: userId, isPersonal: true, deletedAt: null },
      });
      if (created) return created;
    }
    throw err;
  }
}

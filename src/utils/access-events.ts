import type { Prisma, PrismaClient, WorkspaceRole } from '@prisma/client';

// Registro de cambios de acceso para la sincronización móvil (ver AccessEvent en
// schema.prisma). Lo escriben los services que agregan o quitan miembros y mueven
// tableros; solo lo lee modules/sync. Escribirlo es parte de la MISMA operación
// que cambia el acceso: si la operación se revierte, el evento también.

type Db = Prisma.TransactionClient | PrismaClient;

/** Eventos de pérdida de acceso de `userId` a un workspace entero: uno del
 * workspace (boardId nulo) y uno por cada tablero normal vivo, para que la app
 * pueda retirar cada tablero (`boardAccess` con `deletedAt`). */
export async function buildWorkspaceRevocationEvents(
  db: Db,
  userId: string,
  workspaceId: string,
  role: WorkspaceRole,
): Promise<Prisma.AccessEventCreateManyInput[]> {
  const boards = await db.board.findMany({
    where: { workspaceId, isList: false, deletedAt: null },
    select: { id: true },
  });
  return [
    { userId, workspaceId, boardId: null, kind: 'REVOKED', role },
    ...boards.map(
      (b): Prisma.AccessEventCreateManyInput => ({
        userId,
        workspaceId,
        boardId: b.id,
        kind: 'REVOKED',
        role,
      }),
    ),
  ];
}

/** `userId` ganó acceso a un workspace entero (alta de miembro). Fuerza un
 * snapshot en sus dispositivos: el contenido viejo del workspace ya quedó detrás
 * de su cursor y no volvería a emitirse de otra forma. */
export function recordWorkspaceGrant(db: Db, userId: string, workspaceId: string) {
  return db.accessEvent.create({ data: { userId, workspaceId, kind: 'GRANTED' } });
}

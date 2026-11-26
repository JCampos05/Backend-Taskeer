import type { Prisma } from '@prisma/client';

/** Bloquea la fila de un workspace (`SELECT ... FOR UPDATE`) hasta que termine
 * la transacción. Se usa para serializar las operaciones que compiten por las
 * listas planas de un workspace Personal: las mutaciones de /lists y también
 * crear o mover una tarea hacia una lista (sin esto, borrar una lista en
 * paralelo dejaba tareas vivas en una lista ya borrada). Debe ser lo primero
 * que hace la transacción, y siempre en este orden (workspace y luego filas
 * hijas) para no provocar interbloqueos. `workspaceId` viene de la base de
 * datos, nunca del cliente, y además va parametrizado. */
export async function lockWorkspaceRow(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
}

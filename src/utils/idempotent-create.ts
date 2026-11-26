import { AppError } from '../errors/AppError';

/** Resultado de una creación que puede ser idempotente: `created` es false
 * cuando el cliente repitió una creación con un `id` que ya existía en el
 * mismo contexto y se devolvió el registro existente (el controlador responde
 * 200 en vez de 201). */
export interface CreatedResult<T> {
  value: T;
  created: boolean;
}

/** Violación de una restricción única (P2002) — p. ej. dos creaciones
 * simultáneas con el mismo `id` de cliente. */
export function isUniqueConstraintError(err: unknown): boolean {
  // Duck-typing en vez de `instanceof`, igual que auth.service.ts y
  // workspaces.service.ts: `instanceof` puede fallar entre copias del cliente
  // de Prisma y rompería justo la garantía de idempotencia (un 500 en vez de
  // un 200 en la carrera).
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002'
  );
}

/** Error genérico cuando el `id` enviado por el cliente ya pertenece a otro
 * contexto (o a un registro borrado). Deliberadamente no dice de quién es ni
 * qué es: nunca revela la existencia de un recurso ajeno. */
export function idAlreadyInUseError(): AppError {
  return new AppError(409, 'ID_ALREADY_IN_USE', 'Ese identificador ya está en uso.');
}

// DTOs propios del módulo lists. El Backend no comparte paquete de tipos con el
// Frontend por ahora — cada uno define los suyos (ver docs/01-arquitectura.md).

/** Una "lista plana" de la app móvil: un Board oculto (`isList`) de una sola
 * columna dentro del workspace Personal del usuario. Nunca se exponen el
 * workspace, el slug ni ids autoincrementales: solo UUID. */
export interface ListDto {
  id: string;
  name: string;
  /** `Board.listPosition` — orden de la lista entre las del usuario (0..n-1). */
  position: number;
  /** Id de la única columna viva del board-lista; las tareas de la lista son
   * `Task` normales con este `columnId`. */
  columnId: string;
  /** ISO 8601 en UTC. */
  createdAt: string;
  /** ISO 8601 en UTC. */
  updatedAt: string;
}

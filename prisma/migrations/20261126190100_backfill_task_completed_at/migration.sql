-- Relleno de datos (migración aparte de los ALTER: MySQL no hace DDL
-- transaccional, así que separarlo evita dejar el esquema a medias si esto
-- fallara). Las tareas que hoy están en una columna de cierre
-- (Column.isDoneColumn) pasan a contar como completadas, con su última
-- modificación como instante de cierre (aproximación: una edición posterior
-- al cierre ya movió updatedAt). `updatedAt` no se toca: en MySQL la columna
-- no tiene ON UPDATE, Prisma lo gestiona desde el cliente. Idempotente.
UPDATE `tasks` t
JOIN `columns` c ON c.`id` = t.`columnId`
SET t.`completedAt` = t.`updatedAt`
WHERE c.`isDoneColumn` = 1
  AND c.`deletedAt` IS NULL
  AND t.`deletedAt` IS NULL
  AND t.`completedAt` IS NULL;

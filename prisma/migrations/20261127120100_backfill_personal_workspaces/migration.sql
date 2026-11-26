-- Relleno de datos (migración aparte de los ALTER: MySQL no hace DDL
-- transaccional). Crea el workspace "Personal" de cada usuario que todavía no
-- tiene uno, y lo hace miembro OWNER. Idempotente: se puede repetir sin
-- duplicar nada.
--
-- - El slug se deriva del id del usuario (único por construcción), igual que
--   personalWorkspaceSlug() en la aplicación. La existencia se comprueba POR
--   SLUG (que es único global, incluso con soft delete) para que un workspace
--   borrado lógicamente no haga fallar la migración.
-- - Los ids son UUID v4 (como los que genera Prisma). UUID() de MySQL genera
--   v1, que filtra fecha y MAC del servidor, y el id de workspace es público.
-- - Las fechas en UTC (UTC_TIMESTAMP), nunca NOW(): la regla del proyecto es
--   guardar siempre en UTC, sin depender de la zona horaria de la sesión.
INSERT INTO `workspaces` (`id`, `name`, `slug`, `ownerId`, `createdAt`, `updatedAt`, `isPersonal`)
SELECT
  LOWER(CONCAT(
    HEX(RANDOM_BYTES(4)), '-',
    HEX(RANDOM_BYTES(2)), '-4',
    SUBSTR(HEX(RANDOM_BYTES(2)), 2), '-',
    ELT(1 + FLOOR(RAND() * 4), '8', '9', 'a', 'b'),
    SUBSTR(HEX(RANDOM_BYTES(2)), 2), '-',
    HEX(RANDOM_BYTES(6))
  )),
  'Personal',
  CONCAT('personal-', REPLACE(u.`id`, '-', '')),
  u.`id`,
  UTC_TIMESTAMP(3),
  UTC_TIMESTAMP(3),
  true
FROM `users` u
WHERE NOT EXISTS (
  SELECT 1 FROM `workspaces` w
  WHERE w.`slug` = CONCAT('personal-', REPLACE(u.`id`, '-', ''))
);

INSERT INTO `workspace_members` (`id`, `workspaceId`, `userId`, `role`, `createdAt`)
SELECT
  LOWER(CONCAT(
    HEX(RANDOM_BYTES(4)), '-',
    HEX(RANDOM_BYTES(2)), '-4',
    SUBSTR(HEX(RANDOM_BYTES(2)), 2), '-',
    ELT(1 + FLOOR(RAND() * 4), '8', '9', 'a', 'b'),
    SUBSTR(HEX(RANDOM_BYTES(2)), 2), '-',
    HEX(RANDOM_BYTES(6))
  )),
  w.`id`,
  w.`ownerId`,
  'OWNER',
  UTC_TIMESTAMP(3)
FROM `workspaces` w
WHERE w.`isPersonal` = true
  AND w.`deletedAt` IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM `workspace_members` m
    WHERE m.`workspaceId` = w.`id` AND m.`userId` = w.`ownerId`
  );

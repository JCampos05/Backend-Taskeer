-- Relleno de datos (migración aparte de los ALTER: MySQL no hace DDL
-- transaccional). Las filas que ya existían toman como última modificación la
-- fecha que mejor la aproxima, en vez del instante en que se aplicó la
-- migración (así la primera sincronización no las trata todas como "recién
-- cambiadas"). Idempotente: tras la primera pasada ya no coinciden.
UPDATE `workspace_members`
SET `updatedAt` = `createdAt`
WHERE `updatedAt` > `createdAt`;

UPDATE `invitations`
SET `updatedAt` = `createdAt`
WHERE `updatedAt` > `createdAt`;

UPDATE `reminders`
SET `updatedAt` = COALESCE(`sentAt`, `createdAt`)
WHERE `updatedAt` > COALESCE(`sentAt`, `createdAt`);

-- Relleno de datos (migración aparte de los ALTER: MySQL no hace DDL
-- transaccional). Las marcas de Mi día que ya existían toman su fecha de alta
-- como última modificación (en vez del instante en que se aplicó la
-- migración), que es lo más cercano a la verdad. Idempotente.
UPDATE `my_day_tasks`
SET `updatedAt` = `addedAt`
WHERE `deletedAt` IS NULL
  AND `updatedAt` > `addedAt`;

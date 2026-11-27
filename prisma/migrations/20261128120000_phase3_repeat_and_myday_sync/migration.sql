-- AlterTable
ALTER TABLE `my_day_tasks` ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- El DEFAULT solo sirve para rellenar las filas que ya existen: en el schema
-- `updatedAt` es @updatedAt (lo gestiona Prisma, sin default en la base), así
-- que se quita para que no haya drift.
ALTER TABLE `my_day_tasks` ALTER COLUMN `updatedAt` DROP DEFAULT;

-- AlterTable
ALTER TABLE `tasks` ADD COLUMN `repeatAnchorDay` INTEGER NULL,
    ADD COLUMN `repeatInterval` INTEGER NULL,
    ADD COLUMN `repeatSuccessorId` CHAR(36) NULL,
    ADD COLUMN `repeatUnit` VARCHAR(10) NULL,
    ADD COLUMN `repeatWeekdays` INTEGER NULL;

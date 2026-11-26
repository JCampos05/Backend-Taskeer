-- AlterTable
ALTER TABLE `columns` ADD COLUMN `deletedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `subtasks` ADD COLUMN `deletedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `tasks` ADD COLUMN `completedAt` DATETIME(3) NULL;

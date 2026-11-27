-- AlterTable
ALTER TABLE `reminders` ADD COLUMN `createdById` CHAR(36) NULL,
    ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `origin` ENUM('SERVER', 'MOBILE') NOT NULL DEFAULT 'SERVER';

-- CreateIndex
CREATE INDEX `reminders_createdById_origin_updatedAt_idx` ON `reminders`(`createdById`, `origin`, `updatedAt`);

-- AddForeignKey
ALTER TABLE `reminders` ADD CONSTRAINT `reminders_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE `invitations` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- AlterTable
ALTER TABLE `reminders` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- AlterTable
ALTER TABLE `workspace_members` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- Los DEFAULT solo sirven para rellenar las filas que ya existen: en el schema
-- `updatedAt` es @updatedAt (lo gestiona Prisma, sin default en la base), así
-- que se quitan para que no haya drift.
ALTER TABLE `invitations` ALTER COLUMN `updatedAt` DROP DEFAULT;
ALTER TABLE `reminders` ALTER COLUMN `updatedAt` DROP DEFAULT;
ALTER TABLE `workspace_members` ALTER COLUMN `updatedAt` DROP DEFAULT;

-- CreateIndex
CREATE INDEX `boards_updatedAt_idx` ON `boards`(`updatedAt`);

-- CreateIndex
CREATE INDEX `columns_updatedAt_idx` ON `columns`(`updatedAt`);

-- CreateIndex
CREATE INDEX `invitations_updatedAt_idx` ON `invitations`(`updatedAt`);

-- CreateIndex
CREATE INDEX `my_day_tasks_userId_updatedAt_idx` ON `my_day_tasks`(`userId`, `updatedAt`);

-- CreateIndex
CREATE INDEX `reminders_updatedAt_idx` ON `reminders`(`updatedAt`);

-- CreateIndex
CREATE INDEX `subtasks_updatedAt_idx` ON `subtasks`(`updatedAt`);

-- CreateIndex
CREATE INDEX `tasks_updatedAt_idx` ON `tasks`(`updatedAt`);

-- CreateIndex
CREATE INDEX `workspace_members_updatedAt_idx` ON `workspace_members`(`updatedAt`);

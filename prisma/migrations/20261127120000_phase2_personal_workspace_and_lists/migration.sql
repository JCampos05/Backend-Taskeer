-- AlterTable
ALTER TABLE `boards` ADD COLUMN `isList` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `listPosition` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `workspaces` ADD COLUMN `isPersonal` BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX `boards_workspaceId_isList_listPosition_idx` ON `boards`(`workspaceId`, `isList`, `listPosition`);

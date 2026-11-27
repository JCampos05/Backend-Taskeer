-- CreateTable
CREATE TABLE `access_events` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `workspaceId` CHAR(36) NOT NULL,
    `boardId` CHAR(36) NULL,
    `kind` ENUM('GRANTED', 'REVOKED') NOT NULL,
    `role` ENUM('OWNER', 'ADMIN', 'EDITOR', 'VIEWER') NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `access_events_userId_kind_createdAt_idx`(`userId`, `kind`, `createdAt`),
    INDEX `access_events_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `access_events` ADD CONSTRAINT `access_events_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `access_events` ADD CONSTRAINT `access_events_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `access_events` ADD CONSTRAINT `access_events_boardId_fkey` FOREIGN KEY (`boardId`) REFERENCES `boards`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

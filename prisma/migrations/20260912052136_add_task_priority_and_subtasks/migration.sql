-- CreateTable
CREATE TABLE `subtasks` (
    `id` CHAR(36) NOT NULL,
    `taskId` CHAR(36) NOT NULL,
    `assigneeId` CHAR(36) NULL,
    `title` VARCHAR(200) NOT NULL,
    `dueAt` DATETIME(3) NULL,
    `completed` BOOLEAN NOT NULL DEFAULT false,
    `position` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `subtasks_taskId_position_idx`(`taskId`, `position`),
    INDEX `subtasks_assigneeId_idx`(`assigneeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `subtasks` ADD CONSTRAINT `subtasks_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `tasks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subtasks` ADD CONSTRAINT `subtasks_assigneeId_fkey` FOREIGN KEY (`assigneeId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

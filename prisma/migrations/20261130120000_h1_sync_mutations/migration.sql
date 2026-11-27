-- CreateTable
CREATE TABLE `sync_mutations` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `clientMutationId` CHAR(36) NOT NULL,
    `status` ENUM('APPLIED', 'CONFLICT', 'REJECTED') NOT NULL,
    `resultJson` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sync_mutations_createdAt_idx`(`createdAt`),
    UNIQUE INDEX `sync_mutations_userId_clientMutationId_key`(`userId`, `clientMutationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sync_mutations` ADD CONSTRAINT `sync_mutations_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

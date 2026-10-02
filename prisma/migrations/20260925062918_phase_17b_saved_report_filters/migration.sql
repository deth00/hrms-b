-- CreateTable
CREATE TABLE `saved_report_filters` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `report_type` ENUM('EMPLOYEES', 'ATTENDANCE', 'LEAVE', 'OVERTIME', 'PAYROLL', 'PAYMENTS', 'ACCOUNTING') NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `filters_json` JSON NOT NULL,
    `group_by` VARCHAR(40) NULL,
    `sort_by` VARCHAR(40) NULL,
    `sort_dir` VARCHAR(4) NULL,
    `columns_json` JSON NULL,
    `is_default` BOOLEAN NOT NULL DEFAULT false,
    `default_key` VARCHAR(80) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `saved_report_filters_default_key_key`(`default_key`),
    INDEX `saved_report_filters_user_id_report_type_idx`(`user_id`, `report_type`),
    UNIQUE INDEX `saved_report_filters_user_id_report_type_name_key`(`user_id`, `report_type`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `saved_report_filters` ADD CONSTRAINT `saved_report_filters_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

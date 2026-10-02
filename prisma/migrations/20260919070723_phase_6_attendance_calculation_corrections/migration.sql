-- AlterTable
ALTER TABLE `attendance_records` ADD COLUMN `arrival_delay_minutes` INTEGER NULL,
    ADD COLUMN `calculated_at` DATETIME(3) NULL,
    ADD COLUMN `calculation_status` ENUM('PRESENT', 'LATE', 'EARLY_LEAVE', 'LATE_AND_EARLY', 'INCOMPLETE') NULL,
    ADD COLUMN `calculation_version` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `early_leave_minutes` INTEGER NULL,
    ADD COLUMN `effective_check_in_at` DATETIME(3) NULL,
    ADD COLUMN `effective_check_out_at` DATETIME(3) NULL,
    ADD COLUMN `is_corrected` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `late_minutes` INTEGER NULL,
    ADD COLUMN `scheduled_early_leave_grace_minutes` INTEGER NULL,
    ADD COLUMN `scheduled_late_grace_minutes` INTEGER NULL,
    ADD COLUMN `scheduled_work_minutes` INTEGER NULL,
    ADD COLUMN `worked_minutes` INTEGER NULL;

-- CreateTable
CREATE TABLE `attendance_policies` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `deduct_scheduled_break` BOOLEAN NOT NULL DEFAULT true,
    `missing_check_out_grace_minutes` INTEGER NOT NULL DEFAULT 240,
    `allow_employee_correction` BOOLEAN NOT NULL DEFAULT true,
    `correction_request_window_days` INTEGER NOT NULL DEFAULT 30,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `attendance_policies_company_id_key`(`company_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_correction_requests` (
    `id` VARCHAR(191) NOT NULL,
    `employee_id` VARCHAR(191) NOT NULL,
    `attendance_record_id` VARCHAR(191) NULL,
    `work_date` DATE NOT NULL,
    `type` ENUM('MISSING_CHECK_IN', 'MISSING_CHECK_OUT', 'TIME_ADJUSTMENT', 'MISSING_BOTH') NOT NULL,
    `requested_check_in_at` DATETIME(3) NULL,
    `requested_check_out_at` DATETIME(3) NULL,
    `reason` TEXT NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `pending_key` VARCHAR(191) NULL,
    `requested_by_user_id` VARCHAR(191) NOT NULL,
    `reviewed_by_user_id` VARCHAR(191) NULL,
    `reviewed_at` DATETIME(3) NULL,
    `review_note` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `attendance_correction_requests_pending_key_key`(`pending_key`),
    INDEX `attendance_correction_requests_employee_id_work_date_idx`(`employee_id`, `work_date`),
    INDEX `attendance_correction_requests_status_created_at_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_correction_applications` (
    `id` VARCHAR(191) NOT NULL,
    `correction_request_id` VARCHAR(191) NOT NULL,
    `attendance_record_id` VARCHAR(191) NOT NULL,
    `effective_check_in_at` DATETIME(3) NULL,
    `effective_check_out_at` DATETIME(3) NULL,
    `applied_by_user_id` VARCHAR(191) NOT NULL,
    `applied_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `attendance_correction_applications_correction_request_id_key`(`correction_request_id`),
    INDEX `attendance_correction_applications_attendance_record_id_appl_idx`(`attendance_record_id`, `applied_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `attendance_policies` ADD CONSTRAINT `attendance_policies_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_correction_requests` ADD CONSTRAINT `attendance_correction_requests_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_correction_requests` ADD CONSTRAINT `attendance_correction_requests_attendance_record_id_fkey` FOREIGN KEY (`attendance_record_id`) REFERENCES `attendance_records`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_correction_requests` ADD CONSTRAINT `attendance_correction_requests_requested_by_user_id_fkey` FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_correction_requests` ADD CONSTRAINT `attendance_correction_requests_reviewed_by_user_id_fkey` FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_correction_applications` ADD CONSTRAINT `attendance_correction_applications_correction_request_id_fkey` FOREIGN KEY (`correction_request_id`) REFERENCES `attendance_correction_requests`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_correction_applications` ADD CONSTRAINT `attendance_correction_applications_attendance_record_id_fkey` FOREIGN KEY (`attendance_record_id`) REFERENCES `attendance_records`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_correction_applications` ADD CONSTRAINT `attendance_correction_applications_applied_by_user_id_fkey` FOREIGN KEY (`applied_by_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

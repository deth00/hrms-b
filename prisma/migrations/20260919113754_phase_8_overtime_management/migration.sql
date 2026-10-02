-- CreateTable
CREATE TABLE `overtime_policies` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `minimum_request_minutes` INTEGER NOT NULL DEFAULT 30,
    `maximum_request_minutes_per_day` INTEGER NOT NULL DEFAULT 480,
    `allow_before_shift` BOOLEAN NOT NULL DEFAULT true,
    `allow_after_shift` BOOLEAN NOT NULL DEFAULT true,
    `allow_off_day` BOOLEAN NOT NULL DEFAULT true,
    `allow_holiday` BOOLEAN NOT NULL DEFAULT true,
    `check_in_early_minutes` INTEGER NOT NULL DEFAULT 60,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `overtime_policies_company_id_key`(`company_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `overtime_requests` (
    `id` VARCHAR(191) NOT NULL,
    `employee_id` VARCHAR(191) NOT NULL,
    `work_date` DATE NOT NULL,
    `type` ENUM('BEFORE_SHIFT', 'AFTER_SHIFT', 'OFF_DAY', 'HOLIDAY') NOT NULL,
    `requested_start_at` DATETIME(3) NOT NULL,
    `requested_end_at` DATETIME(3) NOT NULL,
    `planned_minutes` INTEGER NOT NULL,
    `reason` TEXT NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `requested_by_user_id` VARCHAR(191) NOT NULL,
    `reviewed_by_user_id` VARCHAR(191) NULL,
    `reviewed_at` DATETIME(3) NULL,
    `review_note` TEXT NULL,
    `schedule_assignment_id` VARCHAR(191) NULL,
    `shift_id` VARCHAR(191) NULL,
    `regular_scheduled_start_at` DATETIME(3) NULL,
    `regular_scheduled_end_at` DATETIME(3) NULL,
    `is_working_day` BOOLEAN NOT NULL,
    `is_holiday` BOOLEAN NOT NULL DEFAULT false,
    `holiday_id` VARCHAR(191) NULL,
    `actual_minutes` INTEGER NULL,
    `eligible_minutes` INTEGER NULL,
    `calculation_status` ENUM('PENDING_ATTENDANCE', 'INCOMPLETE_ATTENDANCE', 'CALCULATED') NOT NULL DEFAULT 'PENDING_ATTENDANCE',
    `calculated_at` DATETIME(3) NULL,
    `calculation_version` INTEGER NOT NULL DEFAULT 0,
    `active_key` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `overtime_requests_active_key_key`(`active_key`),
    INDEX `overtime_requests_employee_id_work_date_idx`(`employee_id`, `work_date`),
    INDEX `overtime_requests_status_created_at_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `overtime_policies` ADD CONSTRAINT `overtime_policies_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `overtime_requests` ADD CONSTRAINT `overtime_requests_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `overtime_requests` ADD CONSTRAINT `overtime_requests_requested_by_user_id_fkey` FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `overtime_requests` ADD CONSTRAINT `overtime_requests_reviewed_by_user_id_fkey` FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

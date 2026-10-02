-- CreateTable
CREATE TABLE `work_locations` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `branch_id` VARCHAR(191) NULL,
    `code` VARCHAR(191) NOT NULL,
    `name_lao` VARCHAR(191) NOT NULL,
    `name_english` VARCHAR(191) NULL,
    `latitude` DOUBLE NOT NULL,
    `longitude` DOUBLE NOT NULL,
    `radius_meters` INTEGER NOT NULL,
    `require_gps` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `description` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `work_locations_company_id_branch_id_idx`(`company_id`, `branch_id`),
    UNIQUE INDEX `work_locations_company_id_code_key`(`company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_records` (
    `id` VARCHAR(191) NOT NULL,
    `employee_id` VARCHAR(191) NOT NULL,
    `work_date` DATE NOT NULL,
    `schedule_assignment_id` VARCHAR(191) NULL,
    `shift_id` VARCHAR(191) NULL,
    `scheduled_start_time` VARCHAR(5) NULL,
    `scheduled_end_time` VARCHAR(5) NULL,
    `scheduled_break_minutes` INTEGER NULL,
    `scheduled_crosses_midnight` BOOLEAN NOT NULL DEFAULT false,
    `first_check_in_at` DATETIME(3) NULL,
    `last_check_out_at` DATETIME(3) NULL,
    `status` ENUM('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'MISSING_CHECK_OUT') NOT NULL DEFAULT 'NOT_STARTED',
    `is_working_day` BOOLEAN NOT NULL DEFAULT true,
    `is_holiday` BOOLEAN NOT NULL DEFAULT false,
    `holiday_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `attendance_records_work_date_idx`(`work_date`),
    INDEX `attendance_records_employee_id_status_idx`(`employee_id`, `status`),
    UNIQUE INDEX `attendance_records_employee_id_work_date_key`(`employee_id`, `work_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_punches` (
    `id` VARCHAR(191) NOT NULL,
    `attendance_record_id` VARCHAR(191) NOT NULL,
    `employee_id` VARCHAR(191) NOT NULL,
    `type` ENUM('CHECK_IN', 'CHECK_OUT') NOT NULL,
    `punched_at` DATETIME(3) NOT NULL,
    `source` ENUM('WEB', 'MOBILE_WEB') NOT NULL,
    `latitude` DOUBLE NULL,
    `longitude` DOUBLE NULL,
    `accuracy_meters` DOUBLE NULL,
    `work_location_id` VARCHAR(191) NULL,
    `distance_meters` DOUBLE NULL,
    `location_radius_meters` INTEGER NULL,
    `ip_address` VARCHAR(64) NULL,
    `user_agent` VARCHAR(255) NULL,
    `created_by_user_id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `attendance_punches_attendance_record_id_punched_at_idx`(`attendance_record_id`, `punched_at`),
    INDEX `attendance_punches_employee_id_punched_at_idx`(`employee_id`, `punched_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `work_locations` ADD CONSTRAINT `work_locations_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `work_locations` ADD CONSTRAINT `work_locations_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_shift_id_fkey` FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_holiday_id_fkey` FOREIGN KEY (`holiday_id`) REFERENCES `holidays`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_punches` ADD CONSTRAINT `attendance_punches_attendance_record_id_fkey` FOREIGN KEY (`attendance_record_id`) REFERENCES `attendance_records`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_punches` ADD CONSTRAINT `attendance_punches_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_punches` ADD CONSTRAINT `attendance_punches_work_location_id_fkey` FOREIGN KEY (`work_location_id`) REFERENCES `work_locations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_punches` ADD CONSTRAINT `attendance_punches_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE `payroll_employee_results` ADD COLUMN `branch_id_snapshot` VARCHAR(191) NULL,
    ADD COLUMN `branch_name_snapshot` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `payroll_periods` ADD COLUMN `cycle_number` INTEGER NULL,
    ADD COLUMN `generated_by_schedule` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `payroll_schedule_id` VARCHAR(191) NULL,
    ADD COLUMN `sequence_number` INTEGER NULL;

-- AlterTable
ALTER TABLE `payroll_runs` ADD COLUMN `payroll_schedule_id` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `payroll_schedules` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name_lao` VARCHAR(191) NOT NULL,
    `name_english` VARCHAR(191) NULL,
    `pay_basis` ENUM('MONTHLY', 'DAILY') NOT NULL DEFAULT 'MONTHLY',
    `payments_per_month` ENUM('ONE', 'TWO') NOT NULL DEFAULT 'ONE',
    `anchor_date` DATE NOT NULL,
    `split_day` INTEGER NULL,
    `pay_date_rule` ENUM('PERIOD_END') NOT NULL DEFAULT 'PERIOD_END',
    `employee_scope` ENUM('ALL', 'SELECTED') NOT NULL DEFAULT 'ALL',
    `group_by_branch` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payroll_schedules_company_id_code_key`(`company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_schedule_employees` (
    `id` VARCHAR(191) NOT NULL,
    `payroll_schedule_id` VARCHAR(191) NOT NULL,
    `employee_id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payroll_schedule_employees_employee_id_idx`(`employee_id`),
    UNIQUE INDEX `payroll_schedule_employees_payroll_schedule_id_employee_id_key`(`payroll_schedule_id`, `employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `payroll_periods_payroll_schedule_id_sequence_number_key` ON `payroll_periods`(`payroll_schedule_id`, `sequence_number`);

-- AddForeignKey
ALTER TABLE `payroll_periods` ADD CONSTRAINT `payroll_periods_payroll_schedule_id_fkey` FOREIGN KEY (`payroll_schedule_id`) REFERENCES `payroll_schedules`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_payroll_schedule_id_fkey` FOREIGN KEY (`payroll_schedule_id`) REFERENCES `payroll_schedules`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_schedules` ADD CONSTRAINT `payroll_schedules_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_schedules` ADD CONSTRAINT `payroll_schedules_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_schedule_employees` ADD CONSTRAINT `payroll_schedule_employees_payroll_schedule_id_fkey` FOREIGN KEY (`payroll_schedule_id`) REFERENCES `payroll_schedules`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_schedule_employees` ADD CONSTRAINT `payroll_schedule_employees_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


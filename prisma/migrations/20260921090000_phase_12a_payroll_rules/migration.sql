-- AlterTable
ALTER TABLE `payroll_employee_results` ADD COLUMN `attendance_summary_json` JSON NULL,
    ADD COLUMN `calculation_version` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `leave_summary_json` JSON NULL,
    ADD COLUMN `overtime_summary_json` JSON NULL;

-- AlterTable
ALTER TABLE `payroll_result_items` ADD COLUMN `details_json` JSON NULL,
    MODIFY `source` ENUM('BASE_SALARY', 'RECURRING', 'MANUAL', 'PRORATED_BASE_SALARY', 'PRORATED_RECURRING', 'ATTENDANCE_DEDUCTION', 'UNPAID_LEAVE', 'LATE_DEDUCTION', 'EARLY_LEAVE_DEDUCTION', 'OVERTIME') NOT NULL;

-- AlterTable
ALTER TABLE `payroll_runs` ADD COLUMN `payroll_rule_set_id` VARCHAR(191) NULL,
    ADD COLUMN `rule_snapshot_json` JSON NULL;

-- CreateTable
CREATE TABLE `payroll_rule_sets` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `name_lao` VARCHAR(191) NOT NULL,
    `name_english` VARCHAR(191) NULL,
    `effective_from` DATE NOT NULL,
    `effective_to` DATE NULL,
    `proration_method` ENUM('CALENDAR_DAYS', 'WORKING_DAYS') NOT NULL,
    `absence_deduction_enabled` BOOLEAN NOT NULL DEFAULT false,
    `unpaid_leave_deduction_enabled` BOOLEAN NOT NULL DEFAULT false,
    `late_deduction_enabled` BOOLEAN NOT NULL DEFAULT false,
    `early_leave_deduction_enabled` BOOLEAN NOT NULL DEFAULT false,
    `minute_deduction_basis` ENUM('SCHEDULED_DAILY_MINUTES', 'STANDARD_DAILY_MINUTES') NOT NULL DEFAULT 'SCHEDULED_DAILY_MINUTES',
    `standard_monthly_days` INTEGER NULL,
    `standard_daily_minutes` INTEGER NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payroll_rule_sets_company_id_effective_from_idx`(`company_id`, `effective_from`),
    UNIQUE INDEX `payroll_rule_sets_company_id_version_key`(`company_id`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `overtime_compensation_rules` (
    `id` VARCHAR(191) NOT NULL,
    `payroll_rule_set_id` VARCHAR(191) NOT NULL,
    `overtime_type` ENUM('BEFORE_SHIFT', 'AFTER_SHIFT', 'OFF_DAY', 'HOLIDAY') NOT NULL,
    `multiplier` DECIMAL(8, 4) NOT NULL,
    `rate_basis` ENUM('BASE_SALARY_DIVISOR') NOT NULL DEFAULT 'BASE_SALARY_DIVISOR',
    `monthly_divisor_days` INTEGER NULL,
    `standard_daily_minutes` INTEGER NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `overtime_compensation_rules_payroll_rule_set_id_overtime_typ_key`(`payroll_rule_set_id`, `overtime_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_result_segments` (
    `id` VARCHAR(191) NOT NULL,
    `payroll_employee_result_id` VARCHAR(191) NOT NULL,
    `segment_start` DATE NOT NULL,
    `segment_end` DATE NOT NULL,
    `company_id_snapshot` VARCHAR(191) NOT NULL,
    `company_name_snapshot` VARCHAR(191) NOT NULL,
    `branch_id_snapshot` VARCHAR(191) NULL,
    `branch_name_snapshot` VARCHAR(191) NULL,
    `base_salary_snapshot` DECIMAL(18, 2) NOT NULL,
    `currency_code` VARCHAR(3) NOT NULL,
    `proration_method` ENUM('CALENDAR_DAYS', 'WORKING_DAYS') NOT NULL,
    `period_units` DECIMAL(8, 2) NOT NULL,
    `payable_units` DECIMAL(8, 2) NOT NULL,
    `proration_factor` DECIMAL(20, 10) NOT NULL,
    `prorated_base_salary` DECIMAL(18, 2) NOT NULL,
    `recurring_json` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payroll_result_segments_payroll_employee_result_id_idx`(`payroll_employee_result_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_payroll_rule_set_id_fkey` FOREIGN KEY (`payroll_rule_set_id`) REFERENCES `payroll_rule_sets`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_rule_sets` ADD CONSTRAINT `payroll_rule_sets_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_rule_sets` ADD CONSTRAINT `payroll_rule_sets_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `overtime_compensation_rules` ADD CONSTRAINT `overtime_compensation_rules_payroll_rule_set_id_fkey` FOREIGN KEY (`payroll_rule_set_id`) REFERENCES `payroll_rule_sets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_result_segments` ADD CONSTRAINT `payroll_result_segments_payroll_employee_result_id_fkey` FOREIGN KEY (`payroll_employee_result_id`) REFERENCES `payroll_employee_results`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


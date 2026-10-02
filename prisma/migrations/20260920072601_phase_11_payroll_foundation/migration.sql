-- CreateTable
CREATE TABLE `payroll_settings` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `currency_code` VARCHAR(3) NOT NULL,
    `pay_frequency` ENUM('MONTHLY') NOT NULL DEFAULT 'MONTHLY',
    `period_naming_pattern` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payroll_settings_company_id_key`(`company_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pay_components` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name_lao` VARCHAR(191) NOT NULL,
    `name_english` VARCHAR(191) NULL,
    `type` ENUM('EARNING', 'DEDUCTION') NOT NULL,
    `category` ENUM('ALLOWANCE', 'BONUS', 'OTHER_EARNING', 'DEDUCTION', 'OTHER_DEDUCTION') NOT NULL,
    `is_recurring` BOOLEAN NOT NULL DEFAULT true,
    `description` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `pay_components_company_id_type_idx`(`company_id`, `type`),
    UNIQUE INDEX `pay_components_company_id_code_key`(`company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_compensations` (
    `id` VARCHAR(191) NOT NULL,
    `employee_id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `base_salary` DECIMAL(18, 2) NOT NULL,
    `currency_code` VARCHAR(3) NOT NULL,
    `effective_from` DATE NOT NULL,
    `effective_to` DATE NULL,
    `reason` TEXT NULL,
    `created_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `employee_compensations_employee_id_effective_to_idx`(`employee_id`, `effective_to`),
    UNIQUE INDEX `employee_compensations_employee_id_effective_from_key`(`employee_id`, `effective_from`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_recurring_pay_components` (
    `id` VARCHAR(191) NOT NULL,
    `employee_id` VARCHAR(191) NOT NULL,
    `pay_component_id` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `effective_from` DATE NOT NULL,
    `effective_to` DATE NULL,
    `note` TEXT NULL,
    `created_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `employee_recurring_pay_components_employee_id_effective_to_idx`(`employee_id`, `effective_to`),
    UNIQUE INDEX `employee_recurring_pay_components_employee_id_pay_component__key`(`employee_id`, `pay_component_id`, `effective_from`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_periods` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `pay_date` DATE NOT NULL,
    `status` ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `created_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payroll_periods_company_id_start_date_idx`(`company_id`, `start_date`),
    UNIQUE INDEX `payroll_periods_company_id_code_key`(`company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_runs` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `period_id` VARCHAR(191) NOT NULL,
    `status` ENUM('DRAFT', 'CALCULATED', 'FINALIZED') NOT NULL DEFAULT 'DRAFT',
    `currency_code` VARCHAR(3) NOT NULL,
    `calculation_version` INTEGER NOT NULL DEFAULT 1,
    `calculated_at` DATETIME(3) NULL,
    `calculated_by_user_id` VARCHAR(191) NULL,
    `finalized_at` DATETIME(3) NULL,
    `finalized_by_user_id` VARCHAR(191) NULL,
    `created_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payroll_runs_period_id_key`(`period_id`),
    INDEX `payroll_runs_company_id_status_idx`(`company_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_employee_results` (
    `id` VARCHAR(191) NOT NULL,
    `payroll_run_id` VARCHAR(191) NOT NULL,
    `employee_id` VARCHAR(191) NOT NULL,
    `employee_code_snapshot` VARCHAR(191) NOT NULL,
    `employee_name_snapshot` VARCHAR(191) NOT NULL,
    `department_id_snapshot` VARCHAR(191) NULL,
    `department_name_snapshot` VARCHAR(191) NULL,
    `position_id_snapshot` VARCHAR(191) NULL,
    `position_name_snapshot` VARCHAR(191) NULL,
    `currency_code` VARCHAR(3) NOT NULL,
    `base_salary_snapshot` DECIMAL(18, 2) NULL,
    `total_earnings` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `total_deductions` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `net_pay` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `calculation_status` ENUM('READY', 'BLOCKED') NOT NULL,
    `issues_json` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payroll_employee_results_payroll_run_id_calculation_status_idx`(`payroll_run_id`, `calculation_status`),
    UNIQUE INDEX `payroll_employee_results_payroll_run_id_employee_id_key`(`payroll_run_id`, `employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_result_items` (
    `id` VARCHAR(191) NOT NULL,
    `payroll_employee_result_id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name_lao` VARCHAR(191) NOT NULL,
    `name_english` VARCHAR(191) NULL,
    `type` ENUM('EARNING', 'DEDUCTION') NOT NULL,
    `source` ENUM('BASE_SALARY', 'RECURRING', 'MANUAL') NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `pay_component_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payroll_result_items_payroll_employee_result_id_idx`(`payroll_employee_result_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_manual_adjustments` (
    `id` VARCHAR(191) NOT NULL,
    `payroll_run_id` VARCHAR(191) NOT NULL,
    `employee_id` VARCHAR(191) NOT NULL,
    `pay_component_id` VARCHAR(191) NULL,
    `type` ENUM('EARNING', 'DEDUCTION') NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name_lao` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `reason` TEXT NOT NULL,
    `created_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payroll_manual_adjustments_payroll_run_id_employee_id_idx`(`payroll_run_id`, `employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payroll_settings` ADD CONSTRAINT `payroll_settings_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pay_components` ADD CONSTRAINT `pay_components_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_compensations` ADD CONSTRAINT `employee_compensations_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_compensations` ADD CONSTRAINT `employee_compensations_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_recurring_pay_components` ADD CONSTRAINT `employee_recurring_pay_components_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_recurring_pay_components` ADD CONSTRAINT `employee_recurring_pay_components_pay_component_id_fkey` FOREIGN KEY (`pay_component_id`) REFERENCES `pay_components`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_recurring_pay_components` ADD CONSTRAINT `employee_recurring_pay_components_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_periods` ADD CONSTRAINT `payroll_periods_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_periods` ADD CONSTRAINT `payroll_periods_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_period_id_fkey` FOREIGN KEY (`period_id`) REFERENCES `payroll_periods`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_calculated_by_user_id_fkey` FOREIGN KEY (`calculated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_finalized_by_user_id_fkey` FOREIGN KEY (`finalized_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_employee_results` ADD CONSTRAINT `payroll_employee_results_payroll_run_id_fkey` FOREIGN KEY (`payroll_run_id`) REFERENCES `payroll_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_employee_results` ADD CONSTRAINT `payroll_employee_results_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_result_items` ADD CONSTRAINT `payroll_result_items_payroll_employee_result_id_fkey` FOREIGN KEY (`payroll_employee_result_id`) REFERENCES `payroll_employee_results`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_result_items` ADD CONSTRAINT `payroll_result_items_pay_component_id_fkey` FOREIGN KEY (`pay_component_id`) REFERENCES `pay_components`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_manual_adjustments` ADD CONSTRAINT `payroll_manual_adjustments_payroll_run_id_fkey` FOREIGN KEY (`payroll_run_id`) REFERENCES `payroll_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_manual_adjustments` ADD CONSTRAINT `payroll_manual_adjustments_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_manual_adjustments` ADD CONSTRAINT `payroll_manual_adjustments_pay_component_id_fkey` FOREIGN KEY (`pay_component_id`) REFERENCES `pay_components`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_manual_adjustments` ADD CONSTRAINT `payroll_manual_adjustments_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

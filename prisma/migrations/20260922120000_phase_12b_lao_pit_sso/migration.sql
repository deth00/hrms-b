-- Phase 12B — Lao PIT + Social Security.
-- BACKFILLED in Phase 12B.1: Phase 12B's schema was applied to development databases with
-- `prisma db push`, so no migration folder was ever written. This SQL was generated verbatim by
-- `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script`
-- (the exact delta between the 14 prior migrations and the Phase 12B schema) and was marked applied
-- on hr_db with `prisma migrate resolve --applied` — it was NOT executed there, because hr_db
-- already contained these objects. On a fresh database it runs normally.
-- See PRISMA_MIGRATION_BASELINE_REPORT.md.

-- AlterTable
ALTER TABLE `pay_components` ADD COLUMN `pit_treatment` ENUM('TAXABLE', 'EXEMPT') NOT NULL DEFAULT 'TAXABLE',
    ADD COLUMN `social_security_treatment` ENUM('INCLUDED', 'EXCLUDED') NOT NULL DEFAULT 'INCLUDED';

-- AlterTable
ALTER TABLE `payroll_employee_results` ADD COLUMN `employer_contribution_total` DECIMAL(18, 2) NULL;

-- AlterTable
ALTER TABLE `payroll_result_items` MODIFY `source` ENUM('BASE_SALARY', 'RECURRING', 'MANUAL', 'PRORATED_BASE_SALARY', 'PRORATED_RECURRING', 'ATTENDANCE_DEDUCTION', 'UNPAID_LEAVE', 'LATE_DEDUCTION', 'EARLY_LEAVE_DEDUCTION', 'OVERTIME', 'PIT', 'SOCIAL_SECURITY_EMPLOYEE') NOT NULL;

-- CreateTable
CREATE TABLE `payroll_statutory_rule_sets` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `jurisdiction_code` VARCHAR(8) NOT NULL DEFAULT 'LA',
    `currency_code` VARCHAR(3) NOT NULL,
    `version` INTEGER NOT NULL,
    `name_lao` VARCHAR(191) NOT NULL,
    `name_english` VARCHAR(191) NULL,
    `effective_from` DATE NOT NULL,
    `effective_to` DATE NULL,
    `effective_payroll_month` VARCHAR(7) NULL,
    `legal_reference` VARCHAR(191) NULL,
    `source_description` TEXT NULL,
    `verified_at` DATETIME(3) NULL,
    `notes` TEXT NULL,
    `pit_enabled` BOOLEAN NOT NULL DEFAULT true,
    `social_security_enabled` BOOLEAN NOT NULL DEFAULT true,
    `overtime_pit_treatment_enabled` BOOLEAN NOT NULL DEFAULT false,
    `overtime_pit_exemption_base_salary_threshold` DECIMAL(18, 2) NULL,
    `overtime_pit_threshold_comparison` ENUM('LESS_THAN') NULL DEFAULT 'LESS_THAN',
    `status` ENUM('DRAFT', 'ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'DRAFT',
    `created_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payroll_statutory_rule_sets_company_id_status_idx`(`company_id`, `status`),
    UNIQUE INDEX `payroll_statutory_rule_sets_company_id_version_key`(`company_id`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_pit_brackets` (
    `id` VARCHAR(191) NOT NULL,
    `statutory_rule_set_id` VARCHAR(191) NOT NULL,
    `order` INTEGER NOT NULL,
    `lower_bound` DECIMAL(18, 2) NOT NULL,
    `upper_bound` DECIMAL(18, 2) NULL,
    `rate` DECIMAL(6, 4) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payroll_pit_brackets_statutory_rule_set_id_order_key`(`statutory_rule_set_id`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_social_security_rules` (
    `id` VARCHAR(191) NOT NULL,
    `statutory_rule_set_id` VARCHAR(191) NOT NULL,
    `employee_rate` DECIMAL(6, 4) NOT NULL,
    `employer_rate` DECIMAL(6, 4) NOT NULL,
    `minimum_base` DECIMAL(18, 2) NULL,
    `maximum_base` DECIMAL(18, 2) NULL,
    `employee_contribution_pit_deductible` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payroll_social_security_rules_statutory_rule_set_id_key`(`statutory_rule_set_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_statutory_profiles` (
    `id` VARCHAR(191) NOT NULL,
    `employee_id` VARCHAR(191) NOT NULL,
    `pit_applicable` BOOLEAN NOT NULL DEFAULT true,
    `social_security_applicable` BOOLEAN NOT NULL DEFAULT true,
    `tin` VARCHAR(191) NULL,
    `social_security_number` VARCHAR(191) NULL,
    `social_security_effective_from` DATE NULL,
    `social_security_effective_to` DATE NULL,
    `notes` TEXT NULL,
    `created_by_user_id` VARCHAR(191) NULL,
    `updated_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `employee_statutory_profiles_employee_id_key`(`employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_statutory_results` (
    `id` VARCHAR(191) NOT NULL,
    `payroll_employee_result_id` VARCHAR(191) NOT NULL,
    `statutory_rule_set_id` VARCHAR(191) NOT NULL,
    `rule_version` INTEGER NOT NULL,
    `payroll_month` VARCHAR(7) NOT NULL,
    `pit_taxable_gross` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `pit_exempt_income` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `employee_social_security` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `employer_social_security` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `pit_taxable_base` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `pit_liability_month_to_date` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `pit_prior_withheld` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `pit_current_cycle` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `social_security_base_month_to_date` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `employee_sso_liability_month_to_date` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `employee_sso_prior` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `employee_sso_current_cycle` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `employer_sso_liability_month_to_date` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `employer_sso_prior` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `employer_sso_current_cycle` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `ruleSnapshotJson` JSON NOT NULL,
    `pitBracketBreakdownJson` JSON NULL,
    `otExemptionJson` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payroll_statutory_results_payroll_employee_result_id_key`(`payroll_employee_result_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_statutory_items` (
    `id` VARCHAR(191) NOT NULL,
    `payroll_statutory_result_id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `type` ENUM('PIT', 'SOCIAL_SECURITY_EMPLOYEE', 'SOCIAL_SECURITY_EMPLOYER') NOT NULL,
    `direction` ENUM('DEDUCTION', 'CREDIT', 'EMPLOYER_COST') NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `metadata_json` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payroll_statutory_items_payroll_statutory_result_id_idx`(`payroll_statutory_result_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payroll_statutory_rule_sets` ADD CONSTRAINT `payroll_statutory_rule_sets_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_statutory_rule_sets` ADD CONSTRAINT `payroll_statutory_rule_sets_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_pit_brackets` ADD CONSTRAINT `payroll_pit_brackets_statutory_rule_set_id_fkey` FOREIGN KEY (`statutory_rule_set_id`) REFERENCES `payroll_statutory_rule_sets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_social_security_rules` ADD CONSTRAINT `payroll_social_security_rules_statutory_rule_set_id_fkey` FOREIGN KEY (`statutory_rule_set_id`) REFERENCES `payroll_statutory_rule_sets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_statutory_profiles` ADD CONSTRAINT `employee_statutory_profiles_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_statutory_profiles` ADD CONSTRAINT `employee_statutory_profiles_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_statutory_profiles` ADD CONSTRAINT `employee_statutory_profiles_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_statutory_results` ADD CONSTRAINT `payroll_statutory_results_payroll_employee_result_id_fkey` FOREIGN KEY (`payroll_employee_result_id`) REFERENCES `payroll_employee_results`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_statutory_results` ADD CONSTRAINT `payroll_statutory_results_statutory_rule_set_id_fkey` FOREIGN KEY (`statutory_rule_set_id`) REFERENCES `payroll_statutory_rule_sets`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_statutory_items` ADD CONSTRAINT `payroll_statutory_items_payroll_statutory_result_id_fkey` FOREIGN KEY (`payroll_statutory_result_id`) REFERENCES `payroll_statutory_results`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

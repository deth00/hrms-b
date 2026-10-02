-- CreateTable
CREATE TABLE `gl_accounts` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(30) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `type` ENUM('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE') NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `description` VARCHAR(500) NULL,
    `created_by_user_id` VARCHAR(191) NULL,
    `updated_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `gl_accounts_company_id_code_key`(`company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_accounting_rule_sets` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `version` INTEGER NOT NULL,
    `effective_from` DATE NOT NULL,
    `effective_to` DATE NULL,
    `status` ENUM('DRAFT', 'ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'DRAFT',
    `created_by_user_id` VARCHAR(191) NULL,
    `activated_by_user_id` VARCHAR(191) NULL,
    `activated_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payroll_accounting_rule_sets_company_id_status_idx`(`company_id`, `status`),
    UNIQUE INDEX `payroll_accounting_rule_sets_company_id_version_key`(`company_id`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_accounting_mappings` (
    `id` VARCHAR(191) NOT NULL,
    `rule_set_id` VARCHAR(191) NOT NULL,
    `event_type` ENUM('PAYROLL_ACCRUAL', 'PAYMENT_SETTLEMENT', 'PAYMENT_REVERSAL') NOT NULL,
    `source_type` VARCHAR(40) NOT NULL,
    `debit_account_id` VARCHAR(191) NULL,
    `credit_account_id` VARCHAR(191) NULL,
    `grouping_dimension` ENUM('COMPANY', 'BRANCH', 'DEPARTMENT', 'EMPLOYEE') NOT NULL DEFAULT 'COMPANY',
    `description_template` VARCHAR(200) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payroll_accounting_mappings_rule_set_id_event_type_source_ty_key`(`rule_set_id`, `event_type`, `source_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_journals` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `journal_number` VARCHAR(80) NOT NULL,
    `journal_type` ENUM('PAYROLL_ACCRUAL', 'PAYMENT_SETTLEMENT', 'PAYMENT_REVERSAL') NOT NULL,
    `source_type` VARCHAR(30) NOT NULL,
    `source_id` VARCHAR(191) NOT NULL,
    `accounting_date` DATE NOT NULL,
    `currency_code` VARCHAR(3) NOT NULL,
    `status` ENUM('DRAFT', 'VALIDATED', 'POSTED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `rule_set_id` VARCHAR(191) NULL,
    `rule_set_version` INTEGER NULL,
    `total_debit` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `total_credit` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `line_count` INTEGER NOT NULL DEFAULT 0,
    `description` VARCHAR(300) NOT NULL,
    `reversed_journal_id` VARCHAR(191) NULL,
    `created_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `validated_by_user_id` VARCHAR(191) NULL,
    `validated_at` DATETIME(3) NULL,
    `posted_by_user_id` VARCHAR(191) NULL,
    `posted_at` DATETIME(3) NULL,
    `cancelled_by_user_id` VARCHAR(191) NULL,
    `cancelled_at` DATETIME(3) NULL,

    INDEX `payroll_journals_company_id_journal_type_status_idx`(`company_id`, `journal_type`, `status`),
    INDEX `payroll_journals_source_type_source_id_idx`(`source_type`, `source_id`),
    UNIQUE INDEX `payroll_journals_company_id_journal_number_key`(`company_id`, `journal_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_journal_lines` (
    `id` VARCHAR(191) NOT NULL,
    `journal_id` VARCHAR(191) NOT NULL,
    `line_no` INTEGER NOT NULL,
    `account_id` VARCHAR(191) NOT NULL,
    `account_code_snapshot` VARCHAR(30) NOT NULL,
    `account_name_snapshot` VARCHAR(150) NOT NULL,
    `debit` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `credit` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `description` VARCHAR(300) NOT NULL,
    `employee_id` VARCHAR(191) NULL,
    `employee_code_snapshot` VARCHAR(191) NULL,
    `branch_id` VARCHAR(191) NULL,
    `branch_code_snapshot` VARCHAR(191) NULL,
    `department_id` VARCHAR(191) NULL,
    `department_code_snapshot` VARCHAR(191) NULL,
    `source_type` VARCHAR(40) NOT NULL,
    `source_id` VARCHAR(191) NULL,
    `source_reference_snapshot` VARCHAR(150) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payroll_journal_lines_source_type_source_id_idx`(`source_type`, `source_id`),
    UNIQUE INDEX `payroll_journal_lines_journal_id_line_no_key`(`journal_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_journal_sources` (
    `id` VARCHAR(191) NOT NULL,
    `journal_id` VARCHAR(191) NOT NULL,
    `journal_type` ENUM('PAYROLL_ACCRUAL', 'PAYMENT_SETTLEMENT', 'PAYMENT_REVERSAL') NOT NULL,
    `source_type` VARCHAR(30) NOT NULL,
    `source_id` VARCHAR(191) NOT NULL,
    `active_key` VARCHAR(120) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payroll_journal_sources_active_key_key`(`active_key`),
    INDEX `payroll_journal_sources_source_type_source_id_idx`(`source_type`, `source_id`),
    INDEX `payroll_journal_sources_journal_id_idx`(`journal_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `accounting_export_profiles` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `format` ENUM('CSV', 'XLSX') NOT NULL,
    `delimiter` VARCHAR(5) NULL,
    `include_header` BOOLEAN NOT NULL DEFAULT true,
    `encoding` VARCHAR(20) NOT NULL DEFAULT 'UTF-8',
    `date_format` VARCHAR(20) NOT NULL DEFAULT 'YYYY-MM-DD',
    `column_mapping_json` JSON NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `accounting_export_profiles_company_id_code_key`(`company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_journal_exports` (
    `id` VARCHAR(191) NOT NULL,
    `journal_id` VARCHAR(191) NOT NULL,
    `export_profile_id` VARCHAR(191) NOT NULL,
    `export_number` VARCHAR(191) NOT NULL,
    `format` ENUM('CSV', 'XLSX') NOT NULL,
    `file_name` VARCHAR(191) NOT NULL,
    `file_hash` CHAR(64) NOT NULL,
    `row_count` INTEGER NOT NULL,
    `profile_snapshot_json` JSON NOT NULL,
    `created_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payroll_journal_exports_journal_id_export_profile_id_key`(`journal_id`, `export_profile_id`),
    UNIQUE INDEX `payroll_journal_exports_journal_id_export_number_key`(`journal_id`, `export_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `gl_accounts` ADD CONSTRAINT `gl_accounts_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_accounting_rule_sets` ADD CONSTRAINT `payroll_accounting_rule_sets_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_accounting_mappings` ADD CONSTRAINT `payroll_accounting_mappings_rule_set_id_fkey` FOREIGN KEY (`rule_set_id`) REFERENCES `payroll_accounting_rule_sets`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_accounting_mappings` ADD CONSTRAINT `payroll_accounting_mappings_debit_account_id_fkey` FOREIGN KEY (`debit_account_id`) REFERENCES `gl_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_accounting_mappings` ADD CONSTRAINT `payroll_accounting_mappings_credit_account_id_fkey` FOREIGN KEY (`credit_account_id`) REFERENCES `gl_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_journals` ADD CONSTRAINT `payroll_journals_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_journals` ADD CONSTRAINT `payroll_journals_rule_set_id_fkey` FOREIGN KEY (`rule_set_id`) REFERENCES `payroll_accounting_rule_sets`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_journals` ADD CONSTRAINT `payroll_journals_reversed_journal_id_fkey` FOREIGN KEY (`reversed_journal_id`) REFERENCES `payroll_journals`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_journal_lines` ADD CONSTRAINT `payroll_journal_lines_journal_id_fkey` FOREIGN KEY (`journal_id`) REFERENCES `payroll_journals`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_journal_lines` ADD CONSTRAINT `payroll_journal_lines_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `gl_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_journal_sources` ADD CONSTRAINT `payroll_journal_sources_journal_id_fkey` FOREIGN KEY (`journal_id`) REFERENCES `payroll_journals`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `accounting_export_profiles` ADD CONSTRAINT `accounting_export_profiles_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_journal_exports` ADD CONSTRAINT `payroll_journal_exports_journal_id_fkey` FOREIGN KEY (`journal_id`) REFERENCES `payroll_journals`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_journal_exports` ADD CONSTRAINT `payroll_journal_exports_export_profile_id_fkey` FOREIGN KEY (`export_profile_id`) REFERENCES `accounting_export_profiles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

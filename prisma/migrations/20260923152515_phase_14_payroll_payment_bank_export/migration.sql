-- CreateTable
CREATE TABLE `employee_payment_profiles` (
    `id` VARCHAR(191) NOT NULL,
    `employee_id` VARCHAR(191) NOT NULL,
    `payment_method` ENUM('BANK_TRANSFER', 'CASH') NOT NULL,
    `bank_account_id` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_by_user_id` VARCHAR(191) NULL,
    `updated_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `employee_payment_profiles_employee_id_key`(`employee_id`),
    INDEX `employee_payment_profiles_bank_account_id_idx`(`bank_account_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_bank_accounts` (
    `id` VARCHAR(191) NOT NULL,
    `employee_id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `bank_code` VARCHAR(30) NOT NULL,
    `bank_name` VARCHAR(150) NOT NULL,
    `branch_name` VARCHAR(150) NULL,
    `account_name` VARCHAR(150) NOT NULL,
    `account_number_encrypted` TEXT NOT NULL,
    `account_number_iv` VARCHAR(32) NOT NULL,
    `account_number_auth_tag` VARCHAR(32) NOT NULL,
    `account_number_last4` VARCHAR(4) NOT NULL,
    `encryption_key_version` INTEGER NOT NULL DEFAULT 1,
    `currency_code` VARCHAR(3) NOT NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_by_user_id` VARCHAR(191) NULL,
    `updated_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `employee_bank_accounts_employee_id_status_idx`(`employee_id`, `status`),
    INDEX `employee_bank_accounts_company_id_idx`(`company_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_payment_batches` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `payroll_run_id` VARCHAR(191) NOT NULL,
    `batch_number` VARCHAR(191) NOT NULL,
    `status` ENUM('DRAFT', 'VALIDATED', 'EXPORTED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `currency_code` VARCHAR(3) NOT NULL,
    `payment_date` DATE NOT NULL,
    `employee_count` INTEGER NOT NULL DEFAULT 0,
    `total_amount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `notes` TEXT NULL,
    `created_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `validated_at` DATETIME(3) NULL,
    `validated_by_user_id` VARCHAR(191) NULL,
    `exported_at` DATETIME(3) NULL,
    `exported_by_user_id` VARCHAR(191) NULL,
    `confirmed_at` DATETIME(3) NULL,
    `confirmed_by_user_id` VARCHAR(191) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `cancelled_by_user_id` VARCHAR(191) NULL,

    UNIQUE INDEX `payroll_payment_batches_payroll_run_id_key`(`payroll_run_id`),
    INDEX `payroll_payment_batches_company_id_status_idx`(`company_id`, `status`),
    UNIQUE INDEX `payroll_payment_batches_company_id_batch_number_key`(`company_id`, `batch_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_payment_items` (
    `id` VARCHAR(191) NOT NULL,
    `payment_batch_id` VARCHAR(191) NOT NULL,
    `payroll_employee_result_id` VARCHAR(191) NOT NULL,
    `employee_id` VARCHAR(191) NOT NULL,
    `employee_code_snapshot` VARCHAR(191) NOT NULL,
    `employee_name_snapshot` VARCHAR(191) NOT NULL,
    `payment_method` ENUM('BANK_TRANSFER', 'CASH') NULL,
    `bank_account_id` VARCHAR(191) NULL,
    `bank_account_status_snapshot` ENUM('ACTIVE', 'INACTIVE') NULL,
    `bank_code_snapshot` VARCHAR(30) NULL,
    `bank_name_snapshot` VARCHAR(150) NULL,
    `bank_branch_snapshot` VARCHAR(150) NULL,
    `account_name_snapshot` VARCHAR(150) NULL,
    `account_number_encrypted_snapshot` TEXT NULL,
    `account_number_iv_snapshot` VARCHAR(32) NULL,
    `account_number_auth_tag_snapshot` VARCHAR(32) NULL,
    `account_number_last4` VARCHAR(4) NULL,
    `encryption_key_version` INTEGER NULL,
    `bank_currency_snapshot` VARCHAR(3) NULL,
    `currency_code` VARCHAR(3) NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `transfer_reference` VARCHAR(191) NOT NULL,
    `status` ENUM('READY', 'BLOCKED', 'EXPORTED', 'PAID', 'FAILED', 'CANCELLED') NOT NULL,
    `issues_json` JSON NULL,
    `payment_reference` VARCHAR(100) NULL,
    `failure_code` VARCHAR(50) NULL,
    `failure_reason` VARCHAR(500) NULL,
    `paid_at` DATETIME(3) NULL,
    `confirmed_at` DATETIME(3) NULL,
    `confirmed_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payroll_payment_items_employee_id_idx`(`employee_id`),
    INDEX `payroll_payment_items_bank_account_id_idx`(`bank_account_id`),
    UNIQUE INDEX `payroll_payment_items_payment_batch_id_payroll_employee_resu_key`(`payment_batch_id`, `payroll_employee_result_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bank_export_profiles` (
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

    UNIQUE INDEX `bank_export_profiles_company_id_code_key`(`company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_batch_exports` (
    `id` VARCHAR(191) NOT NULL,
    `payment_batch_id` VARCHAR(191) NOT NULL,
    `bank_export_profile_id` VARCHAR(191) NOT NULL,
    `export_number` VARCHAR(191) NOT NULL,
    `format` ENUM('CSV', 'XLSX') NOT NULL,
    `file_name` VARCHAR(191) NOT NULL,
    `file_hash` CHAR(64) NOT NULL,
    `row_count` INTEGER NOT NULL,
    `total_amount` DECIMAL(18, 2) NOT NULL,
    `profile_snapshot_json` JSON NOT NULL,
    `created_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payment_batch_exports_payment_batch_id_bank_export_profile_i_key`(`payment_batch_id`, `bank_export_profile_id`),
    UNIQUE INDEX `payment_batch_exports_payment_batch_id_export_number_key`(`payment_batch_id`, `export_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `employee_payment_profiles` ADD CONSTRAINT `employee_payment_profiles_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_payment_profiles` ADD CONSTRAINT `employee_payment_profiles_bank_account_id_fkey` FOREIGN KEY (`bank_account_id`) REFERENCES `employee_bank_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_payment_profiles` ADD CONSTRAINT `employee_payment_profiles_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_payment_profiles` ADD CONSTRAINT `employee_payment_profiles_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_bank_accounts` ADD CONSTRAINT `employee_bank_accounts_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_bank_accounts` ADD CONSTRAINT `employee_bank_accounts_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_bank_accounts` ADD CONSTRAINT `employee_bank_accounts_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_bank_accounts` ADD CONSTRAINT `employee_bank_accounts_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_batches` ADD CONSTRAINT `payroll_payment_batches_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_batches` ADD CONSTRAINT `payroll_payment_batches_payroll_run_id_fkey` FOREIGN KEY (`payroll_run_id`) REFERENCES `payroll_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_batches` ADD CONSTRAINT `payroll_payment_batches_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_batches` ADD CONSTRAINT `payroll_payment_batches_validated_by_user_id_fkey` FOREIGN KEY (`validated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_batches` ADD CONSTRAINT `payroll_payment_batches_exported_by_user_id_fkey` FOREIGN KEY (`exported_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_batches` ADD CONSTRAINT `payroll_payment_batches_confirmed_by_user_id_fkey` FOREIGN KEY (`confirmed_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_batches` ADD CONSTRAINT `payroll_payment_batches_cancelled_by_user_id_fkey` FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_items` ADD CONSTRAINT `payroll_payment_items_payment_batch_id_fkey` FOREIGN KEY (`payment_batch_id`) REFERENCES `payroll_payment_batches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_items` ADD CONSTRAINT `payroll_payment_items_payroll_employee_result_id_fkey` FOREIGN KEY (`payroll_employee_result_id`) REFERENCES `payroll_employee_results`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_items` ADD CONSTRAINT `payroll_payment_items_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_items` ADD CONSTRAINT `payroll_payment_items_bank_account_id_fkey` FOREIGN KEY (`bank_account_id`) REFERENCES `employee_bank_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_items` ADD CONSTRAINT `payroll_payment_items_confirmed_by_user_id_fkey` FOREIGN KEY (`confirmed_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bank_export_profiles` ADD CONSTRAINT `bank_export_profiles_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bank_export_profiles` ADD CONSTRAINT `bank_export_profiles_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_batch_exports` ADD CONSTRAINT `payment_batch_exports_payment_batch_id_fkey` FOREIGN KEY (`payment_batch_id`) REFERENCES `payroll_payment_batches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_batch_exports` ADD CONSTRAINT `payment_batch_exports_bank_export_profile_id_fkey` FOREIGN KEY (`bank_export_profile_id`) REFERENCES `bank_export_profiles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_batch_exports` ADD CONSTRAINT `payment_batch_exports_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Phase 15 — payment reconciliation, reversal and retry / reissue (additive; existing batches become
-- ORIGINAL sequence 1, existing items keep instruction_reference NULL).
-- Generated with `prisma migrate diff` (migrate dev is non-interactive-blocked by the unique-index
-- warnings), then HAND-CORRECTED for a Prisma/MySQL quirk: the diff dropped the payroll_run_id FK (to
-- replace its unique index with (payroll_run_id, sequence_no)) but emitted a spurious re-add of the
-- existing payroll_employee_results_employee_id_fkey instead of re-adding the payroll_run_id FK.

-- DropForeignKey
ALTER TABLE `payroll_payment_batches` DROP FOREIGN KEY `payroll_payment_batches_payroll_run_id_fkey`;

-- DropIndex
DROP INDEX `payroll_payment_batches_payroll_run_id_key` ON `payroll_payment_batches`;

-- AlterTable
ALTER TABLE `payroll_payment_batches` ADD COLUMN `batch_kind` ENUM('ORIGINAL', 'RETRY') NOT NULL DEFAULT 'ORIGINAL',
    ADD COLUMN `parent_batch_id` VARCHAR(191) NULL,
    ADD COLUMN `sequence_no` INTEGER NOT NULL DEFAULT 1,
    MODIFY `status` ENUM('DRAFT', 'VALIDATED', 'EXPORTED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED', 'PARTIALLY_REVERSED', 'REVERSED') NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE `payroll_payment_items` ADD COLUMN `instruction_reference` VARCHAR(120) NULL,
    ADD COLUMN `reconciled_at` DATETIME(3) NULL,
    ADD COLUMN `reconciled_by_user_id` VARCHAR(191) NULL,
    ADD COLUMN `reconciliation_import_id` VARCHAR(191) NULL,
    ADD COLUMN `retry_source_lock_id` VARCHAR(191) NULL,
    ADD COLUMN `source_payment_item_id` VARCHAR(191) NULL,
    MODIFY `status` ENUM('READY', 'BLOCKED', 'EXPORTED', 'PAID', 'FAILED', 'CANCELLED', 'REVERSED') NOT NULL;

-- CreateTable
CREATE TABLE `payroll_payment_reversals` (
    `id` VARCHAR(191) NOT NULL,
    `payment_item_id` VARCHAR(191) NOT NULL,
    `payment_batch_id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `bank_reference` VARCHAR(100) NULL,
    `effective_date` DATE NOT NULL,
    `reversed_by_user_id` VARCHAR(191) NULL,
    `reversed_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payroll_payment_reversals_payment_item_id_key`(`payment_item_id`),
    INDEX `payroll_payment_reversals_payment_batch_id_idx`(`payment_batch_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_reconciliation_profiles` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `format` ENUM('CSV', 'XLSX') NOT NULL,
    `delimiter` VARCHAR(5) NULL,
    `encoding` VARCHAR(20) NULL,
    `sheet_name` VARCHAR(100) NULL,
    `has_header` BOOLEAN NOT NULL DEFAULT true,
    `date_format` VARCHAR(20) NULL,
    `column_mapping_json` JSON NOT NULL,
    `status_mapping_json` JSON NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payment_reconciliation_profiles_company_id_code_key`(`company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_reconciliation_imports` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `payment_batch_id` VARCHAR(191) NOT NULL,
    `reconciliation_profile_id` VARCHAR(191) NOT NULL,
    `file_name` VARCHAR(200) NOT NULL,
    `file_hash` CHAR(64) NOT NULL,
    `format` ENUM('CSV', 'XLSX') NOT NULL,
    `profile_snapshot_json` JSON NOT NULL,
    `status` ENUM('PENDING_REVIEW', 'READY', 'APPLIED', 'CANCELLED') NOT NULL DEFAULT 'PENDING_REVIEW',
    `row_count` INTEGER NOT NULL DEFAULT 0,
    `matched_count` INTEGER NOT NULL DEFAULT 0,
    `unmatched_count` INTEGER NOT NULL DEFAULT 0,
    `conflict_count` INTEGER NOT NULL DEFAULT 0,
    `invalid_count` INTEGER NOT NULL DEFAULT 0,
    `ignored_count` INTEGER NOT NULL DEFAULT 0,
    `imported_by_user_id` VARCHAR(191) NULL,
    `imported_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `applied_by_user_id` VARCHAR(191) NULL,
    `applied_at` DATETIME(3) NULL,
    `cancelled_by_user_id` VARCHAR(191) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payment_reconciliation_imports_payment_batch_id_imported_at_idx`(`payment_batch_id`, `imported_at`),
    UNIQUE INDEX `payment_reconciliation_imports_payment_batch_id_reconciliati_key`(`payment_batch_id`, `reconciliation_profile_id`, `file_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_reconciliation_rows` (
    `id` VARCHAR(191) NOT NULL,
    `reconciliation_import_id` VARCHAR(191) NOT NULL,
    `row_number` INTEGER NOT NULL,
    `instruction_reference` VARCHAR(120) NULL,
    `bank_transaction_reference` VARCHAR(100) NULL,
    `external_status` VARCHAR(50) NOT NULL,
    `normalized_status` ENUM('PAID', 'FAILED', 'REVERSED', 'UNKNOWN') NOT NULL,
    `amount` DECIMAL(18, 2) NULL,
    `currency_code` VARCHAR(3) NULL,
    `paid_date` DATE NULL,
    `failure_code` VARCHAR(50) NULL,
    `failure_reason` VARCHAR(500) NULL,
    `matched_payment_item_id` VARCHAR(191) NULL,
    `match_method` VARCHAR(10) NULL,
    `match_state` ENUM('MATCHED', 'UNMATCHED', 'CONFLICT', 'INVALID', 'IGNORED') NOT NULL,
    `issue_code` VARCHAR(50) NULL,
    `ignored_reason` VARCHAR(500) NULL,
    `ignored_by_user_id` VARCHAR(191) NULL,
    `ignored_at` DATETIME(3) NULL,
    `matched_by_user_id` VARCHAR(191) NULL,
    `matched_at` DATETIME(3) NULL,
    `apply_outcome` VARCHAR(20) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payment_reconciliation_rows_matched_payment_item_id_idx`(`matched_payment_item_id`),
    UNIQUE INDEX `payment_reconciliation_rows_reconciliation_import_id_row_num_key`(`reconciliation_import_id`, `row_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `payroll_payment_batches_parent_batch_id_idx` ON `payroll_payment_batches`(`parent_batch_id`);

-- CreateIndex
CREATE UNIQUE INDEX `payroll_payment_batches_payroll_run_id_sequence_no_key` ON `payroll_payment_batches`(`payroll_run_id`, `sequence_no`);

-- CreateIndex
CREATE UNIQUE INDEX `payroll_payment_items_retry_source_lock_id_key` ON `payroll_payment_items`(`retry_source_lock_id`);

-- CreateIndex
CREATE INDEX `payroll_payment_items_source_payment_item_id_idx` ON `payroll_payment_items`(`source_payment_item_id`);

-- CreateIndex
CREATE UNIQUE INDEX `payroll_payment_items_payment_batch_id_instruction_reference_key` ON `payroll_payment_items`(`payment_batch_id`, `instruction_reference`);

-- AddForeignKey
ALTER TABLE `payroll_payment_batches` ADD CONSTRAINT `payroll_payment_batches_payroll_run_id_fkey` FOREIGN KEY (`payroll_run_id`) REFERENCES `payroll_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_batches` ADD CONSTRAINT `payroll_payment_batches_parent_batch_id_fkey` FOREIGN KEY (`parent_batch_id`) REFERENCES `payroll_payment_batches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_items` ADD CONSTRAINT `payroll_payment_items_source_payment_item_id_fkey` FOREIGN KEY (`source_payment_item_id`) REFERENCES `payroll_payment_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_items` ADD CONSTRAINT `payroll_payment_items_reconciled_by_user_id_fkey` FOREIGN KEY (`reconciled_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_items` ADD CONSTRAINT `payroll_payment_items_reconciliation_import_id_fkey` FOREIGN KEY (`reconciliation_import_id`) REFERENCES `payment_reconciliation_imports`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_reversals` ADD CONSTRAINT `payroll_payment_reversals_payment_item_id_fkey` FOREIGN KEY (`payment_item_id`) REFERENCES `payroll_payment_items`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_reversals` ADD CONSTRAINT `payroll_payment_reversals_payment_batch_id_fkey` FOREIGN KEY (`payment_batch_id`) REFERENCES `payroll_payment_batches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_reversals` ADD CONSTRAINT `payroll_payment_reversals_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_payment_reversals` ADD CONSTRAINT `payroll_payment_reversals_reversed_by_user_id_fkey` FOREIGN KEY (`reversed_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_reconciliation_profiles` ADD CONSTRAINT `payment_reconciliation_profiles_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_reconciliation_profiles` ADD CONSTRAINT `payment_reconciliation_profiles_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_reconciliation_imports` ADD CONSTRAINT `payment_reconciliation_imports_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_reconciliation_imports` ADD CONSTRAINT `payment_reconciliation_imports_payment_batch_id_fkey` FOREIGN KEY (`payment_batch_id`) REFERENCES `payroll_payment_batches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_reconciliation_imports` ADD CONSTRAINT `payment_reconciliation_imports_reconciliation_profile_id_fkey` FOREIGN KEY (`reconciliation_profile_id`) REFERENCES `payment_reconciliation_profiles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_reconciliation_imports` ADD CONSTRAINT `payment_reconciliation_imports_imported_by_user_id_fkey` FOREIGN KEY (`imported_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_reconciliation_imports` ADD CONSTRAINT `payment_reconciliation_imports_applied_by_user_id_fkey` FOREIGN KEY (`applied_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_reconciliation_imports` ADD CONSTRAINT `payment_reconciliation_imports_cancelled_by_user_id_fkey` FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_reconciliation_rows` ADD CONSTRAINT `payment_reconciliation_rows_reconciliation_import_id_fkey` FOREIGN KEY (`reconciliation_import_id`) REFERENCES `payment_reconciliation_imports`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_reconciliation_rows` ADD CONSTRAINT `payment_reconciliation_rows_matched_payment_item_id_fkey` FOREIGN KEY (`matched_payment_item_id`) REFERENCES `payroll_payment_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_reconciliation_rows` ADD CONSTRAINT `payment_reconciliation_rows_ignored_by_user_id_fkey` FOREIGN KEY (`ignored_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_reconciliation_rows` ADD CONSTRAINT `payment_reconciliation_rows_matched_by_user_id_fkey` FOREIGN KEY (`matched_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER TABLE `payroll_payment_items` RENAME INDEX `payroll_payment_items_payroll_employee_result_id_fkey` TO `payroll_payment_items_payroll_employee_result_id_idx`;



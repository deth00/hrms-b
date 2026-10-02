-- DropForeignKey
ALTER TABLE `approval_instances` DROP FOREIGN KEY `approval_instances_employee_id_fkey`;

-- DropIndex
DROP INDEX `approval_instances_target_type_target_id_key` ON `approval_instances`;

-- AlterTable
ALTER TABLE `approval_instances` ADD COLUMN `attempt_no` INTEGER NOT NULL DEFAULT 1,
    MODIFY `target_type` ENUM('LEAVE', 'OVERTIME', 'ATTENDANCE_CORRECTION', 'PAYROLL_RUN') NOT NULL,
    MODIFY `employee_id` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `approval_workflows` MODIFY `target_type` ENUM('LEAVE', 'OVERTIME', 'ATTENDANCE_CORRECTION', 'PAYROLL_RUN') NOT NULL;

-- AlterTable
ALTER TABLE `payroll_runs` ADD COLUMN `approval_attempt_no` INTEGER NULL,
    ADD COLUMN `approval_instance_id` VARCHAR(191) NULL,
    ADD COLUMN `approval_mode_snapshot` ENUM('DIRECT', 'WORKFLOW') NOT NULL DEFAULT 'DIRECT',
    ADD COLUMN `approval_snapshot_hash` CHAR(64) NULL,
    ADD COLUMN `approval_snapshot_json` JSON NULL,
    ADD COLUMN `approval_state` ENUM('NONE', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'NONE',
    ADD COLUMN `approved_at` DATETIME(3) NULL,
    ADD COLUMN `approved_by_user_id` VARCHAR(191) NULL,
    ADD COLUMN `submitted_at` DATETIME(3) NULL,
    ADD COLUMN `submitted_by_user_id` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `payroll_settings` ADD COLUMN `approval_mode` ENUM('DIRECT', 'WORKFLOW') NOT NULL DEFAULT 'DIRECT';

-- CreateTable
CREATE TABLE `payslips` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `payroll_run_id` VARCHAR(191) NOT NULL,
    `payroll_employee_result_id` VARCHAR(191) NOT NULL,
    `employee_id` VARCHAR(191) NOT NULL,
    `payslip_number` VARCHAR(191) NOT NULL,
    `template_version` INTEGER NOT NULL DEFAULT 1,
    `payroll_month` VARCHAR(7) NULL,
    `period_code` VARCHAR(191) NOT NULL,
    `period_name` VARCHAR(191) NOT NULL,
    `period_start` DATE NOT NULL,
    `period_end` DATE NOT NULL,
    `pay_date` DATE NOT NULL,
    `cycle_number` INTEGER NULL,
    `currency_code` VARCHAR(3) NOT NULL,
    `issued_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `issued_by_user_id` VARCHAR(191) NULL,
    `snapshot_json` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payslips_payroll_employee_result_id_key`(`payroll_employee_result_id`),
    INDEX `payslips_employee_id_period_end_idx`(`employee_id`, `period_end`),
    INDEX `payslips_payroll_run_id_idx`(`payroll_run_id`),
    UNIQUE INDEX `payslips_company_id_payslip_number_key`(`company_id`, `payslip_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `approval_instances_target_type_target_id_attempt_no_key` ON `approval_instances`(`target_type`, `target_id`, `attempt_no`);

-- AddForeignKey
ALTER TABLE `approval_instances` ADD CONSTRAINT `approval_instances_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_submitted_by_user_id_fkey` FOREIGN KEY (`submitted_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_approved_by_user_id_fkey` FOREIGN KEY (`approved_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payslips` ADD CONSTRAINT `payslips_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payslips` ADD CONSTRAINT `payslips_payroll_run_id_fkey` FOREIGN KEY (`payroll_run_id`) REFERENCES `payroll_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payslips` ADD CONSTRAINT `payslips_payroll_employee_result_id_fkey` FOREIGN KEY (`payroll_employee_result_id`) REFERENCES `payroll_employee_results`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payslips` ADD CONSTRAINT `payslips_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payslips` ADD CONSTRAINT `payslips_issued_by_user_id_fkey` FOREIGN KEY (`issued_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


-- AlterTable
ALTER TABLE `payroll_employee_results` ADD COLUMN `cycle_allocation_factor_snapshot` DECIMAL(20, 10) NULL,
    ADD COLUMN `monthly_base_salary_snapshot` DECIMAL(18, 2) NULL;

-- AlterTable
ALTER TABLE `payroll_periods` ADD COLUMN `payroll_month` VARCHAR(7) NULL,
    ADD COLUMN `statutory_month_eligible` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `payroll_runs` ADD COLUMN `cycle_number` INTEGER NULL,
    ADD COLUMN `monthly_allocation_factor` DECIMAL(20, 10) NULL,
    ADD COLUMN `monthly_allocation_method` ENUM('EQUAL_SPLIT', 'PERIOD_UNITS') NULL,
    ADD COLUMN `payments_per_month` ENUM('ONE', 'TWO') NULL,
    ADD COLUMN `payroll_month` VARCHAR(7) NULL;

-- AlterTable
ALTER TABLE `payroll_schedules` ADD COLUMN `monthly_allocation_method` ENUM('EQUAL_SPLIT', 'PERIOD_UNITS') NULL;

-- CreateTable
CREATE TABLE `employment_types` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name_lao` VARCHAR(191) NOT NULL,
    `name_english` VARCHAR(191) NULL,
    `description` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `employment_types_company_id_idx`(`company_id`),
    UNIQUE INDEX `employment_types_company_id_code_key`(`company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employees` (
    `id` VARCHAR(191) NOT NULL,
    `employee_code` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NULL,
    `title` VARCHAR(191) NULL,
    `first_name_lao` VARCHAR(191) NOT NULL,
    `last_name_lao` VARCHAR(191) NOT NULL,
    `first_name_english` VARCHAR(191) NULL,
    `last_name_english` VARCHAR(191) NULL,
    `nickname` VARCHAR(191) NULL,
    `gender` ENUM('MALE', 'FEMALE', 'OTHER') NULL,
    `date_of_birth` DATE NULL,
    `national_id` VARCHAR(191) NULL,
    `passport_number` VARCHAR(191) NULL,
    `marital_status` ENUM('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED') NULL,
    `phone` VARCHAR(191) NULL,
    `personal_email` VARCHAR(191) NULL,
    `work_email` VARCHAR(191) NULL,
    `address` VARCHAR(191) NULL,
    `province` VARCHAR(191) NULL,
    `district` VARCHAR(191) NULL,
    `village` VARCHAR(191) NULL,
    `start_date` DATE NOT NULL,
    `probation_end_date` DATE NULL,
    `end_date` DATE NULL,
    `employment_status` ENUM('ACTIVE', 'PROBATION', 'ON_LEAVE', 'SUSPENDED', 'RESIGNED', 'TERMINATED') NOT NULL DEFAULT 'ACTIVE',
    `employment_type_id` VARCHAR(191) NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `branch_id` VARCHAR(191) NULL,
    `department_id` VARCHAR(191) NULL,
    `division_id` VARCHAR(191) NULL,
    `unit_id` VARCHAR(191) NULL,
    `position_id` VARCHAR(191) NULL,
    `manager_employee_id` VARCHAR(191) NULL,
    `avatar_url` VARCHAR(191) NULL,
    `note` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `employees_employee_code_key`(`employee_code`),
    UNIQUE INDEX `employees_user_id_key`(`user_id`),
    INDEX `employees_company_id_idx`(`company_id`),
    INDEX `employees_branch_id_idx`(`branch_id`),
    INDEX `employees_department_id_idx`(`department_id`),
    INDEX `employees_division_id_idx`(`division_id`),
    INDEX `employees_unit_id_idx`(`unit_id`),
    INDEX `employees_position_id_idx`(`position_id`),
    INDEX `employees_manager_employee_id_idx`(`manager_employee_id`),
    INDEX `employees_employment_type_id_idx`(`employment_type_id`),
    INDEX `employees_employment_status_idx`(`employment_status`),
    INDEX `employees_first_name_lao_last_name_lao_idx`(`first_name_lao`, `last_name_lao`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_assignment_history` (
    `id` VARCHAR(191) NOT NULL,
    `employee_id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `branch_id` VARCHAR(191) NULL,
    `department_id` VARCHAR(191) NULL,
    `division_id` VARCHAR(191) NULL,
    `unit_id` VARCHAR(191) NULL,
    `position_id` VARCHAR(191) NULL,
    `manager_employee_id` VARCHAR(191) NULL,
    `employment_type_id` VARCHAR(191) NULL,
    `effective_from` DATE NOT NULL,
    `effective_to` DATE NULL,
    `reason` VARCHAR(191) NULL,
    `created_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `employee_assignment_history_employee_id_effective_from_idx`(`employee_id`, `effective_from`),
    INDEX `employee_assignment_history_company_id_idx`(`company_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `employment_types` ADD CONSTRAINT `employment_types_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_department_id_fkey` FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_division_id_fkey` FOREIGN KEY (`division_id`) REFERENCES `divisions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_unit_id_fkey` FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_position_id_fkey` FOREIGN KEY (`position_id`) REFERENCES `positions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_employment_type_id_fkey` FOREIGN KEY (`employment_type_id`) REFERENCES `employment_types`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_manager_employee_id_fkey` FOREIGN KEY (`manager_employee_id`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_assignment_history` ADD CONSTRAINT `employee_assignment_history_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_assignment_history` ADD CONSTRAINT `employee_assignment_history_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_assignment_history` ADD CONSTRAINT `employee_assignment_history_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_assignment_history` ADD CONSTRAINT `employee_assignment_history_department_id_fkey` FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_assignment_history` ADD CONSTRAINT `employee_assignment_history_division_id_fkey` FOREIGN KEY (`division_id`) REFERENCES `divisions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_assignment_history` ADD CONSTRAINT `employee_assignment_history_unit_id_fkey` FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_assignment_history` ADD CONSTRAINT `employee_assignment_history_position_id_fkey` FOREIGN KEY (`position_id`) REFERENCES `positions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_assignment_history` ADD CONSTRAINT `employee_assignment_history_manager_employee_id_fkey` FOREIGN KEY (`manager_employee_id`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_assignment_history` ADD CONSTRAINT `employee_assignment_history_employment_type_id_fkey` FOREIGN KEY (`employment_type_id`) REFERENCES `employment_types`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_assignment_history` ADD CONSTRAINT `employee_assignment_history_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

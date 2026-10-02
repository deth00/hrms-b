-- CreateTable
CREATE TABLE `approval_workflows` (
    `id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `target_type` ENUM('LEAVE', 'OVERTIME', 'ATTENDANCE_CORRECTION') NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name_lao` VARCHAR(191) NOT NULL,
    `name_english` VARCHAR(191) NULL,
    `description` VARCHAR(191) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `active_key` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `approval_workflows_active_key_key`(`active_key`),
    INDEX `approval_workflows_company_id_target_type_idx`(`company_id`, `target_type`),
    UNIQUE INDEX `approval_workflows_company_id_code_key`(`company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_workflow_steps` (
    `id` VARCHAR(191) NOT NULL,
    `workflow_id` VARCHAR(191) NOT NULL,
    `step_order` INTEGER NOT NULL,
    `name_lao` VARCHAR(191) NOT NULL,
    `name_english` VARCHAR(191) NULL,
    `approver_type` ENUM('MANAGER', 'ROLE', 'USER', 'PERMISSION') NOT NULL,
    `manager_level` INTEGER NULL,
    `role_id` VARCHAR(191) NULL,
    `user_id` VARCHAR(191) NULL,
    `permission_code` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `approval_workflow_steps_workflow_id_step_order_key`(`workflow_id`, `step_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_instances` (
    `id` VARCHAR(191) NOT NULL,
    `workflow_id` VARCHAR(191) NULL,
    `workflow_version` INTEGER NOT NULL,
    `target_type` ENUM('LEAVE', 'OVERTIME', 'ATTENDANCE_CORRECTION') NOT NULL,
    `target_id` VARCHAR(191) NOT NULL,
    `company_id` VARCHAR(191) NOT NULL,
    `employee_id` VARCHAR(191) NOT NULL,
    `requester_user_id` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `current_step_order` INTEGER NULL,
    `submitted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `approval_instances_status_target_type_idx`(`status`, `target_type`),
    INDEX `approval_instances_employee_id_idx`(`employee_id`),
    UNIQUE INDEX `approval_instances_target_type_target_id_key`(`target_type`, `target_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_step_instances` (
    `id` VARCHAR(191) NOT NULL,
    `approval_instance_id` VARCHAR(191) NOT NULL,
    `step_order` INTEGER NOT NULL,
    `name_lao` VARCHAR(191) NOT NULL,
    `name_english` VARCHAR(191) NULL,
    `approver_type` ENUM('MANAGER', 'ROLE', 'USER', 'PERMISSION') NOT NULL,
    `manager_level` INTEGER NULL,
    `role_id` VARCHAR(191) NULL,
    `user_id` VARCHAR(191) NULL,
    `permission_code` VARCHAR(191) NULL,
    `status` ENUM('WAITING', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'WAITING',
    `acted_by_user_id` VARCHAR(191) NULL,
    `acted_at` DATETIME(3) NULL,
    `action_note` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `approval_step_instances_acted_by_user_id_idx`(`acted_by_user_id`),
    UNIQUE INDEX `approval_step_instances_approval_instance_id_step_order_key`(`approval_instance_id`, `step_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_step_candidates` (
    `id` VARCHAR(191) NOT NULL,
    `approval_step_instance_id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `assigned_by_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `approval_step_candidates_user_id_idx`(`user_id`),
    UNIQUE INDEX `approval_step_candidates_approval_step_instance_id_user_id_key`(`approval_step_instance_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `approval_workflows` ADD CONSTRAINT `approval_workflows_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_workflow_steps` ADD CONSTRAINT `approval_workflow_steps_workflow_id_fkey` FOREIGN KEY (`workflow_id`) REFERENCES `approval_workflows`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_workflow_steps` ADD CONSTRAINT `approval_workflow_steps_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_workflow_steps` ADD CONSTRAINT `approval_workflow_steps_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_instances` ADD CONSTRAINT `approval_instances_workflow_id_fkey` FOREIGN KEY (`workflow_id`) REFERENCES `approval_workflows`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_instances` ADD CONSTRAINT `approval_instances_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_instances` ADD CONSTRAINT `approval_instances_requester_user_id_fkey` FOREIGN KEY (`requester_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_step_instances` ADD CONSTRAINT `approval_step_instances_approval_instance_id_fkey` FOREIGN KEY (`approval_instance_id`) REFERENCES `approval_instances`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_step_instances` ADD CONSTRAINT `approval_step_instances_acted_by_user_id_fkey` FOREIGN KEY (`acted_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_step_candidates` ADD CONSTRAINT `approval_step_candidates_approval_step_instance_id_fkey` FOREIGN KEY (`approval_step_instance_id`) REFERENCES `approval_step_instances`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_step_candidates` ADD CONSTRAINT `approval_step_candidates_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

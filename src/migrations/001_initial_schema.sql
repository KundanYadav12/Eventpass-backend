-- EventGen Database Schema Migration
-- Designed for MySQL 8.0+

CREATE TABLE IF NOT EXISTS `roles` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(50) NOT NULL UNIQUE,
  `description` VARCHAR(255),
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `permissions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(50) NOT NULL UNIQUE,
  `name` VARCHAR(100) NOT NULL,
  `module` VARCHAR(50) NOT NULL,
  `description` VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `role_permissions` (
  `role_id` INT NOT NULL,
  `permission_id` INT NOT NULL,
  PRIMARY KEY (`role_id`, `permission_id`),
  FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) NOT NULL,
  `email` VARCHAR(191) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `role_id` INT NOT NULL,
  `is_active` BOOLEAN DEFAULT TRUE,
  `last_login_at` DATETIME NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pass_categories` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(50) NOT NULL UNIQUE,
  `name` VARCHAR(100) NOT NULL,
  `description` TEXT,
  `valid_from` DATETIME NOT NULL,
  `valid_until` DATETIME NOT NULL,
  `total_quantity` INT NOT NULL DEFAULT 0,
  `max_daily_scans` INT NOT NULL DEFAULT 1,
  `price` DECIMAL(10,2) DEFAULT 0.00,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `print_batches` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) NOT NULL,
  `pass_type` VARCHAR(50) NOT NULL,
  `total_requested` INT NOT NULL DEFAULT 0,
  `printed_count` INT NOT NULL DEFAULT 0,
  `status` ENUM('created', 'printing', 'paused', 'completed', 'cancelled') DEFAULT 'created',
  `started_at` DATETIME NULL,
  `completed_at` DATETIME NULL,
  `created_by` INT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `passes` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(50) NOT NULL UNIQUE,
  `code_type` VARCHAR(50) NOT NULL,
  `hmac_sig` VARCHAR(64) NOT NULL,
  `status` ENUM('active', 'used', 'expired', 'void') DEFAULT 'active',
  `valid_from` DATETIME NOT NULL,
  `valid_until` DATETIME NOT NULL,
  `issued_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `first_scanned_at` DATETIME NULL,
  `last_scanned_at` DATETIME NULL,
  `scan_count` INT DEFAULT 0,
  `printed` BOOLEAN DEFAULT FALSE,
  `print_batch_id` INT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_code` (`code`),
  INDEX `idx_code_type` (`code_type`),
  INDEX `idx_status` (`status`),
  INDEX `idx_valid_dates` (`valid_from`, `valid_until`),
  INDEX `idx_printed` (`printed`),
  FOREIGN KEY (`print_batch_id`) REFERENCES `print_batches`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `scan_history` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `pass_id` INT NULL,
  `pass_code` VARCHAR(50) NOT NULL,
  `pass_type` VARCHAR(50) NULL,
  `device_id` VARCHAR(50) NOT NULL,
  `operator_id` INT NULL,
  `scan_time` DATETIME NOT NULL,
  `result` ENUM('approved', 'denied', 'expired', 'already_used', 'wrong_date', 'invalid', 'voided') NOT NULL,
  `reason` VARCHAR(255) NULL,
  `ip_address` VARCHAR(50) NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_scan_pass_code` (`pass_code`),
  INDEX `idx_scan_time` (`scan_time`),
  INDEX `idx_scan_result` (`result`),
  INDEX `idx_scan_device` (`device_id`),
  FOREIGN KEY (`pass_id`) REFERENCES `passes`(`id`) ON DELETE SET NULL,
  FOREIGN KEY (`operator_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `print_log` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `batch_id` INT NOT NULL,
  `pass_id` INT NOT NULL,
  `printed_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `printer_name` VARCHAR(100) DEFAULT 'TSC TE244',
  `status` VARCHAR(50) DEFAULT 'success',
  FOREIGN KEY (`batch_id`) REFERENCES `print_batches`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`pass_id`) REFERENCES `passes`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `messages_config` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `message_key` VARCHAR(50) NOT NULL UNIQUE,
  `message_text` VARCHAR(255) NOT NULL,
  `description` VARCHAR(255) NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `audit_log` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NULL,
  `user_name` VARCHAR(100) NULL,
  `action` VARCHAR(100) NOT NULL,
  `entity` VARCHAR(50) NOT NULL,
  `entity_id` VARCHAR(50) NULL,
  `old_value` JSON NULL,
  `new_value` JSON NULL,
  `ip_address` VARCHAR(50) NULL,
  `user_agent` VARCHAR(255) NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_audit_action` (`action`),
  INDEX `idx_audit_entity` (`entity`),
  INDEX `idx_audit_time` (`created_at`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `password_resets` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `token_hash` VARCHAR(64) NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `used_at` DATETIME NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

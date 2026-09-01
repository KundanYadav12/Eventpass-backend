-- Migration 002: Multi-Event Architecture and 7-Character Pass Codes

CREATE TABLE IF NOT EXISTS `events` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_name` VARCHAR(150) NOT NULL,
  `event_code` VARCHAR(50) NOT NULL UNIQUE,
  `description` TEXT,
  `venue` VARCHAR(255),
  `event_start_date` DATETIME NOT NULL,
  `event_end_date` DATETIME NOT NULL,
  `status` ENUM('active', 'upcoming', 'completed', 'inactive') DEFAULT 'active',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_event_status` (`status`),
  INDEX `idx_event_dates` (`event_start_date`, `event_end_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default Event 1 if not exists
INSERT IGNORE INTO `events` (`id`, `event_name`, `event_code`, `description`, `venue`, `event_start_date`, `event_end_date`, `status`)
VALUES (1, 'Corporate Expo 2026', 'EXPO2026', 'Premier Tech and Industry Exhibition', 'Grand Convention Center, Hall A & B', '2026-10-02 00:00:00', '2026-10-04 23:59:59', 'active');

-- Add event_id to users
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'event_id');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `users` ADD COLUMN `event_id` INT NULL AFTER `role_id`, ADD INDEX `idx_user_event` (`event_id`)', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add event_id and category_prefix to pass_categories
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pass_categories' AND COLUMN_NAME = 'event_id');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `pass_categories` ADD COLUMN `event_id` INT NOT NULL DEFAULT 1 AFTER `id`, ADD COLUMN `category_prefix` VARCHAR(20) DEFAULT "" AFTER `code`, ADD INDEX `idx_cat_event` (`event_id`)', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add event_id, category_id, category_prefix to passes
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passes' AND COLUMN_NAME = 'event_id');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `passes` ADD COLUMN `event_id` INT NOT NULL DEFAULT 1 AFTER `id`, ADD COLUMN `category_id` INT NULL AFTER `event_id`, ADD COLUMN `category_prefix` VARCHAR(20) DEFAULT "" AFTER `code_type`, ADD INDEX `idx_pass_event` (`event_id`, `status`), ADD INDEX `idx_pass_category` (`category_id`)', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add event_id and category_id to print_batches
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'print_batches' AND COLUMN_NAME = 'event_id');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `print_batches` ADD COLUMN `event_id` INT NOT NULL DEFAULT 1 AFTER `id`, ADD COLUMN `category_id` INT NULL AFTER `event_id`, ADD INDEX `idx_batch_event` (`event_id`)', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add event_id and category_id to scan_history
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scan_history' AND COLUMN_NAME = 'event_id');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `scan_history` ADD COLUMN `event_id` INT NULL AFTER `id`, ADD COLUMN `category_id` INT NULL AFTER `pass_id`, ADD INDEX `idx_scan_event` (`event_id`)', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add event_id to messages_config
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages_config' AND COLUMN_NAME = 'event_id');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `messages_config` ADD COLUMN `event_id` INT NULL AFTER `id`, ADD INDEX `idx_msg_event` (`event_id`)', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add event_id to audit_log
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_log' AND COLUMN_NAME = 'event_id');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `audit_log` ADD COLUMN `event_id` INT NULL AFTER `id`, ADD INDEX `idx_audit_event` (`event_id`)', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Update existing records to Event 1
UPDATE `pass_categories` SET `event_id` = 1 WHERE `event_id` IS NULL OR `event_id` = 0;
UPDATE `passes` SET `event_id` = 1 WHERE `event_id` IS NULL OR `event_id` = 0;
UPDATE `print_batches` SET `event_id` = 1 WHERE `event_id` IS NULL OR `event_id` = 0;
UPDATE `scan_history` SET `event_id` = 1 WHERE `event_id` IS NULL;
UPDATE `users` SET `event_id` = 1 WHERE `role_id` = 2 AND `event_id` IS NULL;

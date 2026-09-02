-- Migration 005: Platform System Settings, Barcode Configuration per Event, and Print Batches Fix

-- 1. Fix pass_type column in print_batches to have a default value and allow NULL
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'print_batches' AND COLUMN_NAME = 'pass_type');
SET @query = IF(@col_exists > 0, 'ALTER TABLE `print_batches` MODIFY COLUMN `pass_type` VARCHAR(50) NULL DEFAULT "PASS"', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Add barcode_type and sticker dimensions to events
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'barcode_type');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `events` ADD COLUMN `barcode_type` ENUM("QR_CODE", "CODE128") NOT NULL DEFAULT "QR_CODE" AFTER `status`, ADD COLUMN `sticker_width_mm` INT NOT NULL DEFAULT 38 AFTER `barcode_type`, ADD COLUMN `sticker_height_mm` INT NOT NULL DEFAULT 50 AFTER `sticker_width_mm`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3. Add barcode_type to printer_settings if not present
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'printer_settings' AND COLUMN_NAME = 'barcode_type');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `printer_settings` ADD COLUMN `barcode_type` ENUM("QR_CODE", "CODE128") NOT NULL DEFAULT "QR_CODE" AFTER `command_language`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 4. Create system_settings table for configurable platform name and settings
CREATE TABLE IF NOT EXISTS `system_settings` (
  `setting_key` VARCHAR(50) PRIMARY KEY,
  `setting_value` TEXT NOT NULL,
  `description` VARCHAR(255) NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Seed default platform_name if not present
INSERT INTO `system_settings` (`setting_key`, `setting_value`, `description`)
VALUES ('platform_name', 'EventGen', 'Platform Brand Name displayed across web, scanner and print apps')
ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`;

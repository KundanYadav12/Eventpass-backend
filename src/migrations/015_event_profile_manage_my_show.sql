-- Migration 015: Manage My Show — Premium Event Profile Support
-- Strictly Additive & Production-Safe: Zero changes to passes, barcodes, or scan logs.

-- 1. Add Event Profile Columns to `events` table
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'category');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `events` ADD COLUMN `category` VARCHAR(100) DEFAULT "Cultural / Garba Festival" AFTER `venue`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'banner_image');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `events` ADD COLUMN `banner_image` MEDIUMTEXT NULL AFTER `category`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'organizer_name');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `events` ADD COLUMN `organizer_name` VARCHAR(150) DEFAULT "Ariso Traders" AFTER `banner_image`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'organizer_desc');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `events` ADD COLUMN `organizer_desc` TEXT NULL AFTER `organizer_name`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'contact_email');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `events` ADD COLUMN `contact_email` VARCHAR(150) NULL AFTER `organizer_desc`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'contact_phone');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `events` ADD COLUMN `contact_phone` VARCHAR(50) NULL AFTER `contact_email`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'enquiry_email');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `events` ADD COLUMN `enquiry_email` VARCHAR(150) DEFAULT "jignesh2515@gmail.com" AFTER `contact_phone`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'instagram_url');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `events` ADD COLUMN `instagram_url` VARCHAR(500) DEFAULT "https://www.instagram.com/arisotraders?igsi=MTRjcHVsbXJxOTR0cQ==" AFTER `enquiry_email`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'social_links');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `events` ADD COLUMN `social_links` JSON NULL AFTER `instagram_url`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'cta_text');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `events` ADD COLUMN `cta_text` VARCHAR(100) DEFAULT "Get Your Pass" AFTER `social_links`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'cta_url');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `events` ADD COLUMN `cta_url` VARCHAR(255) DEFAULT "/login" AFTER `cta_text`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'footer_heading');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `events` ADD COLUMN `footer_heading` VARCHAR(150) DEFAULT "Manage My Show" AFTER `cta_url`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'footer_text');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `events` ADD COLUMN `footer_text` TEXT NULL AFTER `footer_heading`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'is_featured_public');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `events` ADD COLUMN `is_featured_public` TINYINT(1) DEFAULT 1 AFTER `footer_text`, ADD INDEX `idx_featured_public` (`is_featured_public`)', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Update Event 1 defaults to Rass Utsav 2026 Profile
UPDATE `events` SET
  `event_name` = 'Rass Utsav 2026',
  `category` = COALESCE(NULLIF(`category`, ''), 'Garba & Cultural Rass Utsav'),
  `description` = COALESCE(NULLIF(`description`, ''), 'Experience the divine celebration of rhythm, devotion, and traditional heritage at Rass Utsav 2026. Controlled entry and high-speed barcode verification powered by Manage My Show.'),
  `venue` = COALESCE(NULLIF(`venue`, ''), 'Grand Heritage Grounds, Borivali / Kandivali, Mumbai'),
  `organizer_name` = COALESCE(NULLIF(`organizer_name`, ''), 'Ariso Traders'),
  `organizer_desc` = COALESCE(NULLIF(`organizer_desc`, ''), 'Premier cultural and event production organization bringing authentic celebrations to life with state-of-the-art entry technology.'),
  `enquiry_email` = COALESCE(NULLIF(`enquiry_email`, ''), 'jignesh2515@gmail.com'),
  `instagram_url` = COALESCE(NULLIF(`instagram_url`, ''), 'https://www.instagram.com/arisotraders?igsi=MTRjcHVsbXJxOTR0cQ=='),
  `cta_text` = COALESCE(NULLIF(`cta_text`, ''), 'Get Your Pass'),
  `cta_url` = COALESCE(NULLIF(`cta_url`, ''), '/login'),
  `footer_heading` = COALESCE(NULLIF(`footer_heading`, ''), 'Manage My Show'),
  `footer_text` = COALESCE(NULLIF(`footer_text`, ''), 'Powering smarter event access and pass validation.'),
  `is_featured_public` = 1
WHERE `id` = 1;

-- 3. Update Platform Name in system_settings to Manage My Show
INSERT INTO `system_settings` (`setting_key`, `setting_value`, `description`, `updated_at`)
VALUES ('platform_name', 'Manage My Show', 'Platform Brand Name displayed across web, scanner and print apps', NOW())
ON DUPLICATE KEY UPDATE `setting_value` = 'Manage My Show', `updated_at` = NOW();

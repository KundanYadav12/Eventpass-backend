-- =====================================================================
-- Migration: 007_configurable_renewal_and_ist.sql
-- Description: Add configurable per-category scan behavior and renewal rules
-- =====================================================================

-- 1. Add scan_behavior column to pass_categories ('ONE_TIME' or 'RENEWABLE')
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pass_categories' AND COLUMN_NAME = 'scan_behavior');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `pass_categories` ADD COLUMN `scan_behavior` VARCHAR(20) NOT NULL DEFAULT "ONE_TIME" AFTER `max_daily_scans`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Add renewal_time column to pass_categories (IST clock time, e.g. "01:00")
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pass_categories' AND COLUMN_NAME = 'renewal_time');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `pass_categories` ADD COLUMN `renewal_time` VARCHAR(10) NOT NULL DEFAULT "01:00" AFTER `scan_behavior`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3. Add renewal_active_from column to pass_categories
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pass_categories' AND COLUMN_NAME = 'renewal_active_from');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `pass_categories` ADD COLUMN `renewal_active_from` DATETIME NULL AFTER `renewal_time`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 4. Add renewal_active_until column to pass_categories
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pass_categories' AND COLUMN_NAME = 'renewal_active_until');
SET @query = IF(@col_exists = 0, 'ALTER TABLE `pass_categories` ADD COLUMN `renewal_active_until` DATETIME NULL AFTER `renewal_active_from`', 'SELECT 1');
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 5. Migrate existing all_season pass categories to RENEWABLE
UPDATE `pass_categories`
SET `scan_behavior` = 'RENEWABLE',
    `renewal_time` = '01:00',
    `renewal_active_from` = COALESCE(`renewal_active_from`, `valid_from`),
    `renewal_active_until` = COALESCE(`renewal_active_until`, `valid_until`)
WHERE `code` = 'all_season' OR `code` LIKE '%season%' OR `max_daily_scans` > 1;

-- 6. Set remaining categories to ONE_TIME
UPDATE `pass_categories`
SET `scan_behavior` = 'ONE_TIME'
WHERE `scan_behavior` IS NULL OR `scan_behavior` = '';

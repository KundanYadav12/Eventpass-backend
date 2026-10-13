-- 020_checkpoints_time_and_dynamic_registration_forms.sql
-- Addendum: Time-Based Checkpoints, Location Attendance Tracking & Dynamic Self-Registration Form Builder

SET @dbname = DATABASE();

-- 1. scan_checkpoints.start_time
SET @tablename = "scan_checkpoints";
SET @columnname = "start_time";
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname) > 0,
  "SELECT 1",
  "ALTER TABLE scan_checkpoints ADD COLUMN start_time TIME NULL AFTER allowed_categories"
));
PREPARE stmt1 FROM @preparedStatement;
EXECUTE stmt1;
DEALLOCATE PREPARE stmt1;

-- 2. scan_checkpoints.end_time
SET @columnname = "end_time";
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname) > 0,
  "SELECT 1",
  "ALTER TABLE scan_checkpoints ADD COLUMN end_time TIME NULL AFTER start_time"
));
PREPARE stmt2 FROM @preparedStatement;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- 3. scan_checkpoints.checkpoint_type
SET @columnname = "checkpoint_type";
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname) > 0,
  "SELECT 1",
  "ALTER TABLE scan_checkpoints ADD COLUMN checkpoint_type VARCHAR(50) NOT NULL DEFAULT 'LOCATION' AFTER end_time"
));
PREPARE stmt3 FROM @preparedStatement;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;

-- 4. self_registrations.custom_fields
SET @tablename = "self_registrations";
SET @columnname = "custom_fields";
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname) > 0,
  "SELECT 1",
  "ALTER TABLE self_registrations ADD COLUMN custom_fields JSON NULL AFTER require_age"
));
PREPARE stmt4 FROM @preparedStatement;
EXECUTE stmt4;
DEALLOCATE PREPARE stmt4;

-- 5. passes.custom_fields_data
SET @tablename = "passes";
SET @columnname = "custom_fields_data";
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname) > 0,
  "SELECT 1",
  "ALTER TABLE passes ADD COLUMN custom_fields_data JSON NULL AFTER age"
));
PREPARE stmt5 FROM @preparedStatement;
EXECUTE stmt5;
DEALLOCATE PREPARE stmt5;

-- 6. passes.photo_url
SET @columnname = "photo_url";
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname) > 0,
  "SELECT 1",
  "ALTER TABLE passes ADD COLUMN photo_url VARCHAR(255) NULL AFTER custom_fields_data"
));
PREPARE stmt6 FROM @preparedStatement;
EXECUTE stmt6;
DEALLOCATE PREPARE stmt6;

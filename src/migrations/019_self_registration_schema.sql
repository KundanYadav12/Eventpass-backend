-- 019_self_registration_schema.sql
-- Self Registration with Shareable QR/Link and Automated Pass Delivery

-- 1. Create self_registrations table
CREATE TABLE IF NOT EXISTS `self_registrations` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `public_token` VARCHAR(64) NOT NULL UNIQUE,
  `event_id` INT NOT NULL,
  `category_id` INT NOT NULL,
  `pass_style_id` INT NULL,
  `title` VARCHAR(255) NULL,
  `description` TEXT NULL,
  `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
  `starts_at` DATETIME NULL,
  `ends_at` DATETIME NULL,
  `delivery_channel` ENUM('WHATSAPP', 'EMAIL', 'BOTH') NOT NULL DEFAULT 'BOTH',
  `require_name` TINYINT(1) NOT NULL DEFAULT 1,
  `require_phone` TINYINT(1) NOT NULL DEFAULT 1,
  `require_email` TINYINT(1) NOT NULL DEFAULT 1,
  `require_address` TINYINT(1) NOT NULL DEFAULT 0,
  `require_gender` TINYINT(1) NOT NULL DEFAULT 0,
  `require_age` TINYINT(1) NOT NULL DEFAULT 0,
  `allow_duplicate` TINYINT(1) NOT NULL DEFAULT 0,
  `max_registrations` INT NULL,
  `registration_count` INT NOT NULL DEFAULT 0,
  `created_by` INT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_self_reg_event` (`event_id`),
  INDEX `idx_self_reg_category` (`category_id`),
  INDEX `idx_self_reg_token` (`public_token`),
  FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`category_id`) REFERENCES `pass_categories`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Add additive columns to passes table
SET @dbname = DATABASE();

-- passes.source
SET @tablename = "passes";
SET @columnname = "source";
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname) > 0,
  "SELECT 1",
  "ALTER TABLE passes ADD COLUMN source VARCHAR(50) NOT NULL DEFAULT 'DIRECT' AFTER sharing_method"
));
PREPARE stmt1 FROM @preparedStatement;
EXECUTE stmt1;
DEALLOCATE PREPARE stmt1;

-- passes.self_registration_id
SET @columnname = "self_registration_id";
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname) > 0,
  "SELECT 1",
  "ALTER TABLE passes ADD COLUMN self_registration_id INT NULL AFTER source, ADD INDEX idx_passes_self_reg (self_registration_id)"
));
PREPARE stmt2 FROM @preparedStatement;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- passes.address
SET @columnname = "address";
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname) > 0,
  "SELECT 1",
  "ALTER TABLE passes ADD COLUMN address VARCHAR(255) NULL AFTER customer_phone"
));
PREPARE stmt3 FROM @preparedStatement;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;

-- passes.gender
SET @columnname = "gender";
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname) > 0,
  "SELECT 1",
  "ALTER TABLE passes ADD COLUMN gender VARCHAR(20) NULL AFTER address"
));
PREPARE stmt4 FROM @preparedStatement;
EXECUTE stmt4;
DEALLOCATE PREPARE stmt4;

-- passes.age
SET @columnname = "age";
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname) > 0,
  "SELECT 1",
  "ALTER TABLE passes ADD COLUMN age INT NULL AFTER gender"
));
PREPARE stmt5 FROM @preparedStatement;
EXECUTE stmt5;
DEALLOCATE PREPARE stmt5;

-- 3. Add additive columns to billings table
-- billings.source
SET @tablename = "billings";
SET @columnname = "source";
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname) > 0,
  "SELECT 1",
  "ALTER TABLE billings ADD COLUMN source VARCHAR(50) NOT NULL DEFAULT 'DIRECT' AFTER is_complementary"
));
PREPARE stmt6 FROM @preparedStatement;
EXECUTE stmt6;
DEALLOCATE PREPARE stmt6;

-- billings.self_registration_id
SET @columnname = "self_registration_id";
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname) > 0,
  "SELECT 1",
  "ALTER TABLE billings ADD COLUMN self_registration_id INT NULL AFTER source, ADD INDEX idx_billings_self_reg (self_registration_id)"
));
PREPARE stmt7 FROM @preparedStatement;
EXECUTE stmt7;
DEALLOCATE PREPARE stmt7;

-- 4. Register permissions & grant to SuperAdmin and Event Admins
INSERT IGNORE INTO `permissions` (`code`, `name`, `description`)
VALUES ('self_registration.manage', 'Manage Self Registration', 'Create, configure, and share self-registration links and QR codes');

-- Grant to Role 1 (SUPERADMIN)
INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT 1, p.id FROM `permissions` p WHERE p.code = 'self_registration.manage';

-- Grant to Role 2 (ADMIN)
INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT 2, p.id FROM `permissions` p WHERE p.code = 'self_registration.manage';

-- Grant event-level permission to existing Admins
INSERT IGNORE INTO `admin_event_permissions` (`user_id`, `event_id`, `permission_id`)
SELECT u.id, u.event_id, p.id
FROM `users` u
JOIN `permissions` p ON p.code = 'self_registration.manage'
WHERE u.role_id = 2 AND u.event_id IS NOT NULL;

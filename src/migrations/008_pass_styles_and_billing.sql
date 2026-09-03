-- EventGen Migration 008: Pass Styles, Customer Billing, and Granular RBAC Permissions

-- 1. Pass Styles / Designer Table
CREATE TABLE IF NOT EXISTS `pass_styles` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_id` INT NULL,
  `name` VARCHAR(100) NOT NULL,
  `description` VARCHAR(255) NULL,
  `background_image_url` LONGTEXT NULL,
  `canvas_width` INT NOT NULL DEFAULT 800,
  `canvas_height` INT NOT NULL DEFAULT 1200,
  `elements_config` JSON NOT NULL,
  `is_default` BOOLEAN NOT NULL DEFAULT FALSE,
  `created_by` INT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_style_event` (`event_id`),
  FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Customer Billings / Invoices Table
CREATE TABLE IF NOT EXISTS `billings` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `bill_number` VARCHAR(50) NOT NULL UNIQUE,
  `event_id` INT NOT NULL,
  `category_id` INT NOT NULL,
  `style_id` INT NULL,
  `customer_name` VARCHAR(150) NOT NULL,
  `customer_email` VARCHAR(191) NULL,
  `customer_phone` VARCHAR(50) NULL,
  `sponsor_name` VARCHAR(150) NULL,
  `quantity` INT NOT NULL DEFAULT 1,
  `unit_price` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `subtotal` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `gst_mode` ENUM('INCLUDED', 'EXCLUDED', 'OFF') NOT NULL DEFAULT 'INCLUDED',
  `gst_rate` DECIMAL(5,2) NOT NULL DEFAULT 18.00,
  `gst_amount` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `total_amount` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `include_pass_code_on_bill` BOOLEAN NOT NULL DEFAULT TRUE,
  `sent_via` ENUM('EMAIL', 'WHATSAPP', 'BOTH', 'NONE') NOT NULL DEFAULT 'NONE',
  `created_by` INT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_billing_event` (`event_id`),
  INDEX `idx_billing_customer` (`customer_email`, `customer_phone`),
  FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`category_id`) REFERENCES `pass_categories`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`style_id`) REFERENCES `pass_styles`(`id`) ON DELETE SET NULL,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Extend passes table safely
SET @col_billing_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passes' AND COLUMN_NAME = 'billing_id');
SET @sql_add_billing_col = IF(@col_billing_exists = 0, 'ALTER TABLE `passes` ADD COLUMN `billing_id` INT NULL AFTER `print_batch_id`', 'SELECT 1');
PREPARE stmt_b FROM @sql_add_billing_col;
EXECUTE stmt_b;
DEALLOCATE PREPARE stmt_b;

SET @col_style_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passes' AND COLUMN_NAME = 'style_id');
SET @sql_add_style_col = IF(@col_style_exists = 0, 'ALTER TABLE `passes` ADD COLUMN `style_id` INT NULL AFTER `billing_id`', 'SELECT 1');
PREPARE stmt_s FROM @sql_add_style_col;
EXECUTE stmt_s;
DEALLOCATE PREPARE stmt_s;

SET @col_cname_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passes' AND COLUMN_NAME = 'customer_name');
SET @sql_add_cname = IF(@col_cname_exists = 0, 'ALTER TABLE `passes` ADD COLUMN `customer_name` VARCHAR(150) NULL AFTER `style_id`', 'SELECT 1');
PREPARE stmt_cn FROM @sql_add_cname;
EXECUTE stmt_cn;
DEALLOCATE PREPARE stmt_cn;

SET @col_cemail_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passes' AND COLUMN_NAME = 'customer_email');
SET @sql_add_cemail = IF(@col_cemail_exists = 0, 'ALTER TABLE `passes` ADD COLUMN `customer_email` VARCHAR(191) NULL AFTER `customer_name`', 'SELECT 1');
PREPARE stmt_ce FROM @sql_add_cemail;
EXECUTE stmt_ce;
DEALLOCATE PREPARE stmt_ce;

SET @col_cphone_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passes' AND COLUMN_NAME = 'customer_phone');
SET @sql_add_cphone = IF(@col_cphone_exists = 0, 'ALTER TABLE `passes` ADD COLUMN `customer_phone` VARCHAR(50) NULL AFTER `customer_email`', 'SELECT 1');
PREPARE stmt_cp FROM @sql_add_cphone;
EXECUTE stmt_cp;
DEALLOCATE PREPARE stmt_cp;

SET @col_sponsor_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passes' AND COLUMN_NAME = 'sponsor_name');
SET @sql_add_sponsor = IF(@col_sponsor_exists = 0, 'ALTER TABLE `passes` ADD COLUMN `sponsor_name` VARCHAR(150) NULL AFTER `customer_phone`', 'SELECT 1');
PREPARE stmt_sp FROM @sql_add_sponsor;
EXECUTE stmt_sp;
DEALLOCATE PREPARE stmt_sp;

-- Add foreign keys to passes if not already existing
SET @fk_billing_exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_passes_billing' AND TABLE_NAME = 'passes');
SET @sql_add_fk_billing = IF(@fk_billing_exists = 0, 'ALTER TABLE `passes` ADD CONSTRAINT `fk_passes_billing` FOREIGN KEY (`billing_id`) REFERENCES `billings`(`id`) ON DELETE SET NULL', 'SELECT 1');
PREPARE stmt1 FROM @sql_add_fk_billing;
EXECUTE stmt1;
DEALLOCATE PREPARE stmt1;

SET @fk_style_exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_passes_style' AND TABLE_NAME = 'passes');
SET @sql_add_fk_style = IF(@fk_style_exists = 0, 'ALTER TABLE `passes` ADD CONSTRAINT `fk_passes_style` FOREIGN KEY (`style_id`) REFERENCES `pass_styles`(`id`) ON DELETE SET NULL', 'SELECT 1');
PREPARE stmt2 FROM @sql_add_fk_style;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- 4. Insert new Permissions
INSERT INTO `permissions` (`code`, `name`, `module`, `description`) VALUES
  ('categories.create', 'Create Categories', 'Categories', 'Create and configure new pass categories'),
  ('pass_styles.view', 'View Pass Styles', 'PassStyles', 'View pass styles and visual templates'),
  ('pass_styles.create', 'Create Pass Styles', 'PassStyles', 'Create and design new pass styles'),
  ('pass_styles.edit', 'Edit Pass Styles', 'PassStyles', 'Edit existing pass styles'),
  ('pass_styles.delete', 'Delete Pass Styles', 'PassStyles', 'Delete pass styles'),
  ('pass_styles.use', 'Use Pass Styles', 'PassStyles', 'Use pass styles for generating customer passes'),
  ('billing.create', 'Customer Billing & Issue', 'Billing', 'Create customer bills, generate styled passes, and send via Email/WhatsApp')
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `module` = VALUES(`module`), `description` = VALUES(`description`);

-- 5. Assign ALL permissions to SuperAdmin (Role 1)
INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT 1, `id` FROM `permissions`;

-- 6. Enforce that for Event Admin (Role 2), 'passes.generate', 'categories.create', and 'pass_styles.*' are OFF by default unless explicitly granted
DELETE FROM `role_permissions` 
WHERE `role_id` = 2 AND `permission_id` IN (
  SELECT `id` FROM `permissions` WHERE `code` IN ('passes.generate', 'categories.create', 'pass_styles.view', 'pass_styles.create', 'pass_styles.edit', 'pass_styles.delete', 'pass_styles.use')
);

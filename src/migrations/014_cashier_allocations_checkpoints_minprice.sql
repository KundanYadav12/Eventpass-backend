-- EventGen Migration 014: Cashier Role, Pass Allocations, Dynamic Scan Checkpoints & Minimum Selling Price
-- Strictly Additive & Production-Safe (Preserves all existing passes, barcodes, and scan history)

-- 1. Insert Role 3: CASHIER if not exists
INSERT IGNORE INTO `roles` (`id`, `name`, `description`) VALUES
  (3, 'CASHIER', 'Restricted pass seller and gate scanner for assigned event allocations');

-- 2. Insert Granular Permissions for Cashier, Allocations, and Checkpoints
INSERT INTO `permissions` (`code`, `name`, `module`, `description`) VALUES
  ('cashier.sell', 'Sell Allocated Passes', 'Cashier', 'Sell passes within assigned category allocation quota'),
  ('cashier.view_own_sales', 'View Own Sales', 'Cashier', 'View sales history and statistics for own cashier account'),
  ('allocations.manage', 'Manage Cashier Allocations', 'Allocations', 'Allocate pass inventory to cashiers and adjust quotas'),
  ('checkpoints.manage', 'Manage Scan Checkpoints', 'Checkpoints', 'Create, configure, and reorder event scan checkpoints')
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `module` = VALUES(`module`), `description` = VALUES(`description`);

-- Assign permissions to SuperAdmin (Role 1)
INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT 1, `id` FROM `permissions` WHERE `code` IN ('cashier.sell', 'cashier.view_own_sales', 'allocations.manage', 'checkpoints.manage');

-- Assign permissions to Event Admin (Role 2)
INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT 2, `id` FROM `permissions` WHERE `code` IN ('cashier.sell', 'cashier.view_own_sales', 'allocations.manage', 'checkpoints.manage');

-- Assign restricted permissions to Cashier (Role 3)
INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT 3, `id` FROM `permissions` WHERE `code` IN ('cashier.sell', 'cashier.view_own_sales', 'scan.operate');

-- 3. Create `cashier_allocations` Table
CREATE TABLE IF NOT EXISTS `cashier_allocations` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_id` INT NOT NULL,
  `category_id` INT NOT NULL,
  `cashier_id` INT NOT NULL,
  `allocated_quantity` INT NOT NULL DEFAULT 0,
  `sold_quantity` INT NOT NULL DEFAULT 0,
  `created_by` INT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_event_cat_cashier` (`event_id`, `category_id`, `cashier_id`),
  INDEX `idx_alloc_event` (`event_id`),
  INDEX `idx_alloc_cashier` (`cashier_id`),
  INDEX `idx_alloc_cat` (`category_id`),
  CONSTRAINT `fk_alloc_event` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_alloc_category` FOREIGN KEY (`category_id`) REFERENCES `pass_categories`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_alloc_cashier` FOREIGN KEY (`cashier_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_alloc_creator` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Create `scan_checkpoints` Table
CREATE TABLE IF NOT EXISTS `scan_checkpoints` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_id` INT NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `code` VARCHAR(50) NOT NULL,
  `description` VARCHAR(255) NULL,
  `display_order` INT NOT NULL DEFAULT 0,
  `is_active` BOOLEAN NOT NULL DEFAULT TRUE,
  `max_scans_per_pass` INT NOT NULL DEFAULT 1,
  `allowed_categories` JSON NULL,
  `created_by` INT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_checkpoint_event` (`event_id`),
  INDEX `idx_checkpoint_order` (`event_id`, `display_order`),
  INDEX `idx_checkpoint_active` (`event_id`, `is_active`),
  CONSTRAINT `fk_checkpoint_event` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_checkpoint_creator` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Safely add `min_selling_price` to `pass_categories`
SET @col_msp_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pass_categories' AND COLUMN_NAME = 'min_selling_price');
SET @sql_add_msp = IF(@col_msp_exists = 0, "ALTER TABLE `pass_categories` ADD COLUMN `min_selling_price` DECIMAL(10,2) NULL DEFAULT 0.00 AFTER `price`", "SELECT 1");
PREPARE stmt_msp FROM @sql_add_msp;
EXECUTE stmt_msp;
DEALLOCATE PREPARE stmt_msp;

-- 6. Safely add `cashier_id` and `allocation_id` to `billings`
SET @col_cid_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'billings' AND COLUMN_NAME = 'cashier_id');
SET @sql_add_cid = IF(@col_cid_exists = 0, "ALTER TABLE `billings` ADD COLUMN `cashier_id` INT NULL AFTER `created_by`, ADD COLUMN `allocation_id` INT NULL AFTER `cashier_id`, ADD INDEX `idx_billing_cashier` (`cashier_id`), ADD INDEX `idx_billing_allocation` (`allocation_id`)", "SELECT 1");
PREPARE stmt_cid FROM @sql_add_cid;
EXECUTE stmt_cid;
DEALLOCATE PREPARE stmt_cid;

-- 7. Safely add `checkpoint_id` to `scan_history`
SET @col_chk_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scan_history' AND COLUMN_NAME = 'checkpoint_id');
SET @sql_add_chk = IF(@col_chk_exists = 0, "ALTER TABLE `scan_history` ADD COLUMN `checkpoint_id` INT NULL AFTER `category_id`, ADD INDEX `idx_scan_checkpoint` (`checkpoint_id`)", "SELECT 1");
PREPARE stmt_chk FROM @sql_add_chk;
EXECUTE stmt_chk;
DEALLOCATE PREPARE stmt_chk;

-- 8. Seed default checkpoints for Event 1 & Event 2 if none exist
INSERT IGNORE INTO `scan_checkpoints` (`event_id`, `name`, `code`, `display_order`, `is_active`, `max_scans_per_pass`)
SELECT 1, 'Entry', 'ENTRY', 1, TRUE, 1
WHERE NOT EXISTS (SELECT 1 FROM `scan_checkpoints` WHERE `event_id` = 1 AND `code` = 'ENTRY');

INSERT IGNORE INTO `scan_checkpoints` (`event_id`, `name`, `code`, `display_order`, `is_active`, `max_scans_per_pass`)
SELECT 1, 'Breakfast', 'BREAKFAST', 2, TRUE, 1
WHERE NOT EXISTS (SELECT 1 FROM `scan_checkpoints` WHERE `event_id` = 1 AND `code` = 'BREAKFAST');

INSERT IGNORE INTO `scan_checkpoints` (`event_id`, `name`, `code`, `display_order`, `is_active`, `max_scans_per_pass`)
SELECT 1, 'Lunch', 'LUNCH', 3, TRUE, 1
WHERE NOT EXISTS (SELECT 1 FROM `scan_checkpoints` WHERE `event_id` = 1 AND `code` = 'LUNCH');

INSERT IGNORE INTO `scan_checkpoints` (`event_id`, `name`, `code`, `display_order`, `is_active`, `max_scans_per_pass`)
SELECT 1, 'Snacks', 'SNACKS', 4, TRUE, 1
WHERE NOT EXISTS (SELECT 1 FROM `scan_checkpoints` WHERE `event_id` = 1 AND `code` = 'SNACKS');

INSERT IGNORE INTO `scan_checkpoints` (`event_id`, `name`, `code`, `display_order`, `is_active`, `max_scans_per_pass`)
SELECT 1, 'Dinner', 'DINNER', 5, TRUE, 1
WHERE NOT EXISTS (SELECT 1 FROM `scan_checkpoints` WHERE `event_id` = 1 AND `code` = 'DINNER');

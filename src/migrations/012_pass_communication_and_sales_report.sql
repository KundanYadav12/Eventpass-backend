-- EventGen Migration 012: Pass Customer Communication Tracking, Reshare History & Sales Report RBAC

-- 1. Safely add communication and customer sharing columns to `passes` table
SET @col_sm_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passes' AND COLUMN_NAME = 'sharing_method');
SET @sql_add_sm = IF(@col_sm_exists = 0, "ALTER TABLE `passes` ADD COLUMN `sharing_method` ENUM('EMAIL', 'WHATSAPP', 'BOTH', 'NONE') NOT NULL DEFAULT 'NONE' AFTER `sponsor_name`", "SELECT 1");
PREPARE stmt_sm FROM @sql_add_sm;
EXECUTE stmt_sm;
DEALLOCATE PREPARE stmt_sm;

SET @col_fsa_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passes' AND COLUMN_NAME = 'first_shared_at');
SET @sql_add_fsa = IF(@col_fsa_exists = 0, "ALTER TABLE `passes` ADD COLUMN `first_shared_at` DATETIME NULL AFTER `sharing_method`", "SELECT 1");
PREPARE stmt_fsa FROM @sql_add_fsa;
EXECUTE stmt_fsa;
DEALLOCATE PREPARE stmt_fsa;

SET @col_lsa_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passes' AND COLUMN_NAME = 'last_shared_at');
SET @sql_add_lsa = IF(@col_lsa_exists = 0, "ALTER TABLE `passes` ADD COLUMN `last_shared_at` DATETIME NULL AFTER `first_shared_at`", "SELECT 1");
PREPARE stmt_lsa FROM @sql_add_lsa;
EXECUTE stmt_lsa;
DEALLOCATE PREPARE stmt_lsa;

SET @col_rc_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passes' AND COLUMN_NAME = 'reshare_count');
SET @sql_add_rc = IF(@col_rc_exists = 0, "ALTER TABLE `passes` ADD COLUMN `reshare_count` INT NOT NULL DEFAULT 0 AFTER `last_shared_at`", "SELECT 1");
PREPARE stmt_rc FROM @sql_add_rc;
EXECUTE stmt_rc;
DEALLOCATE PREPARE stmt_rc;

SET @col_sb_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passes' AND COLUMN_NAME = 'shared_by');
SET @sql_add_sb = IF(@col_sb_exists = 0, "ALTER TABLE `passes` ADD COLUMN `shared_by` INT NULL AFTER `reshare_count`", "SELECT 1");
PREPARE stmt_sb FROM @sql_add_sb;
EXECUTE stmt_sb;
DEALLOCATE PREPARE stmt_sb;

-- Add indexes on passes for customer search & fast filtering
SET @idx_cname_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passes' AND INDEX_NAME = 'idx_passes_cname');
SET @sql_add_idx_cname = IF(@idx_cname_exists = 0, "ALTER TABLE `passes` ADD INDEX `idx_passes_cname` (`customer_name`)", "SELECT 1");
PREPARE stmt_icn FROM @sql_add_idx_cname;
EXECUTE stmt_icn;
DEALLOCATE PREPARE stmt_icn;

SET @idx_cemail_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passes' AND INDEX_NAME = 'idx_passes_cemail');
SET @sql_add_idx_cemail = IF(@idx_cemail_exists = 0, "ALTER TABLE `passes` ADD INDEX `idx_passes_cemail` (`customer_email`)", "SELECT 1");
PREPARE stmt_ice FROM @sql_add_idx_cemail;
EXECUTE stmt_ice;
DEALLOCATE PREPARE stmt_ice;

SET @idx_cphone_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passes' AND INDEX_NAME = 'idx_passes_cphone');
SET @sql_add_idx_cphone = IF(@idx_cphone_exists = 0, "ALTER TABLE `passes` ADD INDEX `idx_passes_cphone` (`customer_phone`)", "SELECT 1");
PREPARE stmt_icp FROM @sql_add_idx_cphone;
EXECUTE stmt_icp;
DEALLOCATE PREPARE stmt_icp;

SET @idx_lsa_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passes' AND INDEX_NAME = 'idx_passes_last_shared');
SET @sql_add_idx_lsa = IF(@idx_lsa_exists = 0, "ALTER TABLE `passes` ADD INDEX `idx_passes_last_shared` (`last_shared_at`)", "SELECT 1");
PREPARE stmt_ilsa FROM @sql_add_idx_lsa;
EXECUTE stmt_ilsa;
DEALLOCATE PREPARE stmt_ilsa;

-- 2. Create `pass_communication_history` table for immutable share/reshare logging
CREATE TABLE IF NOT EXISTS `pass_communication_history` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `pass_id` INT NOT NULL,
  `event_id` INT NOT NULL,
  `billing_id` INT NULL,
  `customer_name` VARCHAR(150) NOT NULL,
  `customer_email` VARCHAR(191) NULL,
  `customer_phone` VARCHAR(50) NULL,
  `sharing_method` ENUM('EMAIL', 'WHATSAPP', 'BOTH') NOT NULL,
  `status` ENUM('SENT', 'READY', 'FAILED') NOT NULL DEFAULT 'SENT',
  `shared_by` INT NULL,
  `shared_by_name` VARCHAR(100) NULL,
  `notes` VARCHAR(255) NULL,
  `shared_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_pch_pass` (`pass_id`),
  INDEX `idx_pch_event` (`event_id`),
  INDEX `idx_pch_billing` (`billing_id`),
  INDEX `idx_pch_email` (`customer_email`),
  INDEX `idx_pch_phone` (`customer_phone`),
  INDEX `idx_pch_shared_at` (`shared_at`),
  CONSTRAINT `fk_pch_pass` FOREIGN KEY (`pass_id`) REFERENCES `passes`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pch_event` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pch_billing` FOREIGN KEY (`billing_id`) REFERENCES `billings`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pch_user` FOREIGN KEY (`shared_by`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Backfill existing passes linked to billings
UPDATE `passes` p
JOIN `billings` b ON p.billing_id = b.id
SET 
  p.customer_name = COALESCE(p.customer_name, b.customer_name),
  p.customer_email = COALESCE(p.customer_email, b.customer_email),
  p.customer_phone = COALESCE(p.customer_phone, b.customer_phone),
  p.sponsor_name = COALESCE(p.sponsor_name, b.sponsor_name),
  p.sharing_method = CASE 
    WHEN b.sent_via IN ('EMAIL', 'WHATSAPP', 'BOTH') THEN b.sent_via 
    ELSE 'NONE' 
  END,
  p.first_shared_at = IF(b.sent_via IN ('EMAIL', 'WHATSAPP', 'BOTH'), b.created_at, NULL),
  p.last_shared_at = IF(b.sent_via IN ('EMAIL', 'WHATSAPP', 'BOTH'), b.created_at, NULL),
  p.shared_by = b.created_by
WHERE p.billing_id IS NOT NULL AND (p.sharing_method = 'NONE' OR p.sharing_method IS NULL);

-- Backfill initial communication history for billed passes that were shared
INSERT IGNORE INTO `pass_communication_history` (pass_id, event_id, billing_id, customer_name, customer_email, customer_phone, sharing_method, status, shared_by, notes, shared_at, created_at)
SELECT 
  p.id, 
  p.event_id, 
  b.id, 
  b.customer_name, 
  b.customer_email, 
  b.customer_phone, 
  b.sent_via, 
  'SENT', 
  b.created_by, 
  'Initial pass issue and dispatch', 
  b.created_at,
  b.created_at
FROM `passes` p
JOIN `billings` b ON p.billing_id = b.id
WHERE b.sent_via IN ('EMAIL', 'WHATSAPP', 'BOTH')
  AND NOT EXISTS (
    SELECT 1 FROM `pass_communication_history` pch WHERE pch.pass_id = p.id
  );

-- 4. Insert Sales Report and Reshare Permissions
INSERT INTO `permissions` (`code`, `name`, `module`, `description`) VALUES
  ('sales.view', 'View Sales Reports', 'Sales', 'View sales dashboard, transaction ledger, and export sales reports'),
  ('passes.reshare', 'Reshare Passes', 'Passes', 'Reshare customer passes via Email or WhatsApp')
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `module` = VALUES(`module`), `description` = VALUES(`description`);

-- Assign permissions to SuperAdmin (Role 1) and Event Admin (Role 2)
INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT 1, `id` FROM `permissions` WHERE `code` IN ('sales.view', 'passes.reshare');

INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT 2, `id` FROM `permissions` WHERE `code` IN ('sales.view', 'passes.reshare');

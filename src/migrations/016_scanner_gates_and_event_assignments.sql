-- EventGen Migration 016: Dynamic Event Gates & Multi-Event User Assignments
-- Strictly Additive & Production-Safe (Preserves all 18,687 existing passes, barcodes, and scan history)

-- 1. Create `event_gates` Table for configurable gates/devices per event
CREATE TABLE IF NOT EXISTS `event_gates` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_id` INT NOT NULL,
  `gate_name` VARCHAR(100) NOT NULL,
  `gate_code` VARCHAR(50) NOT NULL,
  `description` VARCHAR(255) NULL,
  `display_order` INT NOT NULL DEFAULT 0,
  `is_active` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_by` INT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_gate_event` (`event_id`),
  INDEX `idx_gate_active` (`event_id`, `is_active`),
  INDEX `idx_gate_order` (`event_id`, `display_order`),
  CONSTRAINT `fk_gate_event` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_gate_creator` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Create `user_assigned_events` Junction Table for explicit multi-event user scoping
CREATE TABLE IF NOT EXISTS `user_assigned_events` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `event_id` INT NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_user_event` (`user_id`, `event_id`),
  INDEX `idx_assigned_user` (`user_id`),
  INDEX `idx_assigned_event` (`event_id`),
  CONSTRAINT `fk_assigned_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_assigned_event` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Seed `user_assigned_events` from existing `users.event_id`
INSERT IGNORE INTO `user_assigned_events` (`user_id`, `event_id`)
SELECT `id`, `event_id` FROM `users`
WHERE `event_id` IS NOT NULL;

-- Seed from existing `admin_event_permissions`
INSERT IGNORE INTO `user_assigned_events` (`user_id`, `event_id`)
SELECT DISTINCT `user_id`, `event_id` FROM `admin_event_permissions`
WHERE `event_id` IS NOT NULL;

-- 4. Seed default configurable gates for Event 1 ("Rass Utsav 2026") if none exist
INSERT IGNORE INTO `event_gates` (`event_id`, `gate_name`, `gate_code`, `description`, `display_order`, `is_active`)
SELECT 1, 'GATE-01 (Main Entrance Left)', 'GATE-01', 'Primary left entrance turnstiles', 1, TRUE
WHERE NOT EXISTS (SELECT 1 FROM `event_gates` WHERE `event_id` = 1 AND `gate_code` = 'GATE-01');

INSERT IGNORE INTO `event_gates` (`event_id`, `gate_name`, `gate_code`, `description`, `display_order`, `is_active`)
SELECT 1, 'GATE-02 (Main Entrance Right)', 'GATE-02', 'Primary right entrance turnstiles', 2, TRUE
WHERE NOT EXISTS (SELECT 1 FROM `event_gates` WHERE `event_id` = 1 AND `gate_code` = 'GATE-02');

INSERT IGNORE INTO `event_gates` (`event_id`, `gate_name`, `gate_code`, `description`, `display_order`, `is_active`)
SELECT 1, 'GATE-VIP (VIP Priority Turnstile)', 'GATE-VIP', 'Exclusive entrance for VIP & VVIP badge holders', 3, TRUE
WHERE NOT EXISTS (SELECT 1 FROM `event_gates` WHERE `event_id` = 1 AND `gate_code` = 'GATE-VIP');

INSERT IGNORE INTO `event_gates` (`event_id`, `gate_name`, `gate_code`, `description`, `display_order`, `is_active`)
SELECT 1, 'GATE-EAST (East Entrance)', 'GATE-EAST', 'Secondary east perimeter entry gate', 4, TRUE
WHERE NOT EXISTS (SELECT 1 FROM `event_gates` WHERE `event_id` = 1 AND `gate_code` = 'GATE-EAST');

-- Seed default configurable gates for Event 2 ("Music Festival 2026")
INSERT IGNORE INTO `event_gates` (`event_id`, `gate_name`, `gate_code`, `description`, `display_order`, `is_active`)
SELECT 2, 'GATE-A (Main Stage Entry)', 'GATE-A', 'Direct access to main concert grounds', 1, TRUE
WHERE NOT EXISTS (SELECT 1 FROM `event_gates` WHERE `event_id` = 2 AND `gate_code` = 'GATE-A');

INSERT IGNORE INTO `event_gates` (`event_id`, `gate_name`, `gate_code`, `description`, `display_order`, `is_active`)
SELECT 2, 'GATE-B (North Lawn Gate)', 'GATE-B', 'North perimeter general entry gate', 2, TRUE
WHERE NOT EXISTS (SELECT 1 FROM `event_gates` WHERE `event_id` = 2 AND `gate_code` = 'GATE-B');

INSERT IGNORE INTO `event_gates` (`event_id`, `gate_name`, `gate_code`, `description`, `display_order`, `is_active`)
SELECT 2, 'GATE-VIP (Backstage / Lounge)', 'GATE-VIP', 'Dedicated VIP turnstile', 3, TRUE
WHERE NOT EXISTS (SELECT 1 FROM `event_gates` WHERE `event_id` = 2 AND `gate_code` = 'GATE-VIP');

-- Seed default configurable gate for Event 1001 ("Mumbai Garba 2026")
INSERT IGNORE INTO `event_gates` (`event_id`, `gate_name`, `gate_code`, `description`, `display_order`, `is_active`)
SELECT 1001, 'GATE-01 (Ground Entrance)', 'GATE-01', 'Ground turnstile entry', 1, TRUE
WHERE NOT EXISTS (SELECT 1 FROM `event_gates` WHERE `event_id` = 1001 AND `gate_code` = 'GATE-01');

-- EventGen Migration 009: Event-Scoped Admin Permissions

-- 1. Create admin_event_permissions table for strict (user_id + event_id + permission_id) mapping
CREATE TABLE IF NOT EXISTS `admin_event_permissions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `event_id` INT NOT NULL,
  `permission_id` INT NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_user_event_perm` (`user_id`, `event_id`, `permission_id`),
  INDEX `idx_admin_event` (`user_id`, `event_id`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Seed initial event-scoped permissions for existing Admins (Role 2) based on their assigned event_id
INSERT IGNORE INTO `admin_event_permissions` (`user_id`, `event_id`, `permission_id`)
SELECT u.id, u.event_id, rp.permission_id
FROM `users` u
JOIN `role_permissions` rp ON u.role_id = rp.role_id
WHERE u.role_id = 2 AND u.event_id IS NOT NULL;

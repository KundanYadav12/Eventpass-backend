-- 017_cashiers_manage_permission_and_created_by.sql
-- Add created_by tracking to users table and insert cashiers.manage permission

-- 1. Add created_by column if not exists
SET @dbname = DATABASE();
SET @tablename = "users";
SET @columnname = "created_by";
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      TABLE_SCHEMA = @dbname
      AND TABLE_NAME = @tablename
      AND COLUMN_NAME = @columnname
  ) > 0,
  "SELECT 1",
  "ALTER TABLE users ADD COLUMN created_by INT NULL AFTER event_id"
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- 2. Insert cashiers.manage permission
INSERT INTO permissions (code, name, module, description)
VALUES ('cashiers.manage', 'Manage Cashier Accounts', 'Cashier', 'Create and view scoped Cashier accounts and sales reports')
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  module = VALUES(module),
  description = VALUES(description);

-- 3. Grant cashiers.manage to SuperAdmin (role_id = 1)
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT 1, id FROM permissions WHERE code = 'cashiers.manage';

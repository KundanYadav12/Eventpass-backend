-- 018_add_is_complementary_to_billings.sql
-- Add is_complementary flag to billings table

SET @dbname = DATABASE();
SET @tablename = "billings";
SET @columnname = "is_complementary";
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      TABLE_SCHEMA = @dbname
      AND TABLE_NAME = @tablename
      AND COLUMN_NAME = @columnname
  ) > 0,
  "SELECT 1",
  "ALTER TABLE billings ADD COLUMN is_complementary TINYINT(1) NOT NULL DEFAULT 0 AFTER total_amount"
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

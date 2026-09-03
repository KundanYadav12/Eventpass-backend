-- ============================================================================
-- Migration 011: Add Non-Sequential Secure Download Tokens for Billings & Pass PDFs
-- ============================================================================

-- 1. Add download_token column to billings if not exists
SET @dbname = DATABASE();
SET @tablename = "billings";
SET @columnname = "download_token";
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      TABLE_SCHEMA = @dbname
      AND TABLE_NAME = @tablename
      AND COLUMN_NAME = @columnname
  ) > 0,
  "SELECT 1",
  "ALTER TABLE billings ADD COLUMN download_token VARCHAR(64) UNIQUE NULL AFTER bill_number"
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- 2. Backfill any existing billings with unique cryptographically random tokens
UPDATE billings
SET download_token = LOWER(CONCAT(HEX(RANDOM_BYTES(8)), LPAD(id, 4, '0')))
WHERE download_token IS NULL;

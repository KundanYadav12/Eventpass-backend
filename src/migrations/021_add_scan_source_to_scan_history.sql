-- 021_add_scan_source_to_scan_history.sql
-- Add scan_source to scan_history (camera / manual entry / external USB scanner)

SET @dbname = DATABASE();
SET @tablename = "scan_history";
SET @columnname = "scan_source";
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname) > 0,
  "SELECT 1",
  "ALTER TABLE scan_history ADD COLUMN scan_source VARCHAR(50) NOT NULL DEFAULT 'camera' AFTER ip_address, ADD INDEX idx_scan_source (scan_source)"
));
PREPARE stmt1 FROM @preparedStatement;
EXECUTE stmt1;
DEALLOCATE PREPARE stmt1;

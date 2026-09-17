-- Migration: 013_fraud_detections_schema.sql
-- Description: Create fraud_detections table for tracking cross-event mismatch and unregistered pass scans

CREATE TABLE IF NOT EXISTS fraud_detections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  event_id INT NULL,
  pass_id INT NULL,
  scanned_pass_code VARCHAR(100) NOT NULL,
  actual_pass_event_id INT NULL,
  scanner_user_id INT NULL,
  scanner_user_name VARCHAR(150) NULL,
  detection_type ENUM('WRONG_EVENT', 'PASS_NOT_FOUND') NOT NULL,
  reason VARCHAR(255) NOT NULL,
  device_id VARCHAR(50) DEFAULT 'GATE-01',
  ip_address VARCHAR(45) NULL,
  detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_fraud_event (event_id),
  INDEX idx_fraud_user (scanner_user_id),
  INDEX idx_fraud_detected_at (detected_at),
  INDEX idx_fraud_code (scanned_pass_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

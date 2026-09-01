-- =====================================================================
-- Migration 004: Dynamic Printer Settings, Gateway Queue & Venue Printers
-- =====================================================================

CREATE TABLE IF NOT EXISTS `printer_settings` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `event_id` INT NULL,
  `printer_name` VARCHAR(100) NOT NULL DEFAULT 'TSC TE244',
  `command_language` VARCHAR(20) NOT NULL DEFAULT 'TSPL',
  `stock_width_mm` INT NOT NULL DEFAULT 50,
  `stock_height_mm` INT NOT NULL DEFAULT 50,
  `dual_column` BOOLEAN NOT NULL DEFAULT TRUE,
  `gap_mm` DECIMAL(4,2) NOT NULL DEFAULT 3.00,
  `speed` INT NOT NULL DEFAULT 4,
  `density` INT NOT NULL DEFAULT 8,
  `direction` INT NOT NULL DEFAULT 1,
  `gateway_mode` BOOLEAN NOT NULL DEFAULT FALSE,
  `gateway_api_key` VARCHAR(100) NOT NULL DEFAULT 'eventgen_gateway_sec_key_9981',
  `last_gateway_heartbeat` DATETIME NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default printer settings if none exist
INSERT INTO `printer_settings` (`id`, `printer_name`, `command_language`, `stock_width_mm`, `stock_height_mm`, `gap_mm`, `speed`, `density`, `direction`, `gateway_api_key`)
SELECT 1, 'TSC TE244', 'TSPL', 50, 50, 3.00, 4, 8, 1, 'eventgen_gateway_sec_key_9981'
WHERE NOT EXISTS (SELECT 1 FROM `printer_settings` WHERE id = 1);

CREATE TABLE IF NOT EXISTS `venue_printers` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `gateway_device_id` VARCHAR(100) NOT NULL,
  `printer_name` VARCHAR(100) NOT NULL,
  `driver_name` VARCHAR(100) NULL,
  `port_name` VARCHAR(50) NULL,
  `status` VARCHAR(50) DEFAULT 'Normal',
  `is_default` BOOLEAN DEFAULT FALSE,
  `last_seen_at` DATETIME NOT NULL,
  UNIQUE KEY `idx_gw_printer` (`gateway_device_id`, `printer_name`),
  INDEX `idx_last_seen` (`last_seen_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `print_queue_jobs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `batch_id` INT NULL,
  `job_type` ENUM('batch_chunk', 'test_barcode', 'test_dummy', 'calibrate', 'unpause') NOT NULL,
  `printer_name` VARCHAR(100) NOT NULL,
  `command_language` VARCHAR(20) NOT NULL DEFAULT 'TSPL',
  `pass_ids` JSON NULL,
  `raw_payload` MEDIUMTEXT NOT NULL,
  `total_labels` INT NOT NULL DEFAULT 1,
  `status` ENUM('pending', 'processing', 'completed', 'failed', 'paused_out_of_stock') DEFAULT 'pending',
  `error_message` VARCHAR(255) NULL,
  `gateway_device_id` VARCHAR(100) NULL,
  `created_by` INT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `dispatched_at` DATETIME NULL,
  `completed_at` DATETIME NULL,
  INDEX `idx_job_status` (`status`),
  INDEX `idx_batch_id` (`batch_id`),
  FOREIGN KEY (`batch_id`) REFERENCES `print_batches`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

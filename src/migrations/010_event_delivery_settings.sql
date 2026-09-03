-- Migration 010: Event-Scoped Email and WhatsApp Delivery Settings
-- Secure, encrypted per-event SMTP & Messaging configurations

CREATE TABLE IF NOT EXISTS event_email_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  event_id INT NOT NULL UNIQUE,
  sender_name VARCHAR(150) NOT NULL DEFAULT 'Event Operations Team',
  sender_email VARCHAR(255) NOT NULL DEFAULT 'admin@eventgen.duckdns.org',
  smtp_host VARCHAR(255) NOT NULL DEFAULT 'smtp.gmail.com',
  smtp_port INT NOT NULL DEFAULT 587,
  smtp_secure TINYINT(1) NOT NULL DEFAULT 0,
  smtp_user VARCHAR(255) NULL,
  smtp_pass_encrypted TEXT NULL,
  smtp_pass_iv VARCHAR(64) NULL,
  smtp_pass_auth_tag VARCHAR(64) NULL,
  email_subject_template VARCHAR(255) NOT NULL DEFAULT '{{eventName}} — Official Pass Confirmation & Invoice',
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ees_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS event_whatsapp_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  event_id INT NOT NULL UNIQUE,
  provider VARCHAR(50) NOT NULL DEFAULT 'WHATSAPP_LINK',
  phone_number_id VARCHAR(100) NULL,
  access_token_encrypted TEXT NULL,
  access_token_iv VARCHAR(64) NULL,
  access_token_auth_tag VARCHAR(64) NULL,
  custom_message_template TEXT NULL,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ews_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS delivery_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  event_id INT NOT NULL,
  billing_id INT NULL,
  channel ENUM('EMAIL', 'WHATSAPP') NOT NULL,
  recipient VARCHAR(255) NOT NULL,
  status ENUM('SUCCESS', 'FAILED', 'PENDING', 'SIMULATED') NOT NULL DEFAULT 'PENDING',
  message_id VARCHAR(255) NULL,
  error_message TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_dl_event (event_id),
  INDEX idx_dl_billing (billing_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed default initial delivery configurations for Event 1 and Event 2
INSERT IGNORE INTO event_email_settings (event_id, sender_name, sender_email, smtp_host, smtp_port, smtp_secure, email_subject_template, is_enabled)
SELECT id, CONCAT(event_name, ' Team'), 'admin@eventgen.duckdns.org', 'smtp.gmail.com', 587, 0, CONCAT(event_name, ' — Your Official Passes & Invoice'), 1
FROM events;

INSERT IGNORE INTO event_whatsapp_settings (event_id, provider, custom_message_template, is_enabled)
SELECT id, 'WHATSAPP_LINK', 'Hello *{customerName}*! 🎉 Your passes for *{eventName}* are confirmed.\n\n*Pass Codes:* {passCodes}\n*Total:* ₹{totalAmount}\n\nDownload Pass PDF: {passPdfUrl}\nDownload Bill Invoice: {billPdfUrl}', 1
FROM events;

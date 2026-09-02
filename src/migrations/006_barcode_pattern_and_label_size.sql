-- Migration 006: Add barcode_pattern and update sticker dimensions to 38mm x 50mm

-- Add barcode_pattern to print_batches if not exists
ALTER TABLE print_batches
  ADD COLUMN barcode_pattern VARCHAR(30) NOT NULL DEFAULT 'QR_CODE' AFTER pass_type;

-- Update existing printer_settings to 38mm x 50mm stock
UPDATE printer_settings
SET stock_width_mm = 38, stock_height_mm = 50
WHERE id = 1;

-- Update events default sticker size
UPDATE events
SET sticker_width_mm = 38, sticker_height_mm = 50;

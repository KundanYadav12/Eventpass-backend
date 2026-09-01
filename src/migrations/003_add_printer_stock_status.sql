-- =====================================================================
-- Migration 003: Expand Print Batches Status for Printer Out-of-Stock/Ribbon Errors
-- =====================================================================

ALTER TABLE `print_batches` 
  MODIFY COLUMN `status` ENUM('created', 'printing', 'paused', 'paused_out_of_stock', 'completed', 'cancelled') DEFAULT 'created';

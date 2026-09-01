/**
 * Print Gateway Service
 * 
 * Manages the Cloud-to-Local Print Queue bridge:
 * - Queues print jobs when in Gateway Mode or when target printer is connected to remote gateway
 * - Provides pending jobs polling for the Local Windows Gateway daemon
 * - Updates job completion / failure status with audit logs
 */

const { query } = require('../config/db');
const { logAudit } = require('./AuditService');
const { getSettings } = require('./PrinterConfigService');

/**
 * Enqueue a print job for Local Gateway execution
 */
async function enqueueJob({
  batchId = null,
  jobType = 'batch_chunk',
  printerName = 'TSC TE244',
  commandLanguage = 'TSPL',
  passIds = [],
  rawPayload = '',
  totalLabels = 1,
  userId = null
}) {
  const result = await query(
    `INSERT INTO print_queue_jobs 
      (batch_id, job_type, printer_name, command_language, pass_ids, raw_payload, total_labels, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NOW())`,
    [
      batchId,
      jobType,
      printerName,
      commandLanguage,
      JSON.stringify(passIds),
      rawPayload,
      totalLabels,
      userId
    ]
  );

  return {
    jobId: result.insertId,
    status: 'pending',
    printerName,
    commandLanguage,
    totalLabels
  };
}

/**
 * Poll for pending jobs (called by Local Windows Print Gateway)
 */
async function getPendingJobsForGateway(gatewayDeviceId, limit = 5) {
  // Claim pending jobs atomically
  const jobs = await query(
    `SELECT id, batch_id, job_type, printer_name, command_language, pass_ids, raw_payload, total_labels, created_at
     FROM print_queue_jobs
     WHERE status = 'pending'
     ORDER BY id ASC
     LIMIT ?`,
    [limit]
  );

  if (jobs && jobs.length > 0) {
    const jobIds = jobs.map(j => j.id);
    await query(
      `UPDATE print_queue_jobs 
       SET status = 'processing', gateway_device_id = ?, dispatched_at = NOW() 
       WHERE id IN (?)`,
      [gatewayDeviceId, jobIds]
    );
  }

  return jobs;
}

/**
 * Update job execution status from Gateway report
 */
async function updateJobStatus(jobId, { status, errorMessage = null, gatewayDeviceId = null }) {
  const validStatuses = ['completed', 'failed', 'paused_out_of_stock'];
  const targetStatus = validStatuses.includes(status) ? status : 'completed';

  await query(
    `UPDATE print_queue_jobs 
     SET status = ?, error_message = ?, completed_at = NOW(), gateway_device_id = COALESCE(?, gateway_device_id)
     WHERE id = ?`,
    [targetStatus, errorMessage, gatewayDeviceId, jobId]
  );

  // If this was a batch chunk and completed, update passes printed status
  const jobRows = await query('SELECT * FROM print_queue_jobs WHERE id = ?', [jobId]);
  if (jobRows.length > 0) {
    const job = jobRows[0];
    if (job.batch_id && targetStatus === 'completed' && job.pass_ids) {
      const passIds = typeof job.pass_ids === 'string' ? JSON.parse(job.pass_ids) : job.pass_ids;
      if (Array.isArray(passIds) && passIds.length > 0) {
        await query(
          'UPDATE passes SET printed = 1, updated_at = NOW() WHERE id IN (?)',
          [passIds]
        );
        await query(
          'UPDATE print_batches SET printed_passes = printed_passes + ?, updated_at = NOW() WHERE id = ?',
          [passIds.length, job.batch_id]
        );
      }
    }
  }

  return { success: true, jobId, status: targetStatus };
}

/**
 * Validate Gateway API Key
 */
async function authenticateGatewayKey(apiKey) {
  if (!apiKey) return false;
  const settings = await getSettings();
  return settings.gateway_api_key && settings.gateway_api_key === apiKey;
}

module.exports = {
  enqueueJob,
  getPendingJobsForGateway,
  updateJobStatus,
  authenticateGatewayKey
};

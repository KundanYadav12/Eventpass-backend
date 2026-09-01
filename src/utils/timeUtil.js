/**
 * Time utility for calculating server-side scan cycles with 1:00 AM day boundary
 */

/**
 * Returns the effective scan cycle day key (YYYY-MM-DD) based on 1:00 AM reset boundary.
 * Event day starts at 01:00:00 and ends at 00:59:59 next calendar day.
 * @param {Date|string} dateInput 
 * @returns {string} e.g. "2026-10-02"
 */
function getScanCycleKey(dateInput = new Date()) {
  let d;
  if (typeof dateInput === 'string') {
    if (dateInput.includes(' ') && !dateInput.includes('T')) {
      d = new Date(dateInput.replace(' ', 'T') + 'Z');
    } else {
      d = new Date(dateInput);
    }
  } else if (dateInput instanceof Date) {
    d = new Date(dateInput.getTime());
  } else {
    d = new Date();
  }

  // Adjust for 1 hour offset (subtract 1 hour: 1:00 AM -> 0:00 AM)
  const adjusted = new Date(d.getTime() - 60 * 60 * 1000);
  
  // Use UTC methods for consistent date arithmetic across timezones
  const year = adjusted.getUTCFullYear();
  const month = String(adjusted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(adjusted.getUTCDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

/**
 * Formats a Date object to MySQL DATETIME format (YYYY-MM-DD HH:mm:ss)
 * @param {Date|string} dateInput 
 * @returns {string}
 */
function formatMySqlDateTime(dateInput = new Date()) {
  const d = new Date(dateInput);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Checks if a given date is within a valid range [validFrom, validUntil]
 * @param {Date|string} date 
 * @param {Date|string} validFrom 
 * @param {Date|string} validUntil 
 * @returns {'valid' | 'future' | 'expired'}
 */
function checkValidityWindow(date, validFrom, validUntil) {
  const checkTime = new Date(date).getTime();
  const fromTime = new Date(validFrom).getTime();
  const untilTime = new Date(validUntil).getTime();

  if (checkTime > untilTime) return 'expired';
  if (checkTime < fromTime) return 'future';
  return 'valid';
}

module.exports = {
  getScanCycleKey,
  formatMySqlDateTime,
  checkValidityWindow
};

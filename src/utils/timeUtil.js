/**
 * Time and Timezone Utility for EventGen
 * 
 * Standardized on Indian Standard Time (IST - Asia/Kolkata, UTC+5:30)
 * All database timestamps remain UTC, while all display formatting and cycle calculations
 * are strictly performed in IST.
 */

const IST_TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5 hours 30 mins in ms

/**
 * Convert an IST date input (string or Date) to UTC Date object.
 * If input already has a timezone indicator (Z or +/-offset), it parses it directly.
 * If input is a local IST string (e.g. "2026-09-02T10:00" or "2026-09-02 10:00:00"),
 * it interprets it as IST and shifts it to UTC.
 */
function istToUTC(dateInput) {
  if (!dateInput) return null;
  if (dateInput instanceof Date) return new Date(dateInput.getTime());

  if (typeof dateInput === 'string') {
    const trimmed = dateInput.trim();
    if (!trimmed) return null;

    // Has explicit timezone indicator (e.g. 'Z', '+05:30')
    if (/[Zz]|[+-]\d{2}:\d{2}$/.test(trimmed)) {
      return new Date(trimmed);
    }

    // Match YYYY-MM-DDTHH:mm, YYYY-MM-DD HH:mm:ss, etc.
    const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (match) {
      const year = parseInt(match[1], 10);
      const month = parseInt(match[2], 10) - 1;
      const day = parseInt(match[3], 10);
      const hour = parseInt(match[4] || '0', 10);
      const minute = parseInt(match[5] || '0', 10);
      const second = parseInt(match[6] || '0', 10);

      const utcMs = Date.UTC(year, month, day, hour, minute, second) - IST_OFFSET_MS;
      return new Date(utcMs);
    }
  }

  return new Date(dateInput);
}

/**
 * Convert any Date, timestamp, or MySQL datetime string into a JavaScript Date object in UTC
 */
function parseDate(dateInput) {
  if (!dateInput) return new Date();
  if (dateInput instanceof Date) return new Date(dateInput.getTime());
  
  if (typeof dateInput === 'string') {
    // If format is 'YYYY-MM-DD HH:mm:ss' (MySQL default string without timezone indicator, which is stored in UTC)
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateInput)) {
      return new Date(dateInput.replace(' ', 'T') + 'Z');
    }
    return new Date(dateInput);
  }
  return new Date(dateInput);
}

/**
 * Get date/time components explicitly in IST (Asia/Kolkata)
 */
function getISTComponents(dateInput = new Date()) {
  const d = parseDate(dateInput);
  
  // Format using Intl to guarantee precise timezone mapping
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: IST_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false
  });
  
  const parts = formatter.formatToParts(d);
  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      map[p.type] = parseInt(p.value, 10);
    }
  }
  
  return {
    year: map.year,
    month: map.month, // 1-12
    day: map.day,
    hour: map.hour === 24 ? 0 : map.hour,
    minute: map.minute,
    second: map.second
  };
}

/**
 * Format a Date to IST Date & Time string (e.g. "2 Oct 2026, 08:30 PM IST")
 */
function formatDateTimeIST(dateInput) {
  if (!dateInput) return '—';
  const d = parseDate(dateInput);
  const formatted = d.toLocaleString('en-GB', {
    timeZone: IST_TIMEZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
  // Normalize am/pm to AM/PM
  return formatted.replace(/\b(am|pm)\b/gi, (m) => m.toUpperCase()) + ' IST';
}

/**
 * Format a Date to IST Date only string (e.g. "2 Oct 2026")
 */
function formatDateIST(dateInput) {
  if (!dateInput) return '—';
  const d = parseDate(dateInput);
  return d.toLocaleDateString('en-GB', {
    timeZone: IST_TIMEZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

/**
 * Format a time string or Date into 12-hour clock time (e.g. "01:00" -> "01:00 AM", "14:30" -> "02:30 PM")
 */
function formatTimeIST(timeInput) {
  if (!timeInput) return '01:00 AM';
  
  if (typeof timeInput === 'string' && timeInput.includes(':') && timeInput.length <= 8) {
    const [hStr, mStr] = timeInput.split(':');
    let h = parseInt(hStr, 10);
    const m = parseInt(mStr || '0', 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    h = h ? h : 12; // 0 becomes 12
    const hFormatted = String(h).padStart(2, '0');
    const mFormatted = String(m).padStart(2, '0');
    return `${hFormatted}:${mFormatted} ${ampm}`;
  }
  
  const d = parseDate(timeInput);
  const formatted = d.toLocaleTimeString('en-US', {
    timeZone: IST_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
  return formatted.replace(/\b(am|pm)\b/gi, (m) => m.toUpperCase());
}

/**
 * Check if a date is within a validity window [validFrom, validUntil]
 */
function checkValidityWindow(dateInput, validFrom, validUntil) {
  const checkTime = parseDate(dateInput).getTime();
  const fromTime = parseDate(validFrom).getTime();
  const untilTime = parseDate(validUntil).getTime();

  if (checkTime > untilTime) return 'expired';
  if (checkTime < fromTime) return 'future';
  return 'valid';
}

/**
 * Calculate dynamic renewal cycle for Mode B (Renewable) pass categories in IST
 * 
 * @param {Date|string} scanTimeInput - The current scan timestamp
 * @param {string} renewalTimeStr - Clock time in IST (e.g. "01:00", "06:00")
 * @param {Date|string} activeFrom - Renewal active from timestamp
 * @param {Date|string} activeUntil - Renewal active until timestamp
 * @returns {Object} { status: 'valid'|'future'|'expired', cycleStart: Date, nextUnlock: Date, renewalTimeFormatted: string }
 */
function calculateRenewalCycle(scanTimeInput = new Date(), renewalTimeStr = '01:00', activeFrom = null, activeUntil = null) {
  const scanTime = parseDate(scanTimeInput);
  
  // 1. Check if scan time is within renewal active window
  if (activeFrom && activeUntil) {
    const validity = checkValidityWindow(scanTime, activeFrom, activeUntil);
    if (validity !== 'valid') {
      return {
        status: validity,
        activeFromIST: formatDateTimeIST(activeFrom),
        activeUntilIST: formatDateTimeIST(activeUntil),
        activeWindowFormatted: `${formatDateIST(activeFrom)} – ${formatDateIST(activeUntil)}`
      };
    }
  }

  // 2. Parse configured renewal time (e.g. "01:00" -> hour 1, minute 0)
  let renHour = 1;
  let renMin = 0;
  if (renewalTimeStr && renewalTimeStr.includes(':')) {
    const parts = renewalTimeStr.split(':');
    renHour = parseInt(parts[0], 10) || 0;
    renMin = parseInt(parts[1], 10) || 0;
  }

  // 3. Extract IST date components of the current scan
  const ist = getISTComponents(scanTime);
  
  // Create Date object representing today's renewal threshold in UTC
  // Today's renewal threshold in IST occurs at year-month-day renHour:renMin IST (which is UTC - 5:30)
  const todayThresholdUtcMs = Date.UTC(ist.year, ist.month - 1, ist.day, renHour, renMin, 0) - IST_OFFSET_MS;
  const scanTimeUtcMs = scanTime.getTime();

  let cycleStartUtcMs;
  let nextUnlockUtcMs;

  if (scanTimeUtcMs < todayThresholdUtcMs) {
    // Current scan is BEFORE today's renewal time (e.g. 00:30 before 01:00)
    // The active cycle started YESTERDAY at renewal time, and unlocks TODAY at renewal time
    cycleStartUtcMs = todayThresholdUtcMs - (24 * 60 * 60 * 1000);
    nextUnlockUtcMs = todayThresholdUtcMs;
  } else {
    // Current scan is ON or AFTER today's renewal time (e.g. 02:00 after 01:00)
    // The active cycle started TODAY at renewal time, and unlocks TOMORROW at renewal time
    cycleStartUtcMs = todayThresholdUtcMs;
    nextUnlockUtcMs = todayThresholdUtcMs + (24 * 60 * 60 * 1000);
  }

  const cycleStart = new Date(cycleStartUtcMs);
  const nextUnlock = new Date(nextUnlockUtcMs);

  return {
    status: 'valid',
    cycleStart,
    nextUnlock,
    renewalTimeFormatted: formatTimeIST(renewalTimeStr),
    nextUnlockFormatted: formatDateTimeIST(nextUnlock),
    nextUnlockTimeFormatted: formatTimeIST(nextUnlock),
    activeFromIST: activeFrom ? formatDateTimeIST(activeFrom) : null,
    activeUntilIST: activeUntil ? formatDateTimeIST(activeUntil) : null,
    activeWindowFormatted: (activeFrom && activeUntil) ? `${formatDateIST(activeFrom)} – ${formatDateIST(activeUntil)}` : null
  };
}

/**
 * Check whether a pass has already been scanned within the current active renewal cycle
 * 
 * @param {Date|string} lastScannedAt - Timestamp of the last scan
 * @param {Date} cycleStart - Start threshold Date of the current cycle
 * @returns {boolean}
 */
function hasScannedInCurrentCycle(lastScannedAt, cycleStart) {
  if (!lastScannedAt) return false;
  const lastScanMs = parseDate(lastScannedAt).getTime();
  const cycleStartMs = cycleStart.getTime();
  return lastScanMs >= cycleStartMs;
}

/**
 * Formats a Date object or IST input string to MySQL DATETIME format in UTC (YYYY-MM-DD HH:mm:ss)
 */
function formatMySqlDateTime(dateInput = new Date()) {
  if (!dateInput) return null;
  const d = (dateInput instanceof Date) ? dateInput : istToUTC(dateInput);
  if (!d || isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

module.exports = {
  IST_TIMEZONE,
  istToUTC,
  parseDate,
  getISTComponents,
  formatDateTimeIST,
  formatDateIST,
  formatTimeIST,
  checkValidityWindow,
  calculateRenewalCycle,
  hasScannedInCurrentCycle,
  formatMySqlDateTime
};

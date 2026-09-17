/**
 * Time and Timezone Utility for EventGen
 * 
 * Standardized on Indian Standard Time (IST - Asia/Kolkata, UTC+5:30)
 * All database timestamps remain stored in UTC / standard format, while all display formatting,
 * range filtering, and cycle calculations are strictly performed in IST.
 */

const IST_TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5 hours 30 mins in ms

/**
 * Convert an IST date input (string or Date) to UTC Date object.
 * If input already has a timezone indicator (Z or +/-offset), it parses it directly.
 * If input is a local IST string (e.g. "2026-09-02T10:00" or "2026-09-02 10:00:00" or "2026-09-02"),
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

    // Match YYYY-MM-DDTHH:mm, YYYY-MM-DD HH:mm:ss, YYYY-MM-DD, etc.
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
    const trimmed = dateInput.trim();
    // If format is 'YYYY-MM-DD HH:mm:ss' (MySQL default string without timezone indicator, stored in UTC)
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
      return new Date(trimmed.replace(' ', 'T') + 'Z');
    }
    return new Date(trimmed);
  }
  return new Date(dateInput);
}

/**
 * Get date/time components explicitly in IST (Asia/Kolkata)
 */
function getISTComponents(dateInput = new Date()) {
  const d = parseDate(dateInput);
  
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
 * Get IST calendar day boundary in UTC MySQL formatted string
 * For example, if IST date is "2026-09-05", 
 * start is 2026-09-05 00:00:00 IST -> 2026-09-04 18:30:00 UTC
 * end is 2026-09-05 23:59:59 IST -> 2026-09-05 18:29:59 UTC
 */
function getISTDayBoundsUTC(dateStr = null) {
  let year, month, day;
  
  if (dateStr) {
    const cleanStr = String(dateStr).trim().slice(0, 10);
    const parts = cleanStr.split('-');
    year = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    day = parseInt(parts[2], 10);
  } else {
    const ist = getISTComponents(new Date());
    year = ist.year;
    month = ist.month;
    day = ist.day;
  }

  const startUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0) - IST_OFFSET_MS;
  const endUtcMs = Date.UTC(year, month - 1, day, 23, 59, 59) - IST_OFFSET_MS;

  const startDate = new Date(startUtcMs);
  const endDate = new Date(endUtcMs);

  return {
    startUtc: formatMySqlDateTime(startDate),
    endUtc: formatMySqlDateTime(endDate),
    startDate,
    endDate
  };
}

/**
 * Convert arbitrary IST date range strings (dateFrom, dateTo) to UTC SQL string boundaries
 */
function getISTDateRangeBoundsUTC(dateFrom = null, dateTo = null) {
  let startUtc = null;
  let endUtc = null;

  if (dateFrom) {
    const cleanFrom = String(dateFrom).trim().slice(0, 10);
    const [y, m, d] = cleanFrom.split('-').map(Number);
    if (y && m && d) {
      const utcMs = Date.UTC(y, m - 1, d, 0, 0, 0) - IST_OFFSET_MS;
      startUtc = formatMySqlDateTime(new Date(utcMs));
    }
  }

  if (dateTo) {
    const cleanTo = String(dateTo).trim().slice(0, 10);
    const [y, m, d] = cleanTo.split('-').map(Number);
    if (y && m && d) {
      const utcMs = Date.UTC(y, m - 1, d, 23, 59, 59) - IST_OFFSET_MS;
      endUtc = formatMySqlDateTime(new Date(utcMs));
    }
  }

  return { startUtc, endUtc };
}

/**
 * Get UTC range bounds for quick IST date range presets
 * Presets: 'today', 'yesterday', 'last_7_days', 'last_30_days', 'this_month', 'previous_month'
 */
function getISTPresetRangeUTC(preset = 'today', customFrom = null, customTo = null) {
  const istNow = getISTComponents(new Date());
  const nowMs = new Date().getTime();

  if (preset === 'today') {
    return getISTDayBoundsUTC();
  }

  if (preset === 'yesterday') {
    const yesterdayDate = new Date(nowMs - 24 * 60 * 60 * 1000);
    const istYest = getISTComponents(yesterdayDate);
    const yestStr = `${istYest.year}-${String(istYest.month).padStart(2, '0')}-${String(istYest.day).padStart(2, '0')}`;
    return getISTDayBoundsUTC(yestStr);
  }

  if (preset === 'last_7_days') {
    const startMs = Date.UTC(istNow.year, istNow.month - 1, istNow.day, 0, 0, 0) - (6 * 24 * 60 * 60 * 1000) - IST_OFFSET_MS;
    const endMs = Date.UTC(istNow.year, istNow.month - 1, istNow.day, 23, 59, 59) - IST_OFFSET_MS;
    return {
      startUtc: formatMySqlDateTime(new Date(startMs)),
      endUtc: formatMySqlDateTime(new Date(endMs))
    };
  }

  if (preset === 'last_30_days') {
    const startMs = Date.UTC(istNow.year, istNow.month - 1, istNow.day, 0, 0, 0) - (29 * 24 * 60 * 60 * 1000) - IST_OFFSET_MS;
    const endMs = Date.UTC(istNow.year, istNow.month - 1, istNow.day, 23, 59, 59) - IST_OFFSET_MS;
    return {
      startUtc: formatMySqlDateTime(new Date(startMs)),
      endUtc: formatMySqlDateTime(new Date(endMs))
    };
  }

  if (preset === 'this_month') {
    const startMs = Date.UTC(istNow.year, istNow.month - 1, 1, 0, 0, 0) - IST_OFFSET_MS;
    const endMs = Date.UTC(istNow.year, istNow.month - 1, istNow.day, 23, 59, 59) - IST_OFFSET_MS;
    return {
      startUtc: formatMySqlDateTime(new Date(startMs)),
      endUtc: formatMySqlDateTime(new Date(endMs))
    };
  }

  if (preset === 'previous_month') {
    const prevYear = istNow.month === 1 ? istNow.year - 1 : istNow.year;
    const prevMonth = istNow.month === 1 ? 12 : istNow.month - 1;
    const lastDay = new Date(prevYear, prevMonth, 0).getDate();
    const startMs = Date.UTC(prevYear, prevMonth - 1, 1, 0, 0, 0) - IST_OFFSET_MS;
    const endMs = Date.UTC(prevYear, prevMonth - 1, lastDay, 23, 59, 59) - IST_OFFSET_MS;
    return {
      startUtc: formatMySqlDateTime(new Date(startMs)),
      endUtc: formatMySqlDateTime(new Date(endMs))
    };
  }

  // Custom range
  return getISTDateRangeBoundsUTC(customFrom, customTo);
}

/**
 * Format a Date to IST Date & Time string (e.g. "04 Sep 2026, 10:50 PM")
 */
function formatDateTimeIST(dateInput) {
  if (!dateInput) return '—';
  const d = parseDate(dateInput);
  if (!d || isNaN(d.getTime())) return '—';
  const formatted = d.toLocaleString('en-GB', {
    timeZone: IST_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
  return formatted.replace(/\b(am|pm)\b/gi, (m) => m.toLowerCase());
}

/**
 * Format a Date to IST Date only string (e.g. "04 Sep 2026")
 */
function formatDateIST(dateInput) {
  if (!dateInput) return '—';
  const d = parseDate(dateInput);
  if (!d || isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', {
    timeZone: IST_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

/**
 * Format a time string or Date into 12-hour clock time (e.g. "10:50 PM")
 */
function formatTimeIST(timeInput) {
  if (!timeInput) return '—';
  
  if (typeof timeInput === 'string' && timeInput.includes(':') && timeInput.length <= 8) {
    const [hStr, mStr] = timeInput.split(':');
    let h = parseInt(hStr, 10);
    const m = parseInt(mStr || '0', 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    h = h ? h : 12;
    const hFormatted = String(h).padStart(2, '0');
    const mFormatted = String(m).padStart(2, '0');
    return `${hFormatted}:${mFormatted} ${ampm}`;
  }
  
  const d = parseDate(timeInput);
  if (!d || isNaN(d.getTime())) return '—';
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
  
  const todayThresholdUtcMs = Date.UTC(ist.year, ist.month - 1, ist.day, renHour, renMin, 0) - IST_OFFSET_MS;
  const scanTimeUtcMs = scanTime.getTime();

  let cycleStartUtcMs;
  let nextUnlockUtcMs;

  if (scanTimeUtcMs < todayThresholdUtcMs) {
    cycleStartUtcMs = todayThresholdUtcMs - (24 * 60 * 60 * 1000);
    nextUnlockUtcMs = todayThresholdUtcMs;
  } else {
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

/**
 * Convert any Date, timestamp, or MySQL datetime string to ISO-8601 UTC string (e.g. "2026-09-17T03:45:00.000Z")
 */
function toIsoUtcString(dateInput) {
  if (!dateInput) return null;
  const d = parseDate(dateInput);
  if (!d || isNaN(d.getTime())) return null;
  return d.toISOString();
}

module.exports = {
  IST_TIMEZONE,
  IST_OFFSET_MS,
  istToUTC,
  parseDate,
  getISTComponents,
  getISTDayBoundsUTC,
  getISTDateRangeBoundsUTC,
  getISTPresetRangeUTC,
  formatDateTimeIST,
  formatDateIST,
  formatTimeIST,
  checkValidityWindow,
  calculateRenewalCycle,
  hasScannedInCurrentCycle,
  formatMySqlDateTime,
  toIsoUtcString
};

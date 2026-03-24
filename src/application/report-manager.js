/**
 * Application-layer CRUD operations for extraction reports. Owns validation,
 * sanitisation, and the mapping between IDB's split-store format (meta + elements)
 * and the full report shape callers expect. Runs in the MV3 service worker.
 * Failure mode contained here: all IDB errors are caught and returned as
 * {success:false} or [] — this module never throws to its callers.
 * Callers: background.js, compare-workflow.js, export-workflow.js, import-workflow.js.
 */
import storage from '../infrastructure/idb-repository.js';
import logger from '../infrastructure/logger.js';

/** Returns true only for non-empty strings that parse to a valid Date. */
function isValidTimestamp(timestamp) {
  if (typeof timestamp !== 'string') {return false;}
  return !isNaN(new Date(timestamp).getTime());
}

/**
 * Validates a full report object including its elements array.
 * Used at save time — not at list-load time, where only metadata fields are present.
 * @returns {{valid: boolean, errors: string[]}}
 */
function isValidReport(report) {
  if (!report || typeof report !== 'object') {
    return { valid: false, errors: ['Report must be an object'] };
  }

  const errors = [];

  if (!report.id || typeof report.id !== 'string') {
    errors.push('Missing or invalid report ID');
  }
  if (!report.version || typeof report.version !== 'string') {
    errors.push('Missing or invalid version');
  }
  if (!report.url || typeof report.url !== 'string') {
    errors.push('Missing or invalid URL');
  }
  if (!report.timestamp || !isValidTimestamp(report.timestamp)) {
    errors.push('Missing or invalid timestamp');
  }
  if (typeof report.totalElements !== 'number' || report.totalElements < 0) {
    errors.push('Invalid totalElements count');
  }
  if (!Array.isArray(report.elements)) {
    errors.push('Elements must be an array');
  }
  if (report.elements && report.elements.length !== report.totalElements) {
    errors.push(`Element count mismatch: expected ${report.totalElements}, got ${report.elements.length}`);
  }

  if (errors.length > 0) {
    logger.warn('Report validation failed', { errors, reportId: report.id });
    return { valid: false, errors };
  }

  return { valid: true, errors: [] };
}

/**
 * Validates report metadata fields only — no elements check. Used when reading the
 * report list from IDB, where elements are stored in a separate store and are not
 * present in the metadata record.
 * @returns {{valid: boolean, errors: string[]}}
 */
function isValidMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return { valid: false, errors: ['Meta must be an object'] };
  }

  const errors = [];

  if (!meta.id || typeof meta.id !== 'string') {
    errors.push('Missing or invalid report ID');
  }
  if (!meta.url || typeof meta.url !== 'string') {
    errors.push('Missing or invalid URL');
  }
  if (!meta.timestamp || !isValidTimestamp(meta.timestamp)) {
    errors.push('Missing or invalid timestamp');
  }
  if (typeof meta.totalElements !== 'number' || meta.totalElements < 0) {
    errors.push('Invalid totalElements count');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Type-coerces all report fields to their expected types before IDB storage.
 * A missing id falls back to a timestamp string rather than throwing — this is
 * intentional for imported reports that may not carry an original ID.
 * Always called after isValidReport passes, not before.
 */
function sanitizeReport(report) {
  return {
    id:            String(report.id || Date.now()),
    version:       String(report.version || '1.0'),
    url:           String(report.url || ''),
    title:         String(report.title || 'Untitled'),
    timestamp:     report.timestamp || new Date().toISOString(),
    totalElements: Number(report.totalElements || 0),
    duration:      Number(report.duration || 0),
    filters:       report.filters || null,
    source:        report.source  ?? null,
    elements:      Array.isArray(report.elements) ? report.elements : []
  };
}

/**
 * Returns all valid report metadata records, sorted newest-first. Corrupt records
 * are silently filtered out with a warning log rather than failing the whole load.
 * The client-side sort is defensive — IDB returns newest-first via the index, but
 * this guards against any edge case where that ordering drifts.
 * @returns {Promise<Object[]>} Empty array on IDB error.
 */
async function loadAllReports() {
  try {
    const reports = await storage.loadReports();
    logger.debug('Loaded report metadata', { count: reports.length });

    return reports
      .filter(report => {
        const v = isValidMeta(report);
        if (!v.valid) {
          logger.warn('Invalid report metadata', { id: report.id, errors: v.errors });
        }
        return v.valid;
      })
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  } catch (err) {
    logger.error('Failed to load reports', { error: err.message });
    return [];
  }
}

/**
 * Validates, sanitises, and persists a report. Validation runs against the raw
 * input before sanitisation so malformed data is rejected rather than silently coerced.
 * @returns {Promise<{success: boolean, id?: string, error?: string}>}
 */
async function saveReport(report) {
  try {
    const validation = isValidReport(report);
    if (!validation.valid) {
      logger.error('Cannot save invalid report', { errors: validation.errors });
      return { success: false, error: 'Invalid report structure' };
    }
    const sanitized = sanitizeReport(report);
    const result    = await storage.saveReport(sanitized);
    if (result.success) {
      logger.info('Report saved', { id: sanitized.id, totalElements: sanitized.totalElements });
    } else {
      logger.error('Failed to save report', { error: result.error });
    }
    return result;
  } catch (err) {
    logger.error('Save report error', { error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Deletes a report and all comparisons referencing it via the IDB atomic delete.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteReport(reportId) {
  try {
    const result = await storage.deleteReport(reportId);
    if (result.success) {
      logger.info('Report deleted', { id: reportId });
    } else {
      logger.error('Failed to delete report', { id: reportId, error: result.error });
    }
    return result;
  } catch (err) {
    logger.error('Delete report error', { error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Loads a full report (metadata + elements) by ID. Loads the full report list first
 * and linear-searches for the ID — O(n) on the number of reports. This is acceptable
 * given the MAX_COMPARISONS cap of 20, but callers in hot paths should cache the result.
 * @returns {Promise<Object|null>} Null if not found or on IDB error.
 */
async function getReportById(reportId) {
  try {
    const reports = await storage.loadReports();
    const meta    = reports.find(r => r.id === reportId);
    if (!meta) { return null; }
    const elements = await storage.loadReportElements(reportId);
    return { ...meta, elements };
  } catch (err) {
    logger.error('Failed to get report', { id: reportId, error: err.message });
    return null;
  }
}

/**
 * Deletes all reports and their associated data in one atomic IDB transaction.
 * Loads the report count first so it can be included in the success response.
 * @returns {Promise<{success: boolean, count?: number, error?: string}>}
 */
async function deleteAllReports() {
  try {
    const reports = await storage.loadReports();
    const count   = reports.length;
    const result  = await storage.deleteAllReports();
    if (!result.success) { return result; }
    logger.info('All reports deleted', { count });
    return { success: true, count };
  } catch (err) {
    logger.error('Failed to delete all reports', { error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Filters reports by a query string matched against title and URL (case-insensitive)
 * and ID (case-sensitive — UUIDs are not normalised). Loads all reports into memory;
 * no IDB index is used.
 * @returns {Promise<Object[]>} Empty array on error.
 */
async function searchReports(query) {
  try {
    const reports = await loadAllReports();
    const q       = query.toLowerCase();
    return reports.filter(r =>
      (r.title || '').toLowerCase().includes(q) ||
      (r.url   || '').toLowerCase().includes(q) ||
      r.id.includes(query)
    );
  } catch (err) {
    logger.error('Search reports failed', { error: err.message });
    return [];
  }
}

/**
 * Returns a snapshot of storage usage: report count, total and average element counts,
 * and IDB quota figures from checkQuota(). The quota field falls back to a zero-value
 * object when checkQuota() returns null (API unavailable or error).
 * @returns {Promise<{reportsCount, totalElements, avgElements, quota}|null>} Null on error.
 */
async function getStorageStats() {
  try {
    const quota         = await storage.checkQuota();
    const reports       = await storage.loadReports();
    const totalElements = reports.reduce((sum, r) => sum + (r.totalElements || 0), 0);
    const avgElements   = reports.length > 0 ? Math.round(totalElements / reports.length) : 0;
    return {
      reportsCount: reports.length,
      totalElements,
      avgElements,
      quota: quota || { bytesInUse: 0, quota: 0, percentUsed: 0, available: 0 }
    };
  } catch (err) {
    logger.error('Failed to get storage stats', { error: err.message });
    return null;
  }
}

export {
  deleteAllReports,
  deleteReport,
  getReportById,
  getStorageStats,
  isValidReport,
  loadAllReports,
  saveReport,
  searchReports
};

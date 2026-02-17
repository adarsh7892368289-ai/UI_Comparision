import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/storage.js';
import { isValidReport, sanitizeReport } from '../shared/report-validator.js';

// ─── REPORT CRUD ────────────────────────────────────────────────────────────

async function loadAllReports() {
  try {
    const reports = await storage.loadReports();
    logger.debug('Loaded reports', { count: reports.length });

    const validReports = reports.filter(report => {
      const validation = isValidReport(report);
      if (!validation.valid) {
        logger.warn('Invalid report detected', { id: report.id, errors: validation.errors });
        return false;
      }
      return true;
    });

    return validReports.sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  } catch (error) {
    logger.error('Failed to load reports', { error: error.message });
    return [];
  }
}

async function saveReport(report) {
  try {
    const validation = isValidReport(report);
    if (!validation.valid) {
      logger.error('Cannot save invalid report', { errors: validation.errors });
      return { success: false, error: 'Invalid report structure' };
    }
    const sanitized = sanitizeReport(report);
    const result = await storage.saveReport(sanitized);
    if (result.success) {
      logger.info('Report saved', { id: sanitized.id, totalElements: sanitized.totalElements });
    } else {
      logger.error('Failed to save report', { error: result.error });
    }
    return result;
  } catch (error) {
    logger.error('Save report error', { error: error.message });
    return { success: false, error: error.message };
  }
}

async function deleteReport(reportId) {
  try {
    const result = await storage.deleteReport(reportId);
    if (result.success) {
      logger.info('Report deleted', { id: reportId });
    } else {
      logger.error('Failed to delete report', { id: reportId, error: result.error });
    }
    return result;
  } catch (error) {
    logger.error('Delete report error', { error: error.message });
    return { success: false, error: error.message };
  }
}

async function getReportById(reportId) {
  try {
    const reports = await storage.loadReports();
    return reports.find(r => r.id === reportId) || null;
  } catch (error) {
    logger.error('Failed to get report', { id: reportId, error: error.message });
    return null;
  }
}

async function deleteAllReports() {
  try {
    const reports = await storage.loadReports();
    const count = reports.length;
    await storage.save('page_comparator_reports', []);
    logger.info('All reports deleted', { count });
    return { success: true, count };
  } catch (error) {
    logger.error('Failed to delete all reports', { error: error.message });
    return { success: false, error: error.message };
  }
}

async function searchReports(query) {
  try {
    const reports = await loadAllReports();
    const q = query.toLowerCase();
    return reports.filter(r =>
      r.title.toLowerCase().includes(q) ||
      r.url.toLowerCase().includes(q) ||
      r.id.includes(query)
    );
  } catch (error) {
    logger.error('Search reports failed', { error: error.message });
    return [];
  }
}

async function getStorageStats() {
  try {
    const quota = await storage.checkQuota();
    const reports = await storage.loadReports();
    const totalElements = reports.reduce((sum, r) => sum + r.totalElements, 0);
    const avgElements = reports.length > 0 ? Math.round(totalElements / reports.length) : 0;
    return {
      reportsCount: reports.length,
      totalElements,
      avgElements,
      quota: quota || { bytesInUse: 0, quota: 0, percentUsed: 0, available: 0 }
    };
  } catch (error) {
    logger.error('Failed to get storage stats', { error: error.message });
    return null;
  }
}

// ─── JSON EXPORT ─────────────────────────────────────────────────────────────

function exportReportAsJson(report) {
  _triggerDownload(
    JSON.stringify(report, null, 2),
    'application/json',
    `report-${report.id}.json`
  );
  logger.info('Report exported as JSON', { id: report.id });
}

async function exportAllReportsAsJson() {
  try {
    const reports = await storage.loadReports();
    _triggerDownload(
      JSON.stringify(reports, null, 2),
      'application/json',
      `all-reports-${Date.now()}.json`
    );
    logger.info('All reports exported as JSON', { count: reports.length });
    return { success: true, count: reports.length };
  } catch (error) {
    logger.error('Failed to export all reports as JSON', { error: error.message });
    return { success: false, error: error.message };
  }
}

// ─── CSV EXPORT ──────────────────────────────────────────────────────────────

/**
 * Export a single extraction report as CSV.
 *
 * Format:
 *   ## REPORT METADATA section
 *   ## FILTERS section (if filters were applied)
 *   ## ELEMENTS table (one row per element, all key fields as columns)
 *
 * Every value is CSV-escaped so the file opens cleanly in Excel / Google Sheets.
 */
function exportReportAsCsv(report) {
  try {
    const csv = _buildReportCsv(report);
    const filename = `report-${report.id}-${_safeTimestamp()}.csv`;
    _triggerDownload(csv, 'text/csv;charset=utf-8;', filename);
    logger.info('Report exported as CSV', { id: report.id, elementCount: report.elements?.length });
  } catch (error) {
    logger.error('CSV export failed', { id: report.id, error: error.message });
    throw error;
  }
}

/**
 * Export all stored reports concatenated into a single CSV file.
 * Each report is separated by a clearly labelled section header.
 */
async function exportAllReportsAsCsv() {
  try {
    const reports = await storage.loadReports();
    if (reports.length === 0) {
      return { success: false, error: 'No reports to export' };
    }

    const sections = reports.map((report, i) =>
      `## ===== REPORT ${i + 1} of ${reports.length} =====\n` + _buildReportCsv(report)
    );

    const csv = sections.join('\n\n');
    const filename = `all-reports-${_safeTimestamp()}.csv`;
    _triggerDownload(csv, 'text/csv;charset=utf-8;', filename);
    logger.info('All reports exported as CSV', { count: reports.length });
    return { success: true, count: reports.length };
  } catch (error) {
    logger.error('Failed to export all reports as CSV', { error: error.message });
    return { success: false, error: error.message };
  }
}

// ─── CSV INTERNALS ────────────────────────────────────────────────────────────

function _buildReportCsv(report) {
  const rows = [];

  // ── Metadata ──────────────────────────────────────────────────
  rows.push(['## REPORT METADATA']);
  rows.push(['Report ID',      report.id]);
  rows.push(['URL',            report.url]);
  rows.push(['Title',          report.title]);
  rows.push(['Timestamp',      report.timestamp]);
  rows.push(['Total Elements', report.totalElements]);
  rows.push(['Duration (ms)',  report.duration ?? 'N/A']);
  rows.push([]);

  // ── Filters (optional) ────────────────────────────────────────
  if (report.filters && Object.values(report.filters).some(Boolean)) {
    rows.push(['## FILTERS APPLIED']);
    rows.push(['Class Filter', report.filters.class  || 'none']);
    rows.push(['ID Filter',    report.filters.id     || 'none']);
    rows.push(['Tag Filter',   report.filters.tag    || 'none']);
    rows.push([]);
  }

  // ── Elements table ────────────────────────────────────────────
  rows.push(['## EXTRACTED ELEMENTS']);
  rows.push([
    'Element ID',
    'Index',
    'Tag Name',
    'id Attribute',
    'Class Name',
    'Text Content (first 120 chars)',
    'XPath',
    'XPath Confidence',
    'XPath Strategy',
    'CSS Selector',
    'CSS Confidence',
    'CSS Strategy',
    'Position X',
    'Position Y',
    'Width',
    'Height',
    'Is Visible',
    'Display',
    'Visibility',
    'Opacity'
  ]);

  for (const el of (report.elements || [])) {
    rows.push([
      el.id,
      el.index,
      el.tagName,
      _csv(el.elementId),
      _csv(el.className),
      _csv(el.textContent ? el.textContent.substring(0, 120) : ''),
      _csv(el.selectors?.xpath),
      el.selectors?.xpathConfidence ?? 0,
      _csv(el.selectors?.xpathStrategy),
      _csv(el.selectors?.css),
      el.selectors?.cssConfidence ?? 0,
      _csv(el.selectors?.cssStrategy),
      el.position?.x  ?? 0,
      el.position?.y  ?? 0,
      el.position?.width  ?? 0,
      el.position?.height ?? 0,
      el.visibility?.isVisible ? 'Yes' : 'No',
      _csv(el.visibility?.display),
      _csv(el.visibility?.visibility),
      el.visibility?.opacity ?? ''
    ]);
  }

  return rows.map(_rowToCsv).join('\n');
}

/**
 * Convert a row array to a CSV line.
 * Each cell is individually escaped.
 */
function _rowToCsv(cells) {
  return cells.map(cell => _csv(cell)).join(',');
}

/**
 * Escape a single CSV cell value.
 *
 * Rules:
 *   - null/undefined → empty string
 *   - Numbers and booleans → as-is (no quotes)
 *   - Strings: if they contain comma, double-quote, newline, or start with
 *     a special char (=, +, -, @) → wrap in double-quotes, escape inner quotes
 */
function _csv(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const str = String(value);

  // Guard against CSV injection (=SUM(...), +cmd, etc.)
  const safe = /^[=+\-@]/.test(str) ? `'${str}` : str;

  if (safe.includes(',') || safe.includes('"') || safe.includes('\n') || safe.includes('\r')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }

  return safe;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function _triggerDownload(content, mimeType, filename) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

export {
  loadAllReports,
  saveReport,
  deleteReport,
  getReportById,
  deleteAllReports,
  searchReports,
  getStorageStats,
  // JSON
  exportReportAsJson,
  exportAllReportsAsJson,
  // CSV
  exportReportAsCsv,
  exportAllReportsAsCsv
};
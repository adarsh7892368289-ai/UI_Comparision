import { get } from '../config/defaults.js';
import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/storage.js';
import { isValidMeta, isValidReport, sanitizeReport } from '../shared/report-validator.js';

const UTF8_BOM = '\uFEFF';

async function loadAllReports() {
  try {
    const reports = await storage.loadReports();
    logger.debug('Loaded report metadata', { count: reports.length });

    return reports
      .filter(report => {
        const v = isValidMeta(report);
        if (!v.valid) logger.warn('Invalid report metadata', { id: report.id, errors: v.errors });
        return v.valid;
      })
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
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
    const result    = await storage.saveReport(sanitized);
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
    const meta    = reports.find(r => r.id === reportId);
    if (!meta) return null;
    const elements = await storage.loadReportElements(reportId);
    return { ...meta, elements };
  } catch (error) {
    logger.error('Failed to get report', { id: reportId, error: error.message });
    return null;
  }
}

async function deleteAllReports() {
  try {
    const reports = await storage.loadReports();
    const count   = reports.length;
    const result  = await storage.deleteAllReports();

    if (!result.success) return result;

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
    const q       = query.toLowerCase();
    return reports.filter(r =>
      (r.title || '').toLowerCase().includes(q) ||
      (r.url   || '').toLowerCase().includes(q) ||
      r.id.includes(query)
    );
  } catch (error) {
    logger.error('Search reports failed', { error: error.message });
    return [];
  }
}

async function getStorageStats() {
  try {
    const quota          = await storage.checkQuota();
    const reports        = await storage.loadReports();
    const totalElements  = reports.reduce((sum, r) => sum + (r.totalElements || 0), 0);
    const avgElements    = reports.length > 0 ? Math.round(totalElements / reports.length) : 0;
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

async function exportReportAsJson(report) {
  try {
    const full = await getReportById(report.id);
    const data = full || report;
    _triggerDownload(JSON.stringify(data, null, 2), 'application/json', `report-${report.id}.json`);
    logger.info('Report exported as JSON', { id: report.id, elements: data.elements?.length ?? 0 });
  } catch (error) {
    logger.error('JSON export failed', { id: report.id, error: error.message });
    throw error;
  }
}

async function exportAllReportsAsJson() {
  try {
    const metas = await storage.loadReports();
    if (metas.length === 0) return { success: false, error: 'No reports to export' };
    const full = await Promise.all(metas.map(m => getReportById(m.id)));
    _triggerDownload(JSON.stringify(full, null, 2), 'application/json', `all-reports-${Date.now()}.json`);
    logger.info('All reports exported as JSON', { count: full.length });
    return { success: true, count: full.length };
  } catch (error) {
    logger.error('Failed to export all reports as JSON', { error: error.message });
    return { success: false, error: error.message };
  }
}

async function exportReportAsCsv(report) {
  try {
    const full = await getReportById(report.id);
    const data = full || report;
    const csv      = _buildReportCsv(data);
    const filename = `report-${report.id}-${_safeTimestamp()}.csv`;
    _triggerDownload(UTF8_BOM + csv, 'text/csv;charset=utf-8;', filename);
    logger.info('Report exported as CSV', { id: report.id, elementCount: data.elements?.length ?? 0 });
  } catch (error) {
    logger.error('CSV export failed', { id: report.id, error: error.message });
    throw error;
  }
}

async function exportAllReportsAsCsv() {
  try {
    const metas = await storage.loadReports();
    if (metas.length === 0) return { success: false, error: 'No reports to export' };
    const full = await Promise.all(metas.map(m => getReportById(m.id)));
    const sections = full.map((report, i) =>
      `## ===== REPORT ${i + 1} of ${full.length} =====\n` + _buildReportCsv(report)
    );
    _triggerDownload(UTF8_BOM + sections.join('\n\n'), 'text/csv;charset=utf-8;', `all-reports-${_safeTimestamp()}.csv`);
    logger.info('All reports exported as CSV', { count: full.length });
    return { success: true, count: full.length };
  } catch (error) {
    logger.error('Failed to export all reports as CSV', { error: error.message });
    return { success: false, error: error.message };
  }
}

function _buildReportCsv(report) {
  const cssProperties = get('extraction.cssProperties', []);
  const rows = [];

  rows.push(['REPORT METADATA']);
  rows.push(['Report ID',       report.id]);
  rows.push(['URL',             report.url]);
  rows.push(['Title',           report.title]);
  rows.push(['Timestamp',       report.timestamp]);
  rows.push(['Total Elements',  report.totalElements]);
  rows.push(['Duration (ms)',   report.duration ?? 'N/A']);
  rows.push([]);

  if (report.filters && Object.values(report.filters).some(Boolean)) {
    rows.push(['FILTERS APPLIED']);
    rows.push(['Class Filter', report.filters.class || 'none']);
    rows.push(['ID Filter',    report.filters.id    || 'none']);
    rows.push(['Tag Filter',   report.filters.tag   || 'none']);
    rows.push([]);
  }

  rows.push(['EXTRACTED ELEMENTS']);
  rows.push([
    'Element ID', 'Index', 'Tag Name', 'id Attribute', 'Class Name',
    'Text Content',
    'XPath', 'XPath Confidence', 'XPath Strategy',
    'CSS Selector', 'CSS Confidence', 'CSS Strategy',
    'Position X', 'Position Y', 'Width', 'Height',
    'Is Visible', 'Display', 'Visibility', 'Opacity',
    'Attributes',
    ...cssProperties
  ]);

  for (const el of (report.elements || [])) {
    rows.push([
      el.id,
      el.index,
      el.tagName,
      el.elementId ?? '',
      el.className ?? '',
      (el.textContent ?? '').substring(0, 200),
      el.selectors?.xpath          ?? '',
      el.selectors?.xpathConfidence ?? 0,
      el.selectors?.xpathStrategy  ?? '',
      el.selectors?.css            ?? '',
      el.selectors?.cssConfidence  ?? 0,
      el.selectors?.cssStrategy    ?? '',
      el.position?.x      ?? 0,
      el.position?.y      ?? 0,
      el.position?.width  ?? 0,
      el.position?.height ?? 0,
      el.visibility?.isVisible ? 'Yes' : 'No',
      el.visibility?.display    ?? '',
      el.visibility?.visibility ?? '',
      el.visibility?.opacity    ?? '',
      el.attributes ? JSON.stringify(el.attributes) : '',
      ...cssProperties.map(prop => el.styles?.[prop] ?? '')
    ]);
  }

  return rows.map(row => row.map(_csv).join(',')).join('\n');
}

function _csv(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const str  = String(value);
  const safe = /^[=+\-@]/.test(str) ? `'${str}` : str;
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n') || safe.includes('\r')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function _triggerDownload(content, mimeType, filename) {
  if (typeof document === 'undefined') {
    throw new Error('_triggerDownload called outside browser context');
  }
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export {
  loadAllReports, saveReport, deleteReport, getReportById,
  deleteAllReports, searchReports, getStorageStats,
  exportReportAsJson, exportAllReportsAsJson,
  exportReportAsCsv, exportAllReportsAsCsv
};
import logger   from '../infrastructure/logger.js';
import storage   from '../infrastructure/storage.js';
import { isValidMeta, isValidReport, sanitizeReport } from '../shared/report-validator.js';

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

async function getReportById(reportId) {
  try {
    const reports = await storage.loadReports();
    const meta    = reports.find(r => r.id === reportId);
    if (!meta) return null;
    const elements = await storage.loadReportElements(reportId);
    return { ...meta, elements };
  } catch (err) {
    logger.error('Failed to get report', { id: reportId, error: err.message });
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
  } catch (err) {
    logger.error('Failed to delete all reports', { error: err.message });
    return { success: false, error: err.message };
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
  } catch (err) {
    logger.error('Search reports failed', { error: err.message });
    return [];
  }
}

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
  loadAllReports,
  saveReport,
  searchReports
};
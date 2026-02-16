import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/storage.js';
import { isValidReport, sanitizeReport } from '../shared/report-validator.js';

async function loadAllReports() {
  try {
    const reports = await storage.loadReports();
    logger.debug('Loaded reports', { count: reports.length });
    
    const validReports = reports.filter(report => {
      const validation = isValidReport(report);
      if (!validation.valid) {
        logger.warn('Invalid report detected', { 
          id: report.id, 
          errors: validation.errors 
        });
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

function exportReportAsJson(report) {
  const json = JSON.stringify(report, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `report-${report.id}.json`;
  a.click();
  
  URL.revokeObjectURL(url);
  logger.info('Report exported as JSON', { id: report.id });
}

async function deleteAllReports() {
  try {
    const reports = await storage.loadReports();
    const count = reports.length;
    
    const reportKey = 'page_comparator_reports';
    await storage.save(reportKey, []);
    
    logger.info('All reports deleted', { count });
    return { success: true, count };
  } catch (error) {
    logger.error('Failed to delete all reports', { error: error.message });
    return { success: false, error: error.message };
  }
}

async function exportAllReportsAsJson() {
  try {
    const reports = await storage.loadReports();
    const json = JSON.stringify(reports, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `all-reports-${Date.now()}.json`;
    a.click();
    
    URL.revokeObjectURL(url);
    logger.info('All reports exported', { count: reports.length });
    return { success: true, count: reports.length };
  } catch (error) {
    logger.error('Failed to export all reports', { error: error.message });
    return { success: false, error: error.message };
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
      quota: quota || {
        bytesInUse: 0,
        quota: 0,
        percentUsed: 0,
        available: 0
      }
    };
  } catch (error) {
    logger.error('Failed to get storage stats', { error: error.message });
    return null;
  }
}

async function searchReports(query) {
  try {
    const reports = await loadAllReports();
    const lowerQuery = query.toLowerCase();
    
    return reports.filter(report => 
      report.title.toLowerCase().includes(lowerQuery) ||
      report.url.toLowerCase().includes(lowerQuery) ||
      report.id.includes(query)
    );
  } catch (error) {
    logger.error('Search reports failed', { error: error.message });
    return [];
  }
}

export { 
  loadAllReports, 
  saveReport, 
  deleteReport, 
  getReportById, 
  exportReportAsJson,
  deleteAllReports,
  exportAllReportsAsJson,
  getStorageStats,
  searchReports
};
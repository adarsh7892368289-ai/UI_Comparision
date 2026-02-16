import { get } from '../config/defaults.js';
import logger from './logger.js';
import { errorTracker, ERROR_CODES } from './error-tracker.js';

class Storage {
  constructor() {
    this.initialized = false;
  }

  init() {
    if (this.initialized) return this;
    this.initialized = true;
    return this;
  }

  async save(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
      return { success: true };
    } catch (error) {
      if (error.message.includes('QUOTA_BYTES')) {
        errorTracker.track({
          code: ERROR_CODES.STORAGE_QUOTA_EXCEEDED,
          message: 'Storage quota exceeded',
          context: { key }
        });
        return { success: false, error: 'QUOTA_EXCEEDED' };
      }

      errorTracker.track({
        code: ERROR_CODES.STORAGE_WRITE_FAILED,
        message: error.message,
        context: { key }
      });
      return { success: false, error: error.message };
    }
  }

  async load(key) {
    try {
      const result = await chrome.storage.local.get(key);
      return result[key] || null;
    } catch (error) {
      errorTracker.track({
        code: ERROR_CODES.STORAGE_READ_FAILED,
        message: error.message,
        context: { key }
      });
      return null;
    }
  }

  async delete(key) {
    try {
      await chrome.storage.local.remove(key);
      return { success: true };
    } catch (error) {
      logger.error('Storage delete failed', { key, error: error.message });
      return { success: false };
    }
  }

  async clear() {
    try {
      await chrome.storage.local.clear();
      return { success: true };
    } catch (error) {
      logger.error('Storage clear failed', { error: error.message });
      return { success: false };
    }
  }

  async saveReport(report) {
    const reportKey = get('storage.reportKey', 'page_comparator_reports');
    const maxReports = get('storage.maxReports', 50);

    try {
      const existingReports = await this.load(reportKey) || [];
      const reports = [report, ...existingReports];

      if (reports.length > maxReports) {
        reports.splice(maxReports);
        logger.warn('Report limit reached, removing oldest reports', {
          removed: reports.length - maxReports
        });
      }

      const result = await this.save(reportKey, reports);
      
      if (result.success) {
        return { success: true, id: report.id };
      }

      return result;
    } catch (error) {
      logger.error('Failed to save report', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async loadReports() {
    const reportKey = get('storage.reportKey', 'page_comparator_reports');
    const reports = await this.load(reportKey);
    return reports || [];
  }

  async deleteReport(id) {
    const reportKey = get('storage.reportKey', 'page_comparator_reports');
    
    try {
      const reports = await this.loadReports();
      const filtered = reports.filter(r => r.id !== id);
      
      if (filtered.length === reports.length) {
        return { success: false, error: 'Report not found' };
      }

      await this.save(reportKey, filtered);
      return { success: true };
    } catch (error) {
      logger.error('Failed to delete report', { id, error: error.message });
      return { success: false, error: error.message };
    }
  }

  async checkQuota() {
    try {
      const bytesInUse = await chrome.storage.local.getBytesInUse();
      const quota = chrome.storage.local.QUOTA_BYTES || 10485760;
      const percentUsed = (bytesInUse / quota) * 100;

      if (percentUsed > 80) {
        logger.warn('Storage quota warning', {
          bytesInUse,
          quota,
          percentUsed: percentUsed.toFixed(2)
        });
      }

      return {
        bytesInUse,
        quota,
        percentUsed,
        available: quota - bytesInUse
      };
    } catch (error) {
      logger.error('Failed to check quota', { error: error.message });
      return null;
    }
  }
}

const storage = new Storage();
export default storage;
import { get } from '../config/defaults.js';

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
        errorTracker.track({ code: ERROR_CODES.STORAGE_QUOTA_EXCEEDED, message: 'Quota exceeded', context: { key } });
        return { success: false, error: 'QUOTA_EXCEEDED' };
      }
      errorTracker.track({ code: ERROR_CODES.STORAGE_WRITE_FAILED, message: error.message, context: { key } });
      return { success: false, error: error.message };
    }
  }

  async load(key) {
    try {
      const result = await chrome.storage.local.get(key);
      return result[key] ?? null;
    } catch (error) {
      errorTracker.track({ code: ERROR_CODES.STORAGE_READ_FAILED, message: error.message, context: { key } });
      return null;
    }
  }

  async delete(key) {
    try {
      await chrome.storage.local.remove(key);
      return { success: true };
    } catch (error) {
      console.error('Storage delete failed', { key, error: error.message });
      return { success: false };
    }
  }

  async clear() {
    try {
      await chrome.storage.local.clear();
      return { success: true };
    } catch (error) {
      console.error('Storage clear failed', { error: error.message });
      return { success: false };
    }
  }

  async saveReport(report) {
    const baseKey    = get('storage.reportKey');
    const metaKey    = `${baseKey}_meta`;
    const elKey      = `${baseKey}_el_${report.id}`;
    const maxReports = get('storage.maxReports');

    try {
      const { elements, ...meta } = report;
      const existing = await this.load(metaKey) ?? [];
      const updated  = [meta, ...existing];

      if (updated.length > maxReports) {
        const evicted = updated.splice(maxReports);
        await Promise.all(
          evicted.map(r => chrome.storage.local.remove(`${baseKey}_el_${r.id}`))
        );
        console.warn('Evicted old reports', { count: evicted.length });
      }

      const [metaResult, elResult] = await Promise.all([
        this.save(metaKey, updated),
        elements?.length ? this.save(elKey, elements) : Promise.resolve({ success: true })
      ]);

      if (!metaResult.success) return metaResult;
      if (!elResult.success)   return elResult;

      return { success: true, id: report.id };
    } catch (error) {
      console.error('Failed to save report', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async loadReports() {
    const baseKey = get('storage.reportKey');
    return await this.load(`${baseKey}_meta`) ?? [];
  }

  async loadReportElements(reportId) {
    const baseKey = get('storage.reportKey');
    return await this.load(`${baseKey}_el_${reportId}`) ?? [];
  }

  async deleteReport(id) {
    const baseKey = get('storage.reportKey');
    const metaKey = `${baseKey}_meta`;

    try {
      const existing = await this.load(metaKey) ?? [];
      const filtered = existing.filter(r => r.id !== id);

      if (filtered.length === existing.length) {
        return { success: false, error: 'Report not found' };
      }

      await Promise.all([
        this.save(metaKey, filtered),
        chrome.storage.local.remove(`${baseKey}_el_${id}`)
      ]);

      return { success: true };
    } catch (error) {
      console.error('Failed to delete report', { id, error: error.message });
      return { success: false, error: error.message };
    }
  }

  async checkQuota() {
    try {
      const bytesInUse  = await chrome.storage.local.getBytesInUse();
      const quota       = chrome.storage.local.QUOTA_BYTES || 10485760;
      const percentUsed = (bytesInUse / quota) * 100;

      if (percentUsed > 80) {
        console.warn('Storage quota warning', { bytesInUse, quota, percentUsed: percentUsed.toFixed(1) });
      }

      return { bytesInUse, quota, percentUsed, available: quota - bytesInUse };
    } catch (error) {
      console.error('Failed to check quota', { error: error.message });
      return null;
    }
  }
}

const storage = new Storage();
export default storage;
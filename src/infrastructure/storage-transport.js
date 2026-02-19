import { get } from '../config/defaults.js';

class StorageTransport {
  constructor() {
    this.buffer = [];
    this.maxEntries = get('logging.maxEntries', 1000);
    this.flushBatchSize = 10;
    this.flushTimer = null;
    this.flushDelay = 1000;
  }

  write(logEntry) {
    this.buffer.push(logEntry);
    
    if (this.buffer.length > this.maxEntries) {
      this.buffer.shift();
    }

    if (this.buffer.length % this.flushBatchSize === 0) {
      this._scheduleFlush();
    }
  }

  _scheduleFlush() {
    if (this.flushTimer) return;
    
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushDelay);
  }

  async flush() {
    if (this.buffer.length === 0) return;

    try {
      const storageKey = get('storage.logsKey', 'page_comparator_logs');
      await chrome.storage.local.set({ [storageKey]: this.buffer });
    } catch (error) {
      console.error('[StorageTransport] Flush failed:', error);
    }
  }

  getLogs() {
    return [...this.buffer];
  }

  clear() {
    this.buffer = [];
    
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

export { StorageTransport };
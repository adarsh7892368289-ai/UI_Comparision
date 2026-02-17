import { get } from '../config/defaults.js';

class ConsoleTransport {
  write(logEntry) {
    const { level, message, timestamp, ...meta } = logEntry;
    const consoleFn = console[level] || console.log;
    const prefix = `[${timestamp}] ${level.toUpperCase()}:`;
    const hasMetadata = Object.keys(meta).length > 0;
    if (hasMetadata) {
      consoleFn(prefix, message, meta);
    } else {
      consoleFn(prefix, message);
    }
  }
}

class StorageTransport {
  constructor() {
    this.buffer       = [];
    this.maxEntries   = get('logging.maxEntries', 1000);
    this.flushBatchSize = 10;
  }

  async write(logEntry) {
    this.buffer.push(logEntry);
    if (this.buffer.length > this.maxEntries) this.buffer.shift();
    if (this.buffer.length % this.flushBatchSize === 0) await this._flush();
  }

  async _flush() {
    try {
      const storageKey = get('storage.logsKey', 'page_comparator_logs');
      await chrome.storage.local.set({ [storageKey]: this.buffer });
    } catch (error) {
      console.error('[Logger] Failed to persist logs:', error);
    }
  }

  async forceFlush() {
    if (this.buffer.length > 0) await this._flush();
  }

  getLogs() { return [...this.buffer]; }
  clear()   { this.buffer = []; }
}

class Logger {
  constructor() {
    this.transports    = [];
    this.level         = 'info';
    this.context       = {};
    this.initialized   = false;
    this._storageTransport = null;
  }

  init() {
    if (this.initialized) return this;
    this.level = get('logging.level', 'info');
    this.transports.push(new ConsoleTransport());
    if (get('logging.persistLogs', true)) {
      this._storageTransport = new StorageTransport();
      this.transports.push(this._storageTransport);
    }
    this.initialized = true;
    return this;
  }

  setContext(context) { this.context = { ...this.context, ...context }; }
  clearContext()      { this.context = {}; }

  debug(message, meta = {}) { this._log('debug', message, meta); }
  info(message, meta = {})  { this._log('info',  message, meta); }
  warn(message, meta = {})  { this._log('warn',  message, meta); }
  error(message, meta = {}) { this._log('error', message, meta); }

  /**
   * Log a performance measurement.
   * Threshold is read from config — no hardcoded 500ms.
   */
  perf(operation, durationMs, data = {}) {
    const threshold = get('logging.slowOperationThreshold', 500);
    if (durationMs > threshold) {
      this.warn(`Slow operation: ${operation}`, { duration: durationMs, threshold, ...data });
    } else {
      this.debug(`Performance: ${operation}`, { duration: durationMs, ...data });
    }
  }

  _log(level, message, meta) {
    if (this._shouldSkip(level)) return;
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.context,
      ...meta
    };
    if (level === 'error') logEntry.stack = new Error().stack;
    for (const transport of this.transports) {
      try { transport.write(logEntry); }
      catch (err) { console.error('[Logger] Transport failed:', err); }
    }
  }

  _shouldSkip(level) {
    const levels = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) < levels.indexOf(this.level);
  }

  exportLogs() { return this._storageTransport?.getLogs() ?? []; }
  clearLogs()  { this._storageTransport?.clear(); }

  async flush() {
    if (this._storageTransport) await this._storageTransport.forceFlush();
  }

  async measure(label, fn) {
    const start = performance.now();
    try {
      const result = await fn();
      this.perf(label, performance.now() - start);
      return result;
    } catch (error) {
      this.error(`${label} failed`, {
        duration: performance.now() - start,
        error:    error.message
      });
      throw error;
    }
  }
}

const logger = new Logger();
export default logger;
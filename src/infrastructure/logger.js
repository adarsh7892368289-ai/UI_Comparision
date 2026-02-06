//Structured Logger
// Logs messages with severity levels (debug < info < warn < error)
// Outputs to console AND persists to chrome.storage
// Adds metadata automatically (timestamp, context)

import config from './config.js';

//// LOG TRANSPORTS (Where logs are written)
class ConsoleTransport {
  write(logEntry) {
    const { level, message, timestamp, ...meta } = logEntry;
    
    // Use appropriate console method
    const consoleFn = console[level] || console.log;
    
    // Format: [timestamp] LEVEL: message { metadata }
    const prefix = `[${timestamp}] ${level.toUpperCase()}:`;
    consoleFn(prefix, message, meta);
  }
}

//Storage Transport - Persists logs for export
class StorageTransport {
  constructor() {
    this.buffer = [];
    this.maxEntries = 1000;
    this.flushBatchSize = 10;
  }

  async write(logEntry) {
    this.buffer.push(logEntry);

    if (this.buffer.length > this.maxEntries) {
      this.buffer.shift();
    }

    if (this.buffer.length % this.flushBatchSize === 0) {
      await this._flush();
    }
  }

  async _flush() {
    try {
      const storageKey = config.get('storage.keys.logs', 'page_comparator_logs');
      await chrome.storage.local.set({ [storageKey]: this.buffer });
    } catch (error) {
      console.error('[Logger] Failed to persist logs:', error);
    }
  }

  async forceFlush() {
    if (this.buffer.length > 0) {
      await this._flush();
    }
  }

  getLogs() {
    return [...this.buffer];
  }

  clear() {
    this.buffer = [];
  }
}


// LOGGER CLASS
class Logger {
	constructor() {
		this.transports = [];
		this.level = 'info';
		this.context = {};
		this.initialized = false;
	}

	init(){
		if (this.initialized) return this;

		this.level = config.get('logging.level', 'info');

		// Always add console transport
		this.transports.push(new ConsoleTransport());
		
		// Add storage transport if enabled
		if (config.get('logging.persistLogs', true)) {
			const storageTransport = new StorageTransport();
			this.transports.push(storageTransport);
			
			// Store reference for export/clear operations
			this.storageTransport = storageTransport;
		}

		this.initialized = true;
		return this;
	}

    //Set global context for all logs 
    setContext(context) {
        this.context = { ...this.context, ...context };
    }

    //Clear global context
    clearContext() {
        this.context = {};
    }

    //Debug logs
    debug(message, meta = {}) {
        this._log('debug', message, meta);
    }

    //Info logs
    info(message, meta = {}) {
        this._log('info', message, meta);
    }

    //Warn logs
    warn(message, meta = {}) {
        this._log('warn', message, meta);
    }

    //Error logs
    error(message, meta = {}) {
        this._log('error', message, meta);
    }

    //Performance logs
    perf(operation, durationMs, data = {}) {
      const threshold = config.get('performance.slowOperationThreshold', 500);

      if (durationMs > threshold) {
        this.warn(`Slow operation: ${operation}`, {
          duration: durationMs,
          threshold,
          ...data,
        });
      } else {
        this.debug(`Performance: ${operation}`, {
          duration: durationMs,
          ...data,
        });
      }
    }

	// INTERNAL METHODS

	//Core logging logic
	_log(level, message, meta) {
		if(this._shouldSkip(level)) return;

		const logEntry = {
			timestamp: new Date().toISOString(),
			level,
			message,
			...this.context,
			...data,
		}

		// Add stack trace for errors if enabled
		if (level === 'error' && config.get('logging.includeStackTraces', true)) {
			logEntry.stack = new Error().stack;
		}

		// Write to all transports
		for (const transport of this.transports) {
			try {
				transport.write(logEntry);
			} catch (error) {
				console.error('[Logger] Transport failed:', error);
			}
		}
	}

	//Check if log should be skipped based on level
	_shouldSkip(level) {
		const levels = ['debug', 'info', 'warn', 'error'];
		const configuredIndex = levels.indexOf(this.level);
		const messageIndex = levels.indexOf(level);
		
		return messageIndex < configuredIndex;
	}


  // UTILITY METHODS

  //Export logs for diagnostics
  exportLogs() {
    if (!this.storageTransport) {
      return [];
    }
    return this.storageTransport.getLogs();
  }

  //Clear all logs
  clearLogs() {
    if (this.storageTransport) {
      this.storageTransport.clear();
    }
  }

  //Force flush pending logs
  async flush() {
    if (this.storageTransport) {
      await this.storageTransport.forceFlush();
    }
  }

  //Measure function execution time
  async measure(label, fn) {
    const start = performance.now();
    
    try {
      const result = await fn();
      const duration = performance.now() - start;
      this.perf(label, duration);
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      this.error(`${label} failed`, { duration, error: error.message });
      throw error;
    }
  }
}

export default new Logger();

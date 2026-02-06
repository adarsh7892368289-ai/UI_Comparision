// Error Tracker
// Tracks errors with deduplication (same error = increment counter)
// LRU eviction when limit reached
// Provides error summaries for diagnostics

import config from './config.js';
import logger from './logger.js';

// CUSTOM ERROR CLASSES

//Base error class with code and context
export class TrackedError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'TrackedError';
    this.code = code;
    this.context = context;
    this.timestamp = new Date().toISOString();
    
    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TrackedError);
    }
  }
}

//Error codes enum
export const ErrorCodes = {
  // Extraction errors
  EXTRACTION_TIMEOUT: 'EXTRACTION_TIMEOUT',
  EXTRACTION_ELEMENT_DETACHED: 'EXTRACTION_ELEMENT_DETACHED',
  EXTRACTION_INVALID_ELEMENT: 'EXTRACTION_INVALID_ELEMENT',
  
  // Selector generation errors
  XPATH_GENERATION_FAILED: 'XPATH_GENERATION_FAILED',
  XPATH_VALIDATION_FAILED: 'XPATH_VALIDATION_FAILED',
  XPATH_TIMEOUT: 'XPATH_TIMEOUT',
  CSS_GENERATION_FAILED: 'CSS_GENERATION_FAILED',
  CSS_VALIDATION_FAILED: 'CSS_VALIDATION_FAILED',
  
  // Comparison errors
  COMPARISON_NO_XPATH: 'COMPARISON_NO_XPATH',
  COMPARISON_INVALID_REPORT: 'COMPARISON_INVALID_REPORT',
  
  // Storage errors
  STORAGE_QUOTA_EXCEEDED: 'STORAGE_QUOTA_EXCEEDED',
  STORAGE_WRITE_FAILED: 'STORAGE_WRITE_FAILED',
  STORAGE_READ_FAILED: 'STORAGE_READ_FAILED',
  STORAGE_VERSION_CONFLICT: 'STORAGE_VERSION_CONFLICT',
  
  // Generic
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
};

// ERROR TRACKER CLASS
class ErrorTracker {
  constructor() {
    this.errors = new Map(); // key: errorKey, value: errorEntry
    this.maxErrors = 100;
    this.deduplicateEnabled = true;
  }

  init() {
    this.maxErrors = config.get('errors.maxUniqueErrors', 100);
    this.deduplicateEnabled = config.get('errors.deduplicate', true);
    return this;
  }

  //Log an error
  logError(code, message, context = {}) {
    const errorKey = this._getErrorKey(code, message);

    if (this.deduplicateEnabled && this.errors.has(errorKey)) {
      // Increment existing error
      const existing = this.errors.get(errorKey);
      existing.count++;
      existing.lastSeen = new Date().toISOString();
      
      this.errors.delete(errorKey);
      this.errors.set(errorKey, existing);
    } else {
      const errorEntry = {
        code,
        message,
        context: this._sanitizeContext(context),
        count: 1,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      };

      if (this.errors.size >= this.maxErrors) {
        const firstKey = this.errors.keys().next().value;
        this.errors.delete(firstKey);
      }

      this.errors.set(errorKey, errorEntry);
    }

    logger.error(message, { code, ...context });

    return this;
  }

  //Create TrackedError and log it
  createError(code, message, context = {}) {
    this.logError(code, message, context);
    return new TrackedError(code, message, context);
  }

  //Get all errors (for diagnostics)
  getErrors() {
    return Array.from(this.errors.values());
  }

  //Get errors by code
  getErrorsByCode(code) {
    return this.getErrors().filter(err => err.code === code);
  }

  // Get error count
  getErrorCount() {
    return this.errors.size;
  }

  //Get total error occurrences 
  getTotalOccurrences() {
    return Array.from(this.errors.values())
      .reduce((sum, err) => sum + err.count, 0);
  }

  //Get most frequent errors (top N)
  getMostFrequent(limit = 10) {
    return this.getErrors()
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  //Clear all errors
  clear() {
    this.errors.clear();
    return this;
  }

  //Clear errors by code
  clearByCode(code) {
    for (const [key, error] of this.errors.entries()) {
      if (error.code === code) {
        this.errors.delete(key);
      }
    }
    return this;
  }

  //Export errors as JSON (for diagnostics report)
  exportErrors() {
    return {
      totalUnique: this.getErrorCount(),
      totalOccurrences: this.getTotalOccurrences(),
      errors: this.getErrors(),
      timestamp: new Date().toISOString(),
    };
  }

  // INTERNAL HELPERS

  //Generate deduplication key
  _getErrorKey(code, message) {
    return `${code}:${this._hashString(message)}`;
  }

  //Simple string hash
  _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  //Sanitize context to prevent storing sensitive data
  _sanitizeContext(context) {
    const sanitized = { ...context };

    // Remove sensitive fields
    delete sanitized.password;
    delete sanitized.token;
    delete sanitized.apiKey;

    // Limit element snapshot size if enabled
    if (config.get('errors.captureElementSnapshot', true) && context.element) {
      sanitized.element = {
        tagName: context.element.tagName,
        id: context.element.id,
        className: context.element.className,
      };
    }

    // Truncate large strings
    for (const key in sanitized) {
      if (typeof sanitized[key] === 'string' && sanitized[key].length > 500) {
        sanitized[key] = sanitized[key].substring(0, 500) + '... (truncated)';
      }
    }

    return sanitized;
  }
}

export default new ErrorTracker();
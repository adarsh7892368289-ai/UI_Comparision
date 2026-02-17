import { get } from '../config/defaults.js';
import logger from './logger.js';
import errorTracker from './error-tracker.js';

class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    // All defaults read from config — no hardcoded fallback literals
    this.failureThreshold = options.failureThreshold ?? get('infrastructure.circuitBreaker.failureThreshold');
    this.resetTimeout     = options.resetTimeout     ?? get('infrastructure.circuitBreaker.resetTimeout');
    this.cooldownPeriod   = options.cooldownPeriod   ?? get('infrastructure.circuitBreaker.cooldownPeriod');

    this.state          = 'CLOSED';
    this.failures       = 0;
    this.successes      = 0;
    this.lastFailureTime  = null;
    this.nextAttemptTime  = null;
  }

  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() >= this.nextAttemptTime) {
        this.state = 'HALF_OPEN';
        logger.info(`Circuit breaker ${this.name}: HALF_OPEN`);
      } else {
        throw new Error(`Circuit breaker ${this.name} is OPEN`);
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure();
      throw error;
    }
  }

  _onSuccess() {
    this.failures = 0;
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      logger.info(`Circuit breaker ${this.name}: CLOSED (recovered)`);
    }
  }

  _onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state           = 'OPEN';
      this.nextAttemptTime = Date.now() + this.cooldownPeriod;
      logger.warn(`Circuit breaker ${this.name}: OPEN (${this.failures} failures)`);
    }
  }

  reset() {
    this.state           = 'CLOSED';
    this.failures        = 0;
    this.successes       = 0;
    this.lastFailureTime  = null;
    this.nextAttemptTime  = null;
  }
}

const circuitBreakers = new Map();

function getCircuitBreaker(operation) {
  if (!circuitBreakers.has(operation)) {
    circuitBreakers.set(operation, new CircuitBreaker(operation));
  }
  return circuitBreakers.get(operation);
}

function isTransientError(error) {
  const transientPatterns = [
    /timeout/i, /network/i, /quota.*exceeded/i, /temporary/i, /unavailable/i
  ];
  return transientPatterns.some(p => p.test(error.message || String(error)));
}

async function safeExecute(fn, options = {}) {
  // Read timeout from config — caller may override for specific operations
  const timeout   = options.timeout   ?? get('infrastructure.timeout.default');
  const operation = options.operation ?? 'anonymous';
  const fallback  = options.fallback;

  const circuitBreaker = getCircuitBreaker(operation);

  try {
    const result = await circuitBreaker.execute(async () =>
      Promise.race([
        fn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
        )
      ])
    );
    return { success: true, data: result };
  } catch (error) {
    logger.error(`Operation ${operation} failed`, {
      error: error.message,
      stack: error.stack
    });
    errorTracker.track({
      code:    'EXECUTION_FAILED',
      message: error.message,
      context: { operation }
    });
    if (fallback !== undefined) {
      return { success: false, data: fallback, error: error.message };
    }
    return { success: false, error: error.message };
  }
}

async function safeExecuteWithRetry(fn, options = {}) {
  const maxRetries = options.maxRetries ?? get('infrastructure.retry.maxRetries');
  const timeout    = options.timeout    ?? get('infrastructure.timeout.default');
  const operation  = options.operation  ?? 'anonymous';
  const baseDelay  = options.baseDelay  ?? get('infrastructure.retry.baseDelay');
  const maxDelay   = options.maxDelay   ?? get('infrastructure.retry.maxDelay');

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const jitter = Math.random() * 0.3;
      const delay  = Math.min(
        baseDelay * Math.pow(2, attempt - 1) * (1 + jitter),
        maxDelay
      );
      await new Promise(resolve => setTimeout(resolve, delay));
      logger.debug(`Retry attempt ${attempt} for ${operation} after ${Math.round(delay)}ms`);
    }

    const result = await safeExecute(fn, { timeout, operation });

    if (result.success) {
      if (attempt > 0) {
        logger.info(`Operation ${operation} succeeded after ${attempt} retries`);
      }
      return result;
    }

    lastError = result.error;

    if (!isTransientError({ message: lastError })) {
      logger.warn(`Non-transient error for ${operation}, stopping retries`);
      break;
    }
  }

  return { success: false, error: lastError };
}

export { safeExecute, safeExecuteWithRetry, CircuitBreaker, getCircuitBreaker };
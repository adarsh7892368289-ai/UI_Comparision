//Safe Execute - Resilience Wrapper
// Wraps functions with timeout protection
// Retries transient failures with exponential backoff
// Circuit breaker pattern to prevent cascading failures

import config from './config.js';
import logger from './logger.js';
import errorTracker, { ErrorCodes } from './error-tracker.js';

// ERROR CLASSIFICATION

//Classify errors as transient (retry) or permanent (fail fast)
function isTransientError(error) {
  const transientPatterns = [
    /timeout/i,
    /network/i,
    /quota.*exceeded/i,
    /temporary/i,
    /try.*again/i,
  ];

  const errorMessage = error.message || error.toString();
  return transientPatterns.some(pattern => pattern.test(errorMessage));
}

// CIRCUIT BREAKER

// States:
//  CLOSED: Normal operation
//  OPEN: Too many failures, reject immediately
//  HALF_OPEN: After cooldown, try once to test recovery
class CircuitBreaker {
  constructor(name) {
    this.name = name;
    this.state = 'CLOSED';
    this.failures = [];
    this.failureThreshold = 5;
    this.failureWindow = 30000; 
    this.cooldownPeriod = 5000; 
    this.openedAt = null;
  }

  //Check if operation should be allowed
  canExecute() {
    if (this.state === 'CLOSED') {
      return true;
    }

    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now - this.openedAt >= this.cooldownPeriod) {
        this.state = 'HALF_OPEN';
        logger.info(`Circuit breaker ${this.name} entering HALF_OPEN`);
        return true;
      }
      return false;
    }

    if (this.state === 'HALF_OPEN') {
      return true;
    }

    return false;
  }

  //Record successful execution
  recordSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      this.failures = [];
      logger.info(`Circuit breaker ${this.name} recovered to CLOSED`);
    }
  }

  //Record failed execution
  recordFailure() {
    const now = Date.now();
    this.failures.push(now);

    // Remove failures outside window
    this.failures = this.failures.filter(
      timestamp => now - timestamp < this.failureWindow
    );

    // Check if threshold exceeded
    if (this.failures.length >= this.failureThreshold && this.state === 'CLOSED') {
      this.state = 'OPEN';
      this.openedAt = now;
      logger.warn(`Circuit breaker ${this.name} tripped to OPEN`, {
        failures: this.failures.length,
        threshold: this.failureThreshold,
      });
    }

    // If half-open and still failing, go back to open
    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.openedAt = now;
      logger.warn(`Circuit breaker ${this.name} failed in HALF_OPEN, back to OPEN`);
    }
  }

  //Get current state
  getState() {
    return {
      state: this.state,
      failureCount: this.failures.length,
      openedAt: this.openedAt,
    };
  }

  //Reset circuit breaker
  reset() {
    this.state = 'CLOSED';
    this.failures = [];
    this.openedAt = null;
  }
}

// Global circuit breakers 
const circuitBreakers = new Map();

function getCircuitBreaker(name) {
  if (!circuitBreakers.has(name)) {
    circuitBreakers.set(name, new CircuitBreaker(name));
  }
  return circuitBreakers.get(name);
}

// EXPONENTIAL BACKOFF

//Calculate backoff delay with jitter
//Formula: delay = baseDelay × 2^attempt × (1 + random jitter)
function calculateBackoff(attempt, baseDelay = 100, maxDelay = 5000) {
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3; 
  const delay = exponentialDelay * (1 + jitter);
  
  return Math.min(delay, maxDelay);
}

//Sleep for specified duration
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// SAFE EXECUTE FUNCTIONS

//Execute function with timeout protection
export async function safeExecute(fn, options = {}) {
  const {
    timeout = config.get('extraction.timeout', 150),
    fallback = null,
    operation = 'unknown',
  } = options;

  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
      ),
    ]);

    return result;
  } catch (error) {
    logger.warn(`safeExecute failed: ${operation}`, {
      error: error.message,
      timeout,
    });

    return fallback;
  }
}

//Execute with retry on transient failures
export async function safeExecuteWithRetry(fn, options = {}) {
  const {
    timeout = config.get('extraction.timeout', 150),
    fallback = null,
    retries = config.get('extraction.maxRetries', 3),
    operation = 'unknown',
    enableCircuitBreaker = true,
  } = options;

  const breaker = enableCircuitBreaker ? getCircuitBreaker(operation) : null;
  if (breaker && !breaker.canExecute()) {
    logger.warn(`Circuit breaker ${operation} is OPEN, skipping execution`);
    return fallback;
  }

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
        ),
      ]);

      if (breaker) {
        breaker.recordSuccess();
      }

      return result;

    } catch (error) {
      lastError = error;

      const transient = isTransientError(error);

      if (!transient || attempt === retries) {
        logger.error(`${operation} failed permanently`, {
          error: error.message,
          attempt: attempt + 1,
          transient,
        });

        if (breaker) {
          breaker.recordFailure();
        }

        errorTracker.logError(
          ErrorCodes.UNKNOWN_ERROR,
          `${operation} failed: ${error.message}`,
          { attempt, transient }
        );

        return fallback;
      }

      const backoffDelay = calculateBackoff(attempt);
      logger.debug(`${operation} failed (transient), retrying in ${backoffDelay}ms`, {
        error: error.message,
        attempt: attempt + 1,
      });

      await sleep(backoffDelay);
    }
  }

  return fallback;
}

//Execute multiple functions in parallel with individual error handling
export async function safeExecuteAll(functions, options = {}) {
  const {
    timeout = config.get('extraction.timeout', 150),
    operation = 'batch',
  } = options;

  const promises = functions.map((fn, index) =>
    safeExecute(fn, {
      timeout,
      fallback: null,
      operation: `${operation}[${index}]`,
    })
  );

  const results = await Promise.allSettled(promises);

  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      logger.warn(`${operation}[${index}] rejected`, {
        reason: result.reason?.message,
      });
      return null;
    }
  });
}

//Measure execution time of a function
export async function measurePerformance(fn, label) {
  const start = performance.now();

  try {
    const result = await fn();
    const duration = performance.now() - start;

    // Log via logger's perf method
    logger.perf(label, duration);

    return { result, duration };
  } catch (error) {
    const duration = performance.now() - start;
    logger.error(`${label} failed`, { duration, error: error.message });
    throw error;
  }
}

// UTILITY EXPORTS

//Reset all circuit breakers 
export function resetCircuitBreakers() {
  circuitBreakers.clear();
}

//Get circuit breaker state
export function getCircuitBreakerStates() {
  const states = {};
  for (const [name, breaker] of circuitBreakers.entries()) {
    states[name] = breaker.getState();
  }
  return states;
}

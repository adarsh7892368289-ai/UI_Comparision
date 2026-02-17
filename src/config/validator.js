/**
 * config/validator.js — Startup Config Validation
 *
 * Validates every config path that any module reads at runtime.
 * Called once in background.js before any other module is used.
 *
 * Design principle: fail loudly in development, warn in production.
 * This catches regressions where defaults.js is edited incorrectly.
 */

import { get } from './defaults.js';

// Every path used across the codebase — if you add a get() call, add it here.
const REQUIRED_PATHS = [
  // Extraction
  'extraction.batchSize',
  'extraction.perElementTimeout',
  'extraction.maxElements',
  'extraction.skipInvisible',
  'extraction.irrelevantTags',
  'extraction.cssProperties',

  // Selectors
  'selectors.xpath.perStrategyTimeout',
  'selectors.xpath.totalTimeout',
  'selectors.xpath.enableFallback',
  'selectors.css.perStrategyTimeout',
  'selectors.css.totalTimeout',
  'selectors.css.enableFallback',
  'selectors.minRobustnessScore',

  // Comparison — tolerances
  'comparison.tolerances.color',
  'comparison.tolerances.size',
  'comparison.tolerances.opacity',
  'comparison.matching.confidenceThreshold',
  'comparison.matching.positionTolerance',
  'comparison.confidence.high',
  'comparison.confidence.medium',
  'comparison.confidence.low',
  'comparison.confidence.min',

  // Comparison — severity lists
  'comparison.severity.critical',
  'comparison.severity.high',
  'comparison.severity.medium',

  // Comparison — property categories
  'comparison.propertyCategories.layout',
  'comparison.propertyCategories.visual',
  'comparison.propertyCategories.typography',
  'comparison.propertyCategories.spacing',
  'comparison.propertyCategories.position',

  // Comparison — modes
  'comparison.modes.dynamic.ignoredProperties',
  'comparison.modes.dynamic.compareTextContent',
  'comparison.modes.dynamic.tolerances',
  'comparison.modes.static.ignoredProperties',
  'comparison.modes.static.compareTextContent',
  'comparison.modes.static.tolerances',

  // Normalization
  'normalization.cache.enabled',
  'normalization.cache.maxEntries',
  'normalization.rounding.decimals',

  // Infrastructure
  'infrastructure.circuitBreaker.failureThreshold',
  'infrastructure.circuitBreaker.cooldownPeriod',
  'infrastructure.circuitBreaker.resetTimeout',
  'infrastructure.retry.maxRetries',
  'infrastructure.retry.baseDelay',
  'infrastructure.retry.maxDelay',
  'infrastructure.timeout.default',
  'infrastructure.timeout.extraction',
  'infrastructure.timeout.tabLoad',
  'infrastructure.timeout.contentScript',

  // Storage
  'storage.maxReports',
  'storage.reportKey',
  'storage.logsKey',
  'storage.stateKey',

  // Logging
  'logging.level',
  'logging.persistLogs',
  'logging.maxEntries',
  'logging.slowOperationThreshold',

  // Attributes
  'attributes.priority',
  'attributes.supplementary',
  'attributes.frameworkPatterns',
  'attributes.dynamicIdPatterns',
  'attributes.dynamicClassPatterns',

  // Export
  'export.excel.headerColor',
  'export.excel.criticalColor',
  'export.excel.highColor',
  'export.excel.mediumColor',
  'export.excel.lowColor',
  'export.csv.delimiter',
  'export.csv.encoding'
];

// Type expectations — catch wrong types before runtime errors
const TYPE_EXPECTATIONS = [
  { path: 'extraction.batchSize',                    type: 'number' },
  { path: 'extraction.perElementTimeout',            type: 'number' },
  { path: 'extraction.maxElements',                  type: 'number' },
  { path: 'extraction.skipInvisible',                type: 'boolean' },
  { path: 'extraction.irrelevantTags',               type: 'array' },
  { path: 'extraction.cssProperties',                type: 'array' },
  { path: 'selectors.xpath.perStrategyTimeout',      type: 'number' },
  { path: 'selectors.css.perStrategyTimeout',        type: 'number' },
  { path: 'comparison.tolerances.color',             type: 'number' },
  { path: 'comparison.tolerances.size',              type: 'number' },
  { path: 'comparison.severity.critical',            type: 'array' },
  { path: 'comparison.severity.high',                type: 'array' },
  { path: 'comparison.severity.medium',              type: 'array' },
  { path: 'comparison.modes.dynamic.ignoredProperties', type: 'array' },
  { path: 'infrastructure.circuitBreaker.failureThreshold', type: 'number' },
  { path: 'infrastructure.circuitBreaker.cooldownPeriod',   type: 'number' },
  { path: 'infrastructure.timeout.default',          type: 'number' },
  { path: 'logging.slowOperationThreshold',          type: 'number' },
  { path: 'attributes.priority',                     type: 'array' },
  { path: 'attributes.frameworkPatterns',            type: 'array' }
];

/**
 * Validate the full config at startup.
 *
 * @param {Object} options
 * @param {boolean} options.throwOnError   Default true in dev, false in prod
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateConfig({ throwOnError = true } = {}) {
  const errors = [];

  // 1. Check every required path exists and is non-null
  for (const path of REQUIRED_PATHS) {
    try {
      const value = get(path);
      if (value === null || value === undefined) {
        errors.push(`[Config] "${path}" is null/undefined`);
      }
    } catch (e) {
      errors.push(`[Config] "${path}" does not exist — ${e.message}`);
    }
  }

  // 2. Check type expectations
  for (const { path, type } of TYPE_EXPECTATIONS) {
    try {
      const value = get(path);
      const actual = Array.isArray(value) ? 'array' : typeof value;
      if (actual !== type) {
        errors.push(`[Config] "${path}" expected ${type}, got ${actual}`);
      }
    } catch (_) {
      // already caught by required-paths check above
    }
  }

  // 3. Check value sanity (catch accidentally zeroed-out values)
  const sanityChecks = [
    { path: 'extraction.batchSize',           min: 1,   max: 100  },
    { path: 'extraction.perElementTimeout',   min: 10,  max: 5000 },
    { path: 'extraction.maxElements',         min: 100, max: 100000 },
    { path: 'selectors.xpath.perStrategyTimeout', min: 10, max: 2000 },
    { path: 'selectors.css.perStrategyTimeout',   min: 5,  max: 1000 },
    { path: 'comparison.tolerances.color',        min: 0,  max: 255  },
    { path: 'comparison.tolerances.size',         min: 0,  max: 100  },
    { path: 'infrastructure.circuitBreaker.failureThreshold', min: 1, max: 100 },
    { path: 'infrastructure.timeout.default', min: 100, max: 300000 },
    { path: 'logging.slowOperationThreshold', min: 50,  max: 30000  }
  ];

  for (const { path, min, max } of sanityChecks) {
    try {
      const value = get(path);
      if (typeof value === 'number' && (value < min || value > max)) {
        errors.push(`[Config] "${path}" value ${value} is outside expected range [${min}, ${max}]`);
      }
    } catch (_) {
      // already caught above
    }
  }

  const valid = errors.length === 0;

  if (!valid) {
    const summary = `Config validation failed with ${errors.length} error(s):\n` +
                    errors.map(e => `  • ${e}`).join('\n');

    if (throwOnError) {
      throw new Error(summary);
    } else {
      console.error(summary);
    }
  }

  return { valid, errors };
}

export { validateConfig };
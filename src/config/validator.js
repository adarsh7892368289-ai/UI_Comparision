import { get } from './defaults.js';
import logger from '../infrastructure/logger.js';

const REQUIRED_PATHS = [
  'extraction.batchSize',
  'extraction.perElementTimeout',
  'extraction.maxElements',
  'extraction.skipInvisible',
  'extraction.stabilityWindowMs',
  'extraction.hardTimeoutMs',
  'extraction.initialValueSentinel',
  'extraction.irrelevantTags',
  'extraction.cssProperties',

  'fingerprint.textMaxChars',
  'fingerprint.selectorMaxDepth',
  'fingerprint.stateClassPattern',

  'selectors.xpath.perStrategyTimeout',
  'selectors.xpath.totalTimeout',
  'selectors.xpath.enableFallback',
  'selectors.xpath.parallelExecution',
  'selectors.css.perStrategyTimeout',
  'selectors.css.totalTimeout',
  'selectors.css.enableFallback',
  'selectors.css.parallelExecution',
  'selectors.minRobustnessScore',

  'comparison.tolerances.color',
  'comparison.tolerances.size',
  'comparison.tolerances.opacity',
  'comparison.matching.positionTolerance',
  'comparison.confidence.high',
  'comparison.confidence.medium',
  'comparison.confidence.low',
  'comparison.confidence.min',

  'comparison.severity.critical',
  'comparison.severity.high',
  'comparison.severity.medium',

  'comparison.propertyCategories.layout',
  'comparison.propertyCategories.visual',
  'comparison.propertyCategories.typography',
  'comparison.propertyCategories.spacing',
  'comparison.propertyCategories.position',

  'comparison.modes.dynamic.ignoredProperties',
  'comparison.modes.dynamic.compareTextContent',
  'comparison.modes.dynamic.tolerances',
  'comparison.modes.static.ignoredProperties',
  'comparison.modes.static.compareTextContent',
  'comparison.modes.static.tolerances',

  'normalization.cache.enabled',
  'normalization.cache.maxEntries',
  'normalization.rounding.decimals',

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

  'storage.maxReports',
  'storage.reportKey',
  'storage.logsKey',
  'storage.stateKey',

  'logging.level',
  'logging.persistLogs',
  'logging.maxEntries',
  'logging.slowOperationThreshold',

  'attributes.priority',
  'attributes.supplementary',
  'attributes.frameworkPatterns',
  'attributes.dynamicIdPatterns',
  'attributes.dynamicClassPatterns',

  'export.excel.headerColor',
  'export.excel.criticalColor',
  'export.excel.highColor',
  'export.excel.mediumColor',
  'export.excel.lowColor',
  'export.csv.delimiter',
  'export.csv.encoding'
];

const TYPE_EXPECTATIONS = [
  { path: 'extraction.batchSize', type: 'number' },
  { path: 'extraction.perElementTimeout', type: 'number' },
  { path: 'extraction.maxElements', type: 'number' },
  { path: 'extraction.skipInvisible', type: 'boolean' },
  { path: 'extraction.stabilityWindowMs', type: 'number' },
  { path: 'extraction.hardTimeoutMs', type: 'number' },
  { path: 'extraction.initialValueSentinel', type: 'string' },
  { path: 'extraction.irrelevantTags', type: 'array' },
  { path: 'extraction.cssProperties', type: 'array' },
  { path: 'fingerprint.textMaxChars', type: 'number' },
  { path: 'fingerprint.selectorMaxDepth', type: 'number' },
  { path: 'fingerprint.stateClassPattern', type: 'string' },
  { path: 'selectors.xpath.perStrategyTimeout', type: 'number' },
  { path: 'selectors.css.perStrategyTimeout', type: 'number' },
  { path: 'comparison.tolerances.color', type: 'number' },
  { path: 'comparison.tolerances.size', type: 'number' },
  { path: 'comparison.severity.critical', type: 'array' },
  { path: 'comparison.severity.high', type: 'array' },
  { path: 'comparison.severity.medium', type: 'array' },
  { path: 'comparison.modes.dynamic.ignoredProperties', type: 'array' },
  { path: 'infrastructure.circuitBreaker.failureThreshold', type: 'number' },
  { path: 'infrastructure.circuitBreaker.cooldownPeriod', type: 'number' },
  { path: 'infrastructure.timeout.default', type: 'number' },
  { path: 'logging.slowOperationThreshold', type: 'number' },
  { path: 'attributes.priority', type: 'array' },
  { path: 'attributes.frameworkPatterns', type: 'array' }
];

const SANITY_CHECKS = [
  { path: 'extraction.batchSize', min: 1, max: 100 },
  { path: 'extraction.perElementTimeout', min: 10, max: 5000 },
  { path: 'extraction.maxElements', min: 100, max: 100000 },
  { path: 'extraction.stabilityWindowMs', min: 100, max: 10000 },
  { path: 'extraction.hardTimeoutMs', min: 1000, max: 30000 },
  { path: 'fingerprint.textMaxChars', min: 10, max: 1000 },
  { path: 'fingerprint.selectorMaxDepth', min: 2, max: 20 },
  { path: 'selectors.xpath.perStrategyTimeout', min: 10, max: 2000 },
  { path: 'selectors.css.perStrategyTimeout', min: 5, max: 1000 },
  { path: 'comparison.tolerances.color', min: 0, max: 255 },
  { path: 'comparison.tolerances.size', min: 0, max: 100 },
  { path: 'infrastructure.circuitBreaker.failureThreshold', min: 1, max: 100 },
  { path: 'infrastructure.timeout.default', min: 100, max: 300000 },
  { path: 'logging.slowOperationThreshold', min: 50, max: 30000 }
];

function checkRequiredPaths(errors) {
  for (const path of REQUIRED_PATHS) {
    try {
      const value = get(path);
      if (value === null || value === undefined) {
        errors.push(`[Config] "${path}" is null/undefined`);
      }
    } catch (err) {
      errors.push(`[Config] "${path}" does not exist — ${err.message}`);
    }
  }
}

function checkTypeExpectations(errors) {
  for (const { path, type } of TYPE_EXPECTATIONS) {
    try {
      const value = get(path);
      const actual = Array.isArray(value) ? 'array' : typeof value;
      if (actual !== type) {
        errors.push(`[Config] "${path}" expected ${type}, got ${actual}`);
      }
    } catch {
      // already caught in checkRequiredPaths
    }
  }
}

function checkSanityRanges(errors) {
  for (const { path, min, max } of SANITY_CHECKS) {
    try {
      const value = get(path);
      if (typeof value === 'number' && (value < min || value > max)) {
        errors.push(`[Config] "${path}" value ${value} is outside expected range [${min}, ${max}]`);
      }
    } catch {
      // already caught in checkRequiredPaths
    }
  }
}

function validateConfig({ throwOnError = true } = {}) {
  const errors = [];

  checkRequiredPaths(errors);
  checkTypeExpectations(errors);
  checkSanityRanges(errors);

  const valid = errors.length === 0;

  if (!valid) {
    const summary = `Config validation failed with ${errors.length} error(s):\n` +
      errors.map(e => `  • ${e}`).join('\n');

    if (throwOnError) {
      throw new Error(summary);
    } else {
      logger.error('Config validation failed', { errors, summary });
    }
  }

  return { valid, errors };
}

export { validateConfig };
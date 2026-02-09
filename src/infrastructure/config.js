// Configuration System
// Single source of truth for all settings
// Validates config on startup (fail fast)
// Prevents accidental mutations (frozen)

// DEFAULT CONFIGURATION
const defaults = {
  // Extraction Pipeline
  extraction: {
    timeout: 150, // ms - max time per element enrichment
    batchSize: 10, // elements to process concurrently
    maxRetries: 3, // retry attempts on transient failures
    skipInvisible: true, // ignore hidden elements
    maxDepth: 100, // max DOM traversal depth
  },

  // Normalization Engine
  normalization: {
    colorTolerance: 5,        // % - RGB distance threshold (0-100)
    sizeTolerance: 3,         // px - size difference threshold
    enableCaching: true,      // cache normalized values
    cacheMaxSize: 1000,       // max cached entries
    
    // Which properties to normalize
    colorProperties: [
      'color', 'background-color', 'border-color', 
      'outline-color', 'text-decoration-color'
    ],
    sizeProperties: [
      'width', 'height', 'font-size', 'line-height',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'border-width', 'border-radius',
      'top', 'right', 'bottom', 'left',
      'gap', 'row-gap', 'column-gap',
      'min-width', 'max-width', 'min-height', 'max-height'
    ]
  },

  // Selector Generation
  selectors: {
    xpath: {
      maxStrategies: 22, // total strategies (tiers 0-22)
      earlyExitAfter: 1, // stop after N valid candidates
      strategyTimeout: 100, // ms per strategy
      totalTimeout: 2000, // overall XPath generation limit
    },
    css: {
      maxStrategies: 10,
      strategyTimeout: 50,
      totalTimeout: 500,
    },
    minRobustnessScore: 50, // reject selectors below this score
  },

  // Comparison Engine
  comparison: {
    matchStrategy: 'css', // 'xpath' | 'css' | 'hybrid'

    // CSS Property Taxonomy
    cssPropertyCategories: {
      structural: [
        'display', 'position', 'flex-direction',
        'grid-template-columns', 'grid-template-rows'
      ],

      // Static mode only - can vary with content
      spacing: [
        'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'gap'
      ],

      // Ignore in dynamic mode - content-driven
      dimensions: [
        'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height'
      ],

      // Always compare - visual polish matters
      visual: [
        'background', 'background-color', 'border', 'border-radius', 'box-shadow'
      ],

      // Static mode only
      typography: [
        'font-family', 'font-weight', 'font-size', 'text-align', 'line-height'
      ],
    },

    // Never compare these (both modes)
    alwaysIgnoreProperties: [
      'textContent', 'innerText', 'value', 'src', 'href'
    ],

    similarityThreshold: 0.85, // 0-1 scale for fuzzy matching
  },

  // Storage
  storage: {
    keys: {
      reports: 'page_comparator_reports',
      settings: 'page_comparator_settings',
      logs: 'page_comparator_logs',
      errors: 'page_comparator_errors',
    },
    maxReports: 50, // warn when exceeding
    quotaWarningPercent: 80, // % of 10MB Chrome limit
    enableOptimisticLocking: true, // prevent concurrent write conflicts
    maxLockRetries: 3,
  },

  // Logging
  logging: {
    level: 'info', // 'debug' | 'info' | 'warn' | 'error'
    persistLogs: false, // save to storage for export
    maxEntries: 1000, // circular buffer size
    includeStackTraces: true,
    flushBatchSize: 10, // batch writes to storage
  },

  // Error Tracking
  errors: {
    deduplicate: true, // prevent error spam
    maxUniqueErrors: 100, // LRU eviction
    captureElementSnapshot: true, // include element data in errors
  },

  // Performance
  performance: {
    enableMetrics: true, // use performance.mark() API
    slowOperationThreshold: 500, // ms - log slow operations
    metricsSampleRate: 0.1, // sample 10% of operations
  },

  // UI
  ui: {
    debounceDelay: 300, // ms for search inputs
    maxListItems: 100, // virtual scroll threshold
    animationDuration: 200, // ms
  },
};


// VALIDATION RULES

// Validate config structure and types
function validateConfig(config) {
  const errors = [];

  // Check if value exists and matches type
  const check = (path, value, validator, errorMsg) => {
    if (!validator(value)) {
      errors.push(`Invalid config at ${path}: ${errorMsg}`);
    }
  };

  // Extraction validation
  check('extraction.timeout', config.extraction?.timeout,
    v => typeof v === 'number' && v > 0, 'must be positive number');
  check('extraction.batchSize', config.extraction?.batchSize,
    v => typeof v === 'number' && v >= 1 && v <= 100, 'must be 1-100');

  // Normalization validation
  check('normalization.colorTolerance', config.normalization?.colorTolerance,
    v => typeof v === 'number' && v >= 0 && v <= 100, 'must be 0-100');
  check('normalization.sizeTolerance', config.normalization?.sizeTolerance,
    v => typeof v === 'number' && v >= 0, 'must be >= 0');
  check('normalization.cacheMaxSize', config.normalization?.cacheMaxSize,
    v => typeof v === 'number' && v > 0, 'must be positive');

  // Selectors validation
  check('selectors.xpath.earlyExitAfter', config.selectors?.xpath?.earlyExitAfter,
    v => typeof v === 'number' && v > 0, 'must be positive number');
  check('selectors.minRobustnessScore', config.selectors?.minRobustnessScore,
    v => typeof v === 'number' && v >= 0 && v <= 100, 'must be 0-100');

  // Comparison validation
  check('comparison.matchStrategy', config.comparison?.matchStrategy,
    v => ['xpath', 'css', 'hybrid'].includes(v), 'must be xpath|css|hybrid');
  check('comparison.cssPropertyCategories', config.comparison?.cssPropertyCategories,
    v => v && typeof v === 'object', 'must be object');
  check('comparison.similarityThreshold', config.comparison?.similarityThreshold,
    v => typeof v === 'number' && v >= 0 && v <= 1, 'must be 0-1');

  // Logging validation
  check('logging.level', config.logging?.level,
    v => ['debug', 'info', 'warn', 'error'].includes(v), 'must be debug|info|warn|error');

  return {
    valid: errors.length === 0,
    errors,
  };
}

// CONFIG CLASS

class Config {
  constructor() {
    this._config = {};
    this._frozen = false;
  }

  // Initialize config (call once at startup)
  init(overrides = {}) {
    if (this._frozen) {
      throw new Error('Config already initialized');
    }

    // Merge defaults with overrides
    this._config = this._deepMerge(defaults, overrides);

    // Validate
    const validation = validateConfig(this._config);
    if (!validation.valid) {
      throw new Error(`Invalid config: ${validation.errors.join(', ')}`);
    }

    // Freeze to prevent changes
    this._frozen = true;
    Object.freeze(this._config);

    return this;
  }

  // Get config value by path
  get(path, fallback = undefined) {
    const keys = path.split('.');
    let value = this._config;

    for (const key of keys) {
      value = value?.[key];
      if (value === undefined) {
        return fallback;
      }
    }

    return value;
  }

  // Get entire config section
  getSection(section) {
    return this._config[section] || {};
  }

  // Get all config (use sparingly)
  getAll() {
    return this._config;
  }

  // Deep merge two objects
  _deepMerge(target, source) {
    const result = { ...target };

    for (const key in source) {
      if (source[key] instanceof Object && !Array.isArray(source[key])) {
        result[key] = this._deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }

    return result;
  }
}

export default new Config();
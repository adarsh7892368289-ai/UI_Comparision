const rawConfig = {

  // EXTRACTION 
  extraction: {
    batchSize:          50,     
    perElementTimeout:  200,    
    maxElements:        10000,
    skipInvisible:      true,

    irrelevantTags: [
      'SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT', 'BR', 'HR',
      'HEAD', 'TITLE', 'BASE', 'TEMPLATE', 'SLOT'
    ],

    // Full 72-property list — only these properties are extracted per element
    cssProperties: [
      // Layout
      'display', 'position', 'float', 'clear',
      'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
      // Spacing
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'margin-top',  'margin-right',  'margin-bottom',  'margin-left',
      // Border
      'border-top-width',    'border-right-width',  'border-bottom-width',  'border-left-width',
      'border-top-style',    'border-right-style',  'border-bottom-style',  'border-left-style',
      'border-top-color',    'border-right-color',  'border-bottom-color',  'border-left-color',
      'border-top-left-radius', 'border-top-right-radius',
      'border-bottom-right-radius', 'border-bottom-left-radius',
      // Typography
      'font-family', 'font-size', 'font-weight', 'font-style',
      'line-height', 'letter-spacing', 'word-spacing',
      'text-align', 'text-decoration', 'text-transform',
      'white-space', 'word-wrap', 'word-break', 'vertical-align',
      // Visual
      'color', 'background-color', 'background-image',
      'box-shadow', 'text-shadow', 'opacity', 'visibility',
      // Position
      'top', 'right', 'bottom', 'left', 'z-index',
      // Overflow & scroll
      'overflow', 'overflow-x', 'overflow-y',
      // Flex
      'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
      'justify-content', 'align-items', 'align-content', 'align-self', 'gap',
      // Grid
      'grid-template-columns', 'grid-template-rows', 'grid-gap',
      'grid-column', 'grid-row',
      // Transform
      'transform', 'transform-origin',
      // Outline
      'outline', 'outline-width', 'outline-style', 'outline-color'
    ]
  },

  // SELECTORS 
  selectors: {
    xpath: {
      perStrategyTimeout: 80,     
      totalTimeout:       500,
      enableFallback:     true
    },
    css: {
      perStrategyTimeout: 50,     
      totalTimeout:       300,
      enableFallback:     true
    },
    minRobustnessScore: 50
  },

  // COMPARISON 
  comparison: {
    matching: {
      strategies:          ['testid', 'id', 'css', 'xpath', 'position'],
      confidenceThreshold: 0.5,
      positionTolerance:   50     
    },

    // Per-channel tolerance for color comparisons (0–255 scale)
    tolerances: {
      color:   5,     // RGB delta per channel 
      size:    3,     // px absolute difference 
      opacity: 0.01
    },

    // Severity tiers — drive SeverityAnalyzer
    severity: {
      critical: [
        'display', 'visibility', 'position', 'z-index'
      ],
      high: [
        'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
        'color', 'background-color', 'opacity',
        'font-size', 'font-family', 'font-weight'
      ],
      medium: [
        'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'border-top-width', 'border-bottom-width', 'border-left-width', 'border-right-width',
        'border-top-color', 'border-bottom-color', 'border-left-color', 'border-right-color',
        'line-height', 'text-align', 'font-style'
      ]
      // Everything not in critical/high/medium → 'low'
    },

    // Property categories for differ.js
    propertyCategories: {
      layout: [
        'display', 'position', 'float', 'clear',
        'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height'
      ],
      visual: [
        'color', 'background-color', 'border-top-color', 'border-right-color',
        'border-bottom-color', 'border-left-color', 'opacity', 'visibility',
        'box-shadow', 'text-shadow'
      ],
      typography: [
        'font-family', 'font-size', 'font-weight', 'font-style',
        'line-height', 'text-align', 'text-decoration', 'letter-spacing', 'word-spacing'
      ],
      spacing: [
        'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'padding-top', 'padding-right', 'padding-bottom', 'padding-left'
      ],
      position: ['top', 'right', 'bottom', 'left', 'z-index']
    },

    // Comparison modes — drive dynamic-mode.js / static-mode.js
    modes: {
      dynamic: {
        // Properties whose differences are expected and should be ignored
        ignoredProperties: [
          'background-image', 'background-position', 'background-size',
          'background-repeat', 'background-attachment',
          'content', 'cursor', 'pointer-events', 'user-select',
          'outline', 'caret-color',
          'transform', 'transform-origin', 'transform-style',
          'transition', 'transition-property', 'transition-duration',
          'transition-timing-function', 'transition-delay',
          'animation', 'animation-name', 'animation-duration',
          'animation-timing-function', 'animation-delay',
          'animation-iteration-count', 'animation-direction',
          'animation-fill-mode', 'animation-play-state',
          'will-change', 'contain',
          'scroll-behavior', 'touch-action', 'overscroll-behavior',
          'overflow', 'overflow-x', 'overflow-y',
          'filter', 'backdrop-filter',
          'object-fit', 'object-position'
        ],
        compareTextContent: false,
        structuralOnlyAttributes: [
          'role', 'aria-label', 'aria-labelledby', 'aria-describedby',
          'type', 'name', 'data-testid', 'data-test', 'data-qa', 'data-cy'
        ],
        tolerances: { color: 8, size: 5, opacity: 0.05 }
      },
      static: {
        ignoredProperties: [],
        compareTextContent: true,
        tolerances: { color: 5, size: 3, opacity: 0.01 }
      }
    },

    // Confidence thresholds for matcher 
    confidence: {
      high:   0.9,
      medium: 0.7,
      low:    0.5,
      min:    0.5
    }
  },

  // NORMALIZATION 
  normalization: {
    cache: {
      enabled:     true,
      maxEntries:  1000,
      evictionPolicy: 'LRU'
    },
    rounding: {
      decimals: 2   
    }
  },

  // INFRASTRUCTURE 
  infrastructure: {
    circuitBreaker: {
      failureThreshold: 5,      
      cooldownPeriod:   5000,   
      resetTimeout:     30000   
    },
    retry: {
      maxRetries: 3,    
      baseDelay:  100,  
      maxDelay:   5000  
    },
    timeout: {
      default:       5000,   
      extraction:    200,    
      tabLoad:       30000,  
      contentScript: 60000   
    }
  },

  // STORAGE 
  storage: {
    maxReports:  50,
    reportKey:   'page_comparator_reports',
    logsKey:     'page_comparator_logs',
    stateKey:    'page_comparator_state'
  },

  // LOGGING 
  logging: {
    level:        'info',
    persistLogs:  true,
    maxEntries:   1000,
    slowOperationThreshold: 500  
  },

  // ATTRIBUTES 
  attributes: {
    // Highest priority — test automation hooks
    priority: [
      'data-testid', 'data-test', 'data-qa', 'data-cy',
      'data-automation-id', 'data-key', 'data-record-id',
      'data-component-id', 'data-row-key-value'
    ],
    // Supplementary stable attributes
    supplementary: [
      'role', 'type', 'href', 'for', 'value',
      'placeholder', 'name', 'aria-label'
    ],
    // Angular, Vue, React, LWC generated attribute patterns (filter out)
    frameworkPatterns: [
      '^ng-',
      '^_ngcontent',
      '^_nghost',
      '^v-',
      '^data-v-[a-f0-9]+$',
      '^jsx-',
      '^data-reactid',
      '^data-react-'
    ],
    // ID patterns that indicate a dynamic/generated value (not stable)
    dynamicIdPatterns: [
      '^\\d+$',
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      '^\\d{13,}$',
      '^[a-f0-9]{32,}$',
      '^(ember|react|vue|angular)\\d+$',
      '^uid-\\d+$',
      '^temp[-_]?\\d+$',
      '-\\d{2,}$'
    ],
    // Class patterns that indicate CSS-in-JS generated values
    dynamicClassPatterns: [
      '^Mui[A-Z]\\w+-\\w+-\\d+$',
      '^makeStyles-',
      '^css-[a-z0-9]+$',
      '^jss\\d+$',
      '^sc-[a-z]+-[a-z]+$',
      '^emotion-\\d+$',
      '^lwc-[a-z0-9]+'
    ]
  },

  // EXPORT 
  export: {
    defaultFilename: 'comparison-report',
    excel: {
      headerColor:    '4472C4',
      criticalColor:  'FF4444',
      highColor:      'FF9800',
      mediumColor:    'FFD700',
      lowColor:       'FFFFFF',
      maxCellLength:  32767      // Excel hard limit
    },
    csv: {
      delimiter: ',',
      encoding:  'utf-8-bom'    // BOM prefix for Excel auto-detect
    }
  }
};

// DEEP FREEZE 

function deepFreeze(obj) {
  Object.freeze(obj);
  for (const prop of Object.getOwnPropertyNames(obj)) {
    const val = obj[prop];
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

// RUNTIME STATE 

let config = deepFreeze(JSON.parse(JSON.stringify(rawConfig)));

// DEEP MERGE 

function mergeDeep(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key])
    ) {
      target[key] = target[key] || {};
      mergeDeep(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

// PUBLIC API 

/**
 * Override config for testing or feature flagging.
 * Returns the new frozen config.
 */
function init(overrides = {}) {
  const merged = JSON.parse(JSON.stringify(rawConfig));
  mergeDeep(merged, overrides);
  config = deepFreeze(merged);
  return config;
}

/**
 * Read a config value by dot-notation path.
 * Throws if path not found and no fallback provided.
 *
 * @param {string} path       e.g. 'infrastructure.timeout.default'
 * @param {*}      [fallback] returned when path missing (suppresses throw)
 */
function get(path, fallback) {
  const segments = path.split('.');
  let current = config;

  for (const seg of segments) {
    if (current === undefined || current === null) {
      if (fallback !== undefined) return fallback;
      throw new Error(`[Config] Path not found: "${path}" (failed at "${seg}")`);
    }
    current = current[seg];
  }

  if (current === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`[Config] Path not found: "${path}"`);
  }

  return current;
}

export { config, get, init };
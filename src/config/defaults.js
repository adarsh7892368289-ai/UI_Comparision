const rawConfig = {
  extraction: {
    batchSize: 10,
    perElementTimeout: 200,
    maxElements: 10000,
    skipInvisible: true,
    irrelevantTags: [
      'SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT', 'BR', 'HR'
    ],
    cssProperties: [
      'display', 'position', 'float', 'clear',
      'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
      'top', 'right', 'bottom', 'left',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
      'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
      'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
      'border-top-left-radius', 'border-top-right-radius',
      'border-bottom-right-radius', 'border-bottom-left-radius',
      'font-family', 'font-size', 'font-weight', 'font-style',
      'line-height', 'letter-spacing', 'word-spacing',
      'text-align', 'text-decoration', 'text-transform',
      'vertical-align', 'white-space', 'word-wrap', 'word-break',
      'color', 'background-color', 'background-image',
      'box-shadow', 'opacity', 'visibility',
      'z-index', 'overflow', 'overflow-x', 'overflow-y',
      'flex-direction', 'flex-wrap', 'justify-content',
      'align-items', 'align-content', 'gap',
      'grid-template-columns', 'grid-template-rows', 'grid-gap',
      'transform', 'transform-origin'
    ]
  },
  
  selectors: {
    xpath: {
      strategies: 22,
      timeout: 500,
      perStrategyTimeout: 50,
      enableCache: true,
      parallelExecution: true
    },
    css: {
      strategies: 10,
      timeout: 300,
      perStrategyTimeout: 30,
      parallelExecution: true
    },
    minRobustnessScore: 50
  },
  
  comparison: {
    matching: {
      strategies: ['testid', 'id', 'css', 'xpath', 'position'],
      confidenceThreshold: 0.5,
      positionTolerance: 10
    },
    colorTolerance: 5,
    sizeTolerance: 3,
    timeout: 30000
  },
  
  normalization: {
    cache: {
      enabled: true,
      maxEntries: 1000,
      evictionPolicy: 'LRU',
      separateAbsoluteRelative: true
    },
    rounding: {
      decimals: 2
    }
  },
  
  storage: {
    maxReports: 50,
    reportKey: 'page_comparator_reports',
    logsKey: 'page_comparator_logs',
    maxLogEntries: 1000,
    stateKey: 'page_comparator_state'
  },
  
  logging: {
    level: 'info',
    persistLogs: true,
    maxEntries: 1000,
    console: {
      enabled: true,
      colors: {
        debug: '#888',
        info: '#4CAF50',
        warn: '#FF9800',
        error: '#F44336'
      }
    }
  }
};

function deepFreeze(obj) {
  Object.freeze(obj);
  Object.getOwnPropertyNames(obj).forEach(prop => {
    if (obj[prop] !== null
      && (typeof obj[prop] === 'object' || typeof obj[prop] === 'function')
      && !Object.isFrozen(obj[prop])) {
      deepFreeze(obj[prop]);
    }
  });
  return obj;
}

function getConfigValue(path, obj = config) {
  const segments = path.split('.');
  let current = obj;
  
  for (const segment of segments) {
    if (current === undefined || current === null) {
      throw new Error(`Config path not found: ${path}`);
    }
    current = current[segment];
  }
  
  if (current === undefined) {
    throw new Error(`Config path not found: ${path}`);
  }
  
  return current;
}

let config = deepFreeze({ ...rawConfig });

function init(overrides = {}) {
  const merged = JSON.parse(JSON.stringify(rawConfig));
  
  function mergeDeep(target, source) {
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        target[key] = target[key] || {};
        mergeDeep(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
  }
  
  mergeDeep(merged, overrides);
  config = deepFreeze(merged);
  return config;
}

function get(path, fallback) {
  try {
    return getConfigValue(path);
  } catch (error) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

export { config, get, init };
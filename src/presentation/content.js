// Content script to extract web elements from the page
import { generateBestCSS } from '../domain/selectors/css-generator.js';
import { generateBestXPath } from '../domain/selectors/xpath-generator.js';
import config from '../infrastructure/config.js';
import errorTracker, { ErrorCodes } from '../infrastructure/error-tracker.js';
import logger from '../infrastructure/logger.js';
import { safeExecute } from '../infrastructure/safe-execute.js';

// Create maps at module level
const XPATH_TIER_MAP = new Map([
  ['exact-text', 0],
  ['test-attr', 1],
  ['stable-id', 2],
  ['normalized-text', 3],
  ['preceding-sibling', 4],
  ['parent-descendant', 5],
  ['attr-text', 6],
  ['following-anchor', 7],
  ['framework', 8],
  ['multi-attr', 9],
  ['role-aria-label', 10],
  ['label', 11],
  ['partial-text', 12],
  ['href', 13],
  ['parent-child', 14],
  ['sibling', 15],
  ['semantic-ancestor', 16],
  ['class-attr-combo', 17],
  ['ancestor-chain', 18],
  ['table-row', 19],
  ['svg', 20],
  ['spatial-text', 21],
  ['guaranteed-path', 22]
]);

const CSS_TIER_MAP = new Map([
  ['id', 1],
  ['data-attr', 2],
  ['combined-data', 3],
  ['type-name', 4],
  ['class-attr', 5],
  ['parent-child', 6],
  ['descendant', 7],
  ['pseudo', 8],
  ['nth-child', 9],
  ['nth-type', 10]
]);


// Initialize infrastructure
config.init();
logger.init();
errorTracker.init();

// Set context for all logs from this script
logger.setContext({ 
  script: 'content',
  url: window.location.href 
});

logger.info('Content script initialized', { 
  url: window.location.href,
  title: document.title 
});

//Message listener - handles requests from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  logger.debug('Received message', { action: request.action });

  if (request.action === 'extractElements') {
    extractAllElements()
      .then(data => {
        logger.info('Extraction completed', { 
          totalElements: data.totalElements,
          duration: data.duration 
        });
        sendResponse({ success: true, data });
      })
      .catch(error => {
        logger.error('Extraction failed', { 
          error: error.message,
          stack: error.stack 
        });
        
        errorTracker.logError(
          ErrorCodes.EXTRACTION_TIMEOUT,
          'Failed to extract elements',
          { url: window.location.href, error: error.message }
        );
        
        sendResponse({ 
          success: false, 
          error: error.message 
        });
      });
    
    return true;
  }
});

//Extract element data without timeout protection
async function extractAllElements() {
  const startTime = performance.now();

  logger.info('Starting element extraction');

  const elements = [];
  const allElements = document.querySelectorAll('*');
  const excludeTags = ['SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT', 'BR', 'HR'];

  const batchSize = config.get('extraction.batchSize', 10);
  let elementIndex = 0; // Track index separately

  // Convert to array for batching
  const elementsArray = Array.from(allElements).filter(
    el => !excludeTags.includes(el.tagName)
  );

  // Process in batches with yielding
  for (let i = 0; i < elementsArray.length; i += batchSize) {
    const batch = elementsArray.slice(i, i + batchSize);

    // Create indices for this batch
    const batchIndices = batch.map((_, idx) => elementIndex + idx);

    // Process batch in parallel with correct indices
    const batchResults = await Promise.all(
      batch.map((element, idx) => extractElementData(element, batchIndices[idx]))
    );

    // Filter nulls and add to results
    elements.push(...batchResults.filter(Boolean));

    // Update index for next batch
    elementIndex += batchResults.filter(Boolean).length;

    // Yield to main thread every batch
    if (i + batchSize < elementsArray.length) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  const duration = performance.now() - startTime;

  logger.info('Extraction complete', {
    totalElements: elements.length,
    duration: Math.round(duration)
  });

  return {
    url: window.location.href,
    title: document.title,
    timestamp: new Date().toISOString(),
    totalElements: elements.length,
    duration: Math.round(duration),
    elements
  };
}

//Extract data from a single element
async function extractElementData(element, index) {
  const timeout = config.get('extraction.timeout', 150);
  
  const data = await safeExecute(
    () => extractElementDataUnsafe(element, index),
    { 
      timeout,
      fallback: null,
      operation: 'extractElement' 
    }
  );
  
  return data;
}

//Extract element data without timeout protection
async function extractElementDataUnsafe(element, index) {
  const [xpathResult, cssResult] = await Promise.all([
    generateBestXPath(element),
    generateBestCSS(element)
  ]);
  
  // Extract selector strings from results
  let xpathStr = xpathResult?.xpath || null;
  let cssStr = cssResult?.cssSelector || null;
  
  //Fallback selectors if advanced generation fails
  if (!xpathStr) {
    xpathStr = getXPath(element);
  }
  if (!cssStr) {
    cssStr = getCssSelector(element);
  }

  if (!xpathStr && !cssStr) {
    logger.debug('Skipping element without selectors', {
      index,
      tagName: element.tagName
    });
    return null;
  }

  const rect = element.getBoundingClientRect();
  const isVisible = isElementVisible(element);
  
  const skipInvisible = config.get('extraction.skipInvisible', true);
  if (skipInvisible && !isVisible) {
    logger.debug('Skipping invisible element', { 
      index,
      tagName: element.tagName 
    });
    return null;
  }

  // Extract computed CSS styles
  const styles = extractComputedStyles(element);
  
  // Extract attributes as object for matcher
  const attributesObj = {};
  for (const attr of element.attributes) {
    if (attr.name && attr.value) {
      attributesObj[attr.name] = attr.value;
    }
  }

  return {
    index,
    tagName: element.tagName,
    id: element.id || '',
    className: element.className || '',
    type: element.type || '',
    name: element.name || '',
    textContent: element.textContent?.substring(0, 200) || '',
    href: element.href || '',
    src: element.src || '',
    alt: element.alt || '',
    title: element.title || '',
    value: element.value || '',
    placeholder: element.placeholder || '',
    
    // Selector strings (for backward compatibility & export)
    xpath: xpathStr || '',
    cssSelector: cssStr || '',
    
    // Selector metadata (directly from generators)
    xpathMeta: xpathResult ? {
      strategy: xpathResult.strategy || 'unknown',
      robustness: xpathResult.robustness || 0,
      tier: inferTierFromStrategy(xpathResult.strategy) 
    } : null,
    
    cssMeta: cssResult ? {
      strategy: cssResult.strategy || 'unknown',
      robustness: cssResult.robustness || 0,
      tier: inferTierFromStrategy(cssResult.strategy, 'css')
    } : null,
    
    // Attributes (object for matcher, string for export)
    attributes: attributesObj,
    attributesString: getAttributesString(element),
    
    visible: isVisible,
    
    // Position (object for matcher)
    positionObj: {
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      x: Math.round(rect.left),
      y: Math.round(rect.top)
    },
    
    // Dimensions (string for legacy, object for matcher)
    dimensions: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
    dimensionsObj: {
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    
    styles: styles
  };
}

// Helper: Infer tier from strategy name (XPath strategies)
function inferTierFromStrategy(strategy, type = 'xpath') {
  if (!strategy) return 99;

  const tierMap = type === 'xpath' ? XPATH_TIER_MAP : CSS_TIER_MAP;

  // Find exact match first
  if (tierMap.has(strategy)) {
    return tierMap.get(strategy);
  }

  // Find partial match (strategy contains key)
  for (const [key, tier] of tierMap) {
    if (strategy.includes(key)) return tier;
  }

  return 15; // Default mid-tier
}

//Check if element is visible
function isElementVisible(element) {
  if (!element) return false;
  
  const style = window.getComputedStyle(element);
  
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (style.opacity === '0') return false;
  
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

//Get element attributes as string
function getAttributesString(element) {
  const attrs = [];
  
  for (const attr of element.attributes) {
    if (attr.name && attr.value) {
      attrs.push(`${attr.name}="${attr.value}"`);
    }
  }
  
  return attrs.join(' ');
}

//Extract relevant computed CSS properties
function extractComputedStyles(element) {
  try {
    const computed = window.getComputedStyle(element);

    // Extract only relevant properties (not all 500+)
    const relevantProperties = [
      // Typography
      'font-family', 'font-size', 'font-weight', 'line-height',
      'letter-spacing', 'text-align', 'color',

      // Colors
      'background-color', 'border-color',

      // Spacing
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left',

      // Layout
      'display', 'position', 'width', 'height',
      'flex-direction', 'justify-content', 'align-items',

      // Borders
      'border-width', 'border-style', 'border-radius'
    ];

    const styles = {};

    for (const prop of relevantProperties) {
      const value = computed.getPropertyValue(prop);
      if (value) {
        styles[prop] = value;
      }
    }

    return styles;

  } catch (error) {
    logger.warn('Failed to extract computed styles', {
      tagName: element.tagName,
      error: error.message
    });
    return {};
  }
}

// Fallback XPath generator
function getXPath(element) {
  if (element.id !== '') {
    return `//*[@id="${element.id}"]`;
  }

  if (element === document.body) {
    return '/html/body';
  }

  let ix = 0;
  const siblings = element.parentNode ? element.parentNode.childNodes : [];

  for (let i = 0; i < siblings.length; i++) {
    const sibling = siblings[i];
    if (sibling === element) {
      return getXPath(element.parentNode) + '/' + element.tagName.toLowerCase() + '[' + (ix + 1) + ']';
    }
    if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
      ix++;
    }
  }
}

// Fallback CSS selector generator
function getCssSelector(element) {
  if (element.id) {
    return '#' + element.id;
  }

  if (element.className) {
    const classes = element.className.split(' ').filter(c => c.trim()).join('.');
    if (classes) {
      return element.tagName.toLowerCase() + '.' + classes;
    }
  }

  return element.tagName.toLowerCase();
}

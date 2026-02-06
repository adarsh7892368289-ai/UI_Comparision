// Common Utilities: Shared helpers for XPath and CSS generation
// Pure synchronous functions for text processing, DOM interrogation, and validation

import logger from '../infrastructure/logger.js';

// ==================== TEXT UTILITIES ====================

const WHITESPACE_PATTERN = /\s+/g;
const LINE_BREAKS_PATTERN = /[\r\n\t]+/g;

// Removes line breaks and normalizes whitespace for single-line strings
// Returns cleaned string; safe for null inputs
export function cleanText(text) {
  if (typeof text !== 'string') return '';
  return text.replace(LINE_BREAKS_PATTERN, ' ').replace(WHITESPACE_PATTERN, ' ').trim();
}

// ==================== DOM UTILITIES ====================

// Extracts only data-* attributes for selector generation
// Returns filtered attribute map; excludes non-data attributes
export function getDataAttributes(element) {
  if (!element) return {};
  
  const dataAttrs = {};
  try {
    for (const attr of element.attributes) {
      if (attr.name.startsWith('data-')) {
        dataAttrs[attr.name] = attr.value;
      }
    }
  } catch (error) {
    logger.warn('Failed to get data attributes', { 
      error: error.message,
      element: element.tagName 
    });
  }
  
  return dataAttrs;
}

// Produces a universal tag string suitable for XPath (handles namespaces)
// Contract: Returns tag string; e.g., `*[local-name()='svg']` for SVG elements
export function getUniversalTag(element) {
  const ns = element.namespaceURI;
  
  if (ns === 'http://www.w3.org/2000/svg' || ns === 'http://www.w3.org/1998/Math/MathML') {
    return `*[local-name()='${element.localName}']`;
  }
  
  return element.tagName.toLowerCase();
}

// Extracts simple tag name from universal tag representation
// Contract: Handles selectors using local-name() for namespaces
export function extractTagFromUniversal(tag) {
  return tag.toLowerCase().replace(/\*\s*\[local-name\(\)\s*=\s*'([^']+)'\]/, '$1');
}

// Traverses parent chain with configurable depth limit to prevent infinite loops
// Contract: Returns array of ancestors up to maxDepth; stops at document boundary
export function walkUpTree(element, maxDepth = 7) {
  const parents = [];
  let current = element?.parentElement;
  let depth = 0;

  while (current && depth < maxDepth) {
    parents.push(current);
    current = current.parentElement;
    depth++;
  }

  return parents;
}

// Calculates absolute page coordinates accounting for scroll offset
// Contract: Returns comprehensive position object with 8 coordinate values; never throws
export function getElementPosition(element) {
  if (!element?.getBoundingClientRect) {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }

  try {
    const rect = element.getBoundingClientRect();
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;

    return {
      x: rect.left + scrollLeft,
      y: rect.top + scrollTop,
      width: rect.width,
      height: rect.height,
      top: rect.top + scrollTop,
      left: rect.left + scrollLeft,
      right: rect.right + scrollLeft,
      bottom: rect.bottom + scrollTop
    };
  } catch (error) {
    logger.warn('Failed to get element position', { 
      error: error.message,
      element: element.tagName 
    });
    return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }
}

// Calculates Euclidean distance between element centers using Pythagorean theorem
// Contract: Returns distance in pixels or Infinity for null elements
function calculateCenterPoint(element) {
  const pos = getElementPosition(element);
  return {
    x: pos.x + pos.width / 2,
    y: pos.y + pos.height / 2
  };
}

export function calculateDistance(elem1, elem2) {
  if (!elem1 || !elem2) return Infinity;

  const center1 = calculateCenterPoint(elem1);
  const center2 = calculateCenterPoint(elem2);

  return Math.sqrt(
    Math.pow(center2.x - center1.x, 2) + Math.pow(center2.y - center1.y, 2)
  );
}

// ==================== STABILITY VALIDATORS ====================

// Checks if ID is stable (not auto-generated or framework-managed)
// Contract: Returns false for numeric-only, UUID, framework-prefixed, or dynamic IDs
export function isStableId(id) {
  const UNSTABLE_ID_PATTERNS = [
    /^\d+$/, /^[0-9]{8,}$/, /^[a-f0-9]{8}-[a-f0-9]{4}/i,
    /^(ember|react|vue|angular)\d+$/i, /^uid-\d+$/i, /^temp[-_]?\d+$/i,
    /brandBand_\d+/i, /^gen\d+$/i, /^aura-\d+$/i, 
    /^lightning-\w+-\d+$/i, /^sldsModal\d+$/i, /^forceRecord\w+_\d+$/i,
    /^[0-9]+:[0-9]+;[a-z]$/i, /-\d+-\d+$/, /-\d{2,}$/,
    /lgt-datatable.*-\d+-\d+/i, /check-button-label-\d+-\d+/i,
    /-check-id-\d+-\d+/i, /datatable.*-\d+/i, /-\d+-\d+-\d+/
  ];
  
  if (!id || id.length < 2 || id.length > 200) return false;
  return !UNSTABLE_ID_PATTERNS.some(pattern => pattern.test(id));
}

// Checks if attribute value is stable (not dynamic or generated)
// Contract: Returns false for long numerics, UUIDs, framework signatures
export function isStableValue(value) {
  const UNSTABLE_VALUE_PATTERNS = [
    /^[0-9]{8,}$/, /^[a-f0-9]{8}-[a-f0-9]{4}/i, /data-aura-rendered/i,
    /^ember\d+$/i, /^react\d+$/i, /^\d{13}$/, /^tt-for-\d+$/i,
    /^[0-9]+:[0-9]+;[a-z]$/i, /-\d+-\d+$/
  ];
  
  if (!value || typeof value !== 'string') return false;
  if (value.length < 1 || value.length > 200) return false;
  return !UNSTABLE_VALUE_PATTERNS.some(pattern => pattern.test(value));
}

// Checks if CSS class is stable (not auto-generated by CSS-in-JS or frameworks)
// Contract: Returns false for Material-UI, JSS, Emotion, LWC patterns
export function isStableClass(className) {
  if (!className || typeof className !== 'string' || className.trim().length === 0) {
    return false;
  }

  const trimmed = className.trim();

  const unstablePatterns = [
    /^Mui[A-Z]\w+-\w+-\d+$/, /^makeStyles-/, 
    /^css-[a-z0-9]+$/i, /^jss\d+$/,
    /^[a-z]{1,3}\d{5,}$/i, /^_[a-z0-9]{6,}$/i,
    /^sc-[a-z]+-[a-z]+$/i, /^emotion-\d+$/,
    /^[0-9]+:[0-9]+;[a-z]$/i, /lwc-[a-z0-9]+/i
  ];

  return !unstablePatterns.some(pattern => pattern.test(trimmed));
}

// Checks if text content is static (not dynamic like timestamps, UUIDs, currency)
// Contract: Returns false for numeric-only, dates, loading indicators, money values
export function isStaticText(text) {
  if (!text || typeof text !== 'string') return false;
  if (text.length < 2 || text.length > 200) return false;
  
  const dynamicPatterns = [
    /^\d+$/, /^[0-9]{8,}$/, /^[a-f0-9]{8}-[a-f0-9]{4}/i,
    /^\d{1,2}:\d{2}/, /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
    /^loading/i, /^processing/i, /^\$\d+\.\d{2}$/
  ];
  
  return !dynamicPatterns.some(pattern => pattern.test(text));
}

// ==================== ATTRIBUTE COLLECTION ====================

// Collects stable attributes from element with priority fallbacks
// Contract: Returns array of {name, value} objects; prioritizes test/data attributes
export function collectStableAttributes(element) {
  const attrs = [];
  
  try {
    // Priority 1: Test automation attributes
    const testAttrs = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-automation-id',
                       'data-key', 'data-record-id', 'data-component-id', 'data-row-key-value'];
    for (const attr of testAttrs) {
      const value = element.getAttribute(attr);
      if (value && isStableValue(value)) {
        attrs.push({ name: attr, value });
      }
    }
    
    // Priority 2: Supplementary attributes
    const supplementary = ['role', 'type', 'href', 'for', 'value', 'placeholder', 'class'];
    for (const attr of supplementary) {
      const value = element.getAttribute(attr);
      if (value && isStableValue(value) && !attrs.find(a => a.name === attr)) {
        attrs.push({ name: attr, value });
      }
    }
    
    // Priority 3: All data-* attributes
    const dataAttrs = getDataAttributes(element);
    for (const [name, value] of Object.entries(dataAttrs)) {
      if (isStableValue(value) && !attrs.find(a => a.name === name)) {
        attrs.push({ name, value });
      }
    }
  } catch (error) {
    logger.warn('Failed to collect stable attributes', { 
      error: error.message,
      element: element.tagName 
    });
  }
  
  return attrs;
}

// Returns the highest-priority stable attribute for an element
// Contract: Returns {name, value} object or null
export function getBestAttribute(element) {
  const attrs = collectStableAttributes(element);
  return attrs.length > 0 ? attrs[0] : null;
}

// Collects ancestor elements up to maxDepth that have stable attributes
// Contract: Returns array of {element, attr, depth} objects
export function getStableAncestorChain(element, maxDepth) {
  const ancestors = [];
  let current = element.parentElement;
  let depth = 0;
  
  while (current && depth < maxDepth) {
    const attr = getBestAttribute(current);
    if (attr) {
      ancestors.push({ element: current, attr, depth });
    }
    current = current.parentElement;
    depth++;
  }
  
  return ancestors;
}

// Finds the nearest semantic ancestor (form, nav, main, etc.) for contextual strategies
// Contract: Returns semantic element or null; searches up to 8 levels
export function findBestSemanticAncestor(element) {
  const SEMANTIC_TAGS = [
    'form', 'nav', 'header', 'footer', 'main', 'section', 'article', 
    'aside', 'dialog', 'table', 'fieldset', 'figure'
  ];
  
  let current = element.parentElement;
  let depth = 0;

  while (current && depth < 8) {
    const tag = current.tagName.toLowerCase();

    if (SEMANTIC_TAGS.includes(tag)) {
      const attr = getBestAttribute(current);
      if (attr) return current;
    }

    current = current.parentElement;
    depth++;
  }

  return null;
}

// Finds nearby textual elements for context-based strategies
// Contract: Computes Euclidean distance from element center to candidate text node centers
export function findNearbyTextElements(element, maxDistance = 200) {
  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  
  const textElements = [];
  
  try {
    const candidates = document.querySelectorAll('label, span, div, p, h1, h2, h3, h4, h5, h6, legend, button, a, td, th');
    
    for (const el of candidates) {
      if (el === element || el.contains(element) || element.contains(el)) continue;
      
      const text = cleanText(el.textContent);
      if (!text || text.length === 0 || text.length > 100) continue;
      
      const elRect = el.getBoundingClientRect();
      const elCenterX = elRect.left + elRect.width / 2;
      const elCenterY = elRect.top + elRect.height / 2;
      
      const distance = Math.sqrt(
        Math.pow(elCenterX - centerX, 2) + Math.pow(elCenterY - centerY, 2)
      );
      
      if (distance <= maxDistance) {
        const direction = (elCenterX < centerX || elCenterY < centerY) ? 'before' : 'after';
        textElements.push({ element: el, text, distance, direction });
      }
    }
  } catch (error) {
    logger.warn('Failed to find nearby text elements', { 
      error: error.message,
      element: element.tagName 
    });
  }
  
  return textElements.sort((a, b) => a.distance - b.distance);
}
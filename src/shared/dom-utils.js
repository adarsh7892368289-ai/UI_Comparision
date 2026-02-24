import { get } from '../config/defaults.js';
import logger from '../infrastructure/logger.js';

let _compiledIdPatterns = null;
let _compiledClassPatterns = null;

function getIdPatterns() {
  if (!_compiledIdPatterns) {
    _compiledIdPatterns = get('attributes.dynamicIdPatterns').map(p =>
      typeof p === 'string' ? new RegExp(p) : p
    );
  }
  return _compiledIdPatterns;
}

function getClassPatterns() {
  if (!_compiledClassPatterns) {
    _compiledClassPatterns = get('attributes.dynamicClassPatterns').map(p =>
      typeof p === 'string' ? new RegExp(p) : p
    );
  }
  return _compiledClassPatterns;
}

const WHITESPACE_PATTERN = /\s+/g;
const LINE_BREAKS_PATTERN = /[\r\n\t]+/g;

export function cleanText(text) {
  if (typeof text !== 'string') {return '';}
  return text.replace(LINE_BREAKS_PATTERN, ' ').replace(WHITESPACE_PATTERN, ' ').trim();
}

export function getDataAttributes(element) {
  if (!element) {return {};}
  
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

export function getUniversalTag(element) {
  const ns = element.namespaceURI;
  
  if (ns === 'http://www.w3.org/2000/svg' || ns === 'http://www.w3.org/1998/Math/MathML') {
    return `*[local-name()='${element.localName}']`;
  }
  
  return element.tagName.toLowerCase();
}

export function extractTagFromUniversal(tag) {
  return tag.toLowerCase().replace(/\*\s*\[local-name\(\)\s*=\s*'([^']+)'\]/, '$1');
}

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

function calculateCenterPoint(element) {
  const pos = getElementPosition(element);
  return {
    x: pos.x + pos.width / 2,
    y: pos.y + pos.height / 2
  };
}

export function calculateDistance(elem1, elem2) {
  if (!elem1 || !elem2) {return Infinity;}

  const center1 = calculateCenterPoint(elem1);
  const center2 = calculateCenterPoint(elem2);

  return Math.sqrt(
    Math.pow(center2.x - center1.x, 2) + Math.pow(center2.y - center1.y, 2)
  );
}

export function isStableId(id) {
  if (!id || id.length < 2 || id.length > 200) {return false;}
  return !getIdPatterns().some(pattern => pattern.test(id));
}

export function isStableValue(value) {
  const UNSTABLE_VALUE_PATTERNS = [
    /^[0-9]{8,}$/, /^[a-f0-9]{8}-[a-f0-9]{4}/i, /data-aura-rendered/i,
    /^ember\d+$/i, /^react\d+$/i, /^\d{13}$/, /^tt-for-\d+$/i,
    /^[0-9]+:[0-9]+;[a-z]$/i, /-\d+-\d+$/
  ];
  
  if (!value || typeof value !== 'string') {return false;}
  if (value.length < 1 || value.length > 200) {return false;}
  return !UNSTABLE_VALUE_PATTERNS.some(pattern => pattern.test(value));
}

export function isStableClass(className) {
  if (!className || typeof className !== 'string' || className.trim().length === 0) {
    return false;
  }

  const trimmed = className.trim();

  return !getClassPatterns().some(pattern => pattern.test(trimmed));
}

export function isStaticText(text) {
  if (!text || typeof text !== 'string') {return false;}
  if (text.length < 2 || text.length > 200) {return false;}
  
  const dynamicPatterns = [
    /^\d+$/, /^[0-9]{8,}$/, /^[a-f0-9]{8}-[a-f0-9]{4}/i,
    /^\d{1,2}:\d{2}/, /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
    /^loading/i, /^processing/i, /^\$\d+\.\d{2}$/
  ];
  
  return !dynamicPatterns.some(pattern => pattern.test(text));
}

export function collectStableAttributes(element) {
  const attrs = [];
  
  try {
    const testAttrs = get('attributes.priority');
    for (const attr of testAttrs) {
      const value = element.getAttribute(attr);
      if (value && isStableValue(value)) {
        attrs.push({ name: attr, value });
      }
    }
    
    const supplementary = [...get('attributes.supplementary'), 'class'];
    for (const attr of supplementary) {
      const value = element.getAttribute(attr);
      if (value && isStableValue(value) && !attrs.find(a => a.name === attr)) {
        attrs.push({ name: attr, value });
      }
    }
    
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

export function getBestAttribute(element) {
  const attrs = collectStableAttributes(element);
  return attrs.length > 0 ? attrs[0] : null;
}

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
      if (attr) {return current;}
    }

    current = current.parentElement;
    depth++;
  }

  return null;
}

export function findNearbyTextElements(element, maxDistance = 200) {
  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  
  const textElements = [];
  
  try {
    const candidates = document.querySelectorAll('label, span, div, p, h1, h2, h3, h4, h5, h6, legend, button, a, td, th');
    
    for (const el of candidates) {
      if (el === element || el.contains(element) || element.contains(el)) {continue;}
      
      const text = cleanText(el.textContent);
      if (!text || text.length === 0 || text.length > 100) {continue;}
      
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

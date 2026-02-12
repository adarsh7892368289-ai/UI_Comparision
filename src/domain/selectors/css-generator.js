// CSS Generator: 10-Strategy Cascade with Early Exit
// Returns first unique CSS selector found

import config from '../../infrastructure/config.js';
import errorTracker, { ErrorCodes } from '../../infrastructure/error-tracker.js';
import logger from '../../infrastructure/logger.js';
import { safeExecute } from '../../infrastructure/safe-execute.js';
import { isStableId, walkUpTree } from '../../shared/dom-utils.js';

export function generateBestCSS(element) {
  if (!element || !element.tagName) {
    logger.debug('Invalid element for CSS generation', { element });
    return null;
  }

  const timeout = config.get('selectors.css.totalTimeout', 50);
  
  return safeExecute(
    () => generateBestCSSUnsafe(element),
    { timeout, fallback: null, operation: 'css-generation' }
  );
}

function generateBestCSSUnsafe(element) {
  const startTime = performance.now();
  const tag = element.tagName.toLowerCase();

  // Strategy cascade with early exit
  let result = null;
  
  result = tryStrategy(element, tag, 1, strategy1Id);
  if (result) return buildResult(result, startTime);
  
  result = tryStrategy(element, tag, 2, strategy2DataAttrs);
  if (result) return buildResult(result, startTime);
  
  result = tryStrategy(element, tag, 3, strategy3CombinedData);
  if (result) return buildResult(result, startTime);
  
  result = tryStrategy(element, tag, 4, strategy4TypeName);
  if (result) return buildResult(result, startTime);
  
  result = tryStrategy(element, tag, 5, strategy5ClassAttr);
  if (result) return buildResult(result, startTime);
  
  result = tryStrategy(element, tag, 6, strategy6ParentChild);
  if (result) return buildResult(result, startTime);
  
  result = tryStrategy(element, tag, 7, strategy7Descendant);
  if (result) return buildResult(result, startTime);
  
  result = tryStrategy(element, tag, 8, strategy8Pseudo);
  if (result) return buildResult(result, startTime);
  
  result = tryStrategy(element, tag, 9, strategy9NthChild);
  if (result) return buildResult(result, startTime);
  
  result = tryStrategy(element, tag, 10, strategy10NthType);
  if (result) return buildResult(result, startTime);
  
  errorTracker.logError(ErrorCodes.CSS_GENERATION_FAILED, 'No valid CSS selector found', {
    element: element.tagName, id: element.id
  });
  
  return null;
}

function buildResult(strategyResult, startTime) {
  const duration = performance.now() - startTime;
  const robustness = calculateRobustness(strategyResult.tier);
  
  logger.debug('CSS selector generated', { 
    selector: strategyResult.selector, strategy: strategyResult.strategy, 
    tier: strategyResult.tier, duration: Math.round(duration)
  });
  
  return {
    cssSelector: strategyResult.selector,
    strategy: strategyResult.strategy,
    tier: strategyResult.tier,
    robustness: robustness
  };
}

function calculateRobustness(tier) {
  return Math.max(10, 100 - (tier * 9));
}

// Returns first unique selector from strategy candidates
function tryStrategy(element, tag, tier, strategyFunc) {
  try {
    const candidates = strategyFunc(element, tag);
    
    for (const candidate of candidates) {
      if (isUnique(candidate.selector, element)) {
        return { selector: candidate.selector, strategy: candidate.strategy, tier };
      }
    }
  } catch (error) {
    logger.warn('CSS strategy failed', { error: error.message, element: element.tagName });
  }
  
  return null;
}

// Strategy 1: ID selector
function strategy1Id(element, tag) {
  const selectors = [];
  
  if (element.id && isStableId(element.id)) {
    selectors.push({ selector: `#${escapeCss(element.id)}`, strategy: 'id' });
    selectors.push({ selector: `${tag}#${escapeCss(element.id)}`, strategy: 'id-with-tag' });
  }
  
  return selectors;
}

// Strategy 2: Test automation data attributes
function strategy2DataAttrs(element, tag) {
  const selectors = [];
  const testAttrs = ['data-testid', 'data-test', 'data-qa', 'data-cy'];
  
  for (const attr of testAttrs) {
    const value = element.getAttribute(attr);
    if (value) {
      selectors.push({ selector: `[${attr}="${escapeCss(value)}"]`, strategy: 'data-attribute' });
      break; // Return first match
    }
  }
  
  return selectors;
}

// Strategy 3: Combined data attributes
function strategy3CombinedData(element, tag) {
  const selectors = [];
  
  const dataAttrs = Array.from(element.attributes)
    .filter(a => a.name.startsWith('data-') && a.value)
    .slice(0, 2);
  
  if (dataAttrs.length >= 2) {
    const attrStr = dataAttrs.map(a => `[${a.name}="${escapeCss(a.value)}"]`).join('');
    selectors.push({ selector: `${tag}${attrStr}`, strategy: 'combined-data-attributes' });
  }
  
  return selectors;
}

// Strategy 4: Type and name combination
function strategy4TypeName(element, tag) {
  const selectors = [];
  
  if (element.type && element.name) {
    selectors.push({
      selector: `${tag}[type="${escapeCss(element.type)}"][name="${escapeCss(element.name)}"]`,
      strategy: 'type-name'
    });
  }
  
  if (element.type) {
    selectors.push({
      selector: `${tag}[type="${escapeCss(element.type)}"]`,
      strategy: 'type-only'
    });
  }
  
  return selectors;
}

// Strategy 5: Class attributes
function strategy5ClassAttr(element, tag) {
  const selectors = [];
  const classes = getMeaningfulClasses(element);
  
  if (classes.length > 0) {
    const classStr = classes.slice(0, 2).map(c => `.${escapeCss(c)}`).join('');
    
    selectors.push({ selector: `${tag}${classStr}`, strategy: 'class-attribute' });
    
    if (element.type) {
      selectors.push({
        selector: `${tag}${classStr}[type="${escapeCss(element.type)}"]`,
        strategy: 'class-with-type'
      });
    }
  }
  
  return selectors;
}

// Strategy 6: Parent > child combinator
function strategy6ParentChild(element, tag) {
  const selectors = [];
  const parent = findStableParent(element);
  
  if (!parent) return selectors;
  
  const parentSelector = getParentSelector(parent);
  const childSelector = getChildSelector(element);
  
  selectors.push({
    selector: `${parentSelector} > ${childSelector}`,
    strategy: 'parent-child'
  });
  
  return selectors;
}

// Strategy 7: Descendant combinator
function strategy7Descendant(element, tag) {
  const selectors = [];
  const parent = findStableParent(element);
  
  if (!parent) return selectors;
  
  const parentSelector = getParentSelector(parent);
  const childSelector = getChildSelector(element);
  
  selectors.push({
    selector: `${parentSelector} ${childSelector}`,
    strategy: 'complex-descendant'
  });
  
  return selectors;
}

// Strategy 8: Pseudo-classes
function strategy8Pseudo(element, tag) {
  const selectors = [];
  
  if (element.disabled) {
    selectors.push({ selector: `${tag}:disabled`, strategy: 'pseudo-disabled' });
  }
  
  if (element.required) {
    selectors.push({ selector: `${tag}:required`, strategy: 'pseudo-required' });
  }
  
  if (element.checked !== undefined) {
    selectors.push({ selector: `${tag}:checked`, strategy: 'pseudo-checked' });
  }
  
  return selectors;
}

// Strategy 9: nth-child positional selector
function strategy9NthChild(element, tag) {
  const selectors = [];
  const parent = element.parentElement;
  
  if (!parent) return selectors;
  
  const siblings = Array.from(parent.children);
  const index = siblings.indexOf(element) + 1;
  
  if (index === 0) return selectors;
  
  const parentSelector = getParentSelector(parent);
  
  selectors.push({
    selector: `${parentSelector} > ${tag}:nth-child(${index})`,
    strategy: 'nth-child'
  });
  
  return selectors;
}

// Strategy 10: nth-of-type positional selector
function strategy10NthType(element, tag) {
  const parent = element.parentElement;
  
  if (!parent) {
    return [{ selector: tag, strategy: 'tag-only' }];
  }
  
  const siblings = Array.from(parent.children).filter(e => e.tagName === element.tagName);
  const index = siblings.indexOf(element) + 1;
  
  const parentSelector = getParentSelector(parent);
  
  return [{
    selector: `${parentSelector} > ${tag}:nth-of-type(${index})`,
    strategy: 'nth-of-type'
  }];
}

// Finds first stable parent within 5 levels
function findStableParent(element) {
  const parents = walkUpTree(element, 5);
  
  for (const parent of parents) {
    if (parent.id && isStableId(parent.id)) return parent;
    
    const dataAttr = getFirstDataAttr(parent);
    if (dataAttr) return parent;
    
    const semantic = ['form', 'nav', 'header', 'footer', 'main', 'section', 'article'];
    if (semantic.includes(parent.tagName.toLowerCase())) {
      return parent;
    }
  }
  
  return parents[0] || null;
}

// Builds selector for parent element
function getParentSelector(parent) {
  if (!parent) return 'body';
  
  const tag = parent.tagName.toLowerCase();
  
  if (parent.id && isStableId(parent.id)) {
    return `#${escapeCss(parent.id)}`;
  }
  
  const dataAttr = getFirstDataAttr(parent);
  if (dataAttr) {
    return `${tag}[${dataAttr.name}="${escapeCss(dataAttr.value)}"]`;
  }
  
  const classes = getMeaningfulClasses(parent);
  if (classes.length > 0) {
    return `${tag}.${escapeCss(classes[0])}`;
  }
  
  return tag;
}

// Builds selector for child element
function getChildSelector(element) {
  const tag = element.tagName.toLowerCase();
  
  const dataAttr = getFirstDataAttr(element);
  if (dataAttr) {
    return `${tag}[${dataAttr.name}="${escapeCss(dataAttr.value)}"]`;
  }
  
  if (element.type) {
    return `${tag}[type="${escapeCss(element.type)}"]`;
  }
  
  const classes = getMeaningfulClasses(element);
  if (classes.length > 0) {
    return `${tag}.${escapeCss(classes[0])}`;
  }
  
  return tag;
}

// Finds first data-* attribute
function getFirstDataAttr(element) {
  const attrs = Array.from(element.attributes);
  const dataAttr = attrs.find(a => a.name.startsWith('data-') && a.value);
  return dataAttr || null;
}

// Filters element classes to remove generated/utility classes
function getMeaningfulClasses(element) {
  if (!element.className || typeof element.className !== 'string') {
    return [];
  }
  
  return element.className
    .trim()
    .split(/\s+/)
    .filter(c => c.length > 3)
    .filter(c => !c.match(/^[a-z]\d+$/))
    .filter(c => !['active', 'selected', 'hover', 'focus'].includes(c));
}

// CSS validation utilities
function escapeCss(value) {
  if (typeof value !== 'string') return '';
  return CSS.escape(value);
}

function countCssMatches(selector, context = document) {
  try {
    return context.querySelectorAll(selector).length;
  } catch (error) {
    return 0;
  }
}

function isValidCssSyntax(selector) {
  try {
    document.querySelector(selector);
    return true;
  } catch (error) {
    return false;
  }
}

function isUnique(selector, element) {
  try {
    if (!isValidCssSyntax(selector)) return false;
    
    const count = countCssMatches(selector);
    if (count !== 1) return false;
    
    const result = document.querySelector(selector);
    return result === element;
  } catch (e) {
    return false;
  }
}
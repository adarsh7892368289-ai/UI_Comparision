// ==========================================================================
// CSS Generator: Production 10-Strategy Cascade (Single Selector Output)
// Returns: Single best CSS selector string (null if generation fails)
// Dependencies: common-utils.js only
// ==========================================================================

import { walkUpTree, isStableId, isStableClass } from './common-utils.js';

// ==================== CSS VALIDATION UTILITIES ====================

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

// ==================== MAIN GENERATOR ====================

export function generateBestCSS(element) {
  if (!element || !element.tagName) return null;

  const tag = element.tagName.toLowerCase();

  // Try strategies in tier order - return first unique match
  let result = null;
  
  result = tryStrategy(element, tag, strategy1Id);
  if (result) return result;
  
  result = tryStrategy(element, tag, strategy2DataAttrs);
  if (result) return result;
  
  result = tryStrategy(element, tag, strategy3CombinedData);
  if (result) return result;
  
  result = tryStrategy(element, tag, strategy4TypeName);
  if (result) return result;
  
  result = tryStrategy(element, tag, strategy5ClassAttr);
  if (result) return result;
  
  result = tryStrategy(element, tag, strategy6ParentChild);
  if (result) return result;
  
  result = tryStrategy(element, tag, strategy7Descendant);
  if (result) return result;
  
  result = tryStrategy(element, tag, strategy8Pseudo);
  if (result) return result;
  
  result = tryStrategy(element, tag, strategy9NthChild);
  if (result) return result;
  
  result = tryStrategy(element, tag, strategy10NthType);
  if (result) return result;
  
  return null;
}

// ==================== STRATEGY FUNCTIONS ====================

function tryStrategy(element, tag, strategyFunc) {
  const selectors = strategyFunc(element, tag);
  
  for (const selector of selectors) {
    if (isUnique(selector, element)) {
      return selector;
    }
  }
  
  return null;
}

function strategy1Id(element, tag) {
  const selectors = [];
  
  if (element.id && isStableId(element.id)) {
    selectors.push(`#${escapeCss(element.id)}`);
    selectors.push(`${tag}#${escapeCss(element.id)}`);
  }
  
  return selectors;
}

function strategy2DataAttrs(element, tag) {
  const selectors = [];
  const testAttrs = ['data-testid', 'data-test', 'data-qa', 'data-cy'];
  
  for (const attr of testAttrs) {
    const value = element.getAttribute(attr);
    if (value) {
      selectors.push(`[${attr}="${escapeCss(value)}"]`);
      selectors.push(`${tag}[${attr}="${escapeCss(value)}"]`);
    }
  }
  
  return selectors;
}

function strategy3CombinedData(element, tag) {
  const selectors = [];
  
  const dataAttrs = Array.from(element.attributes)
    .filter(a => a.name.startsWith('data-') && a.value)
    .slice(0, 2);
  
  if (dataAttrs.length >= 2) {
    const attrStr = dataAttrs
      .map(a => `[${a.name}="${escapeCss(a.value)}"]`)
      .join('');
    
    selectors.push(`${tag}${attrStr}`);
  }
  
  return selectors;
}

function strategy4TypeName(element, tag) {
  const selectors = [];
  
  if (element.type && element.name) {
    selectors.push(`${tag}[type="${escapeCss(element.type)}"][name="${escapeCss(element.name)}"]`);
  }
  
  if (element.type) {
    selectors.push(`${tag}[type="${escapeCss(element.type)}"]`);
  }
  
  return selectors;
}

function strategy5ClassAttr(element, tag) {
  const selectors = [];
  const classes = getMeaningfulClasses(element);
  
  if (classes.length > 0) {
    const classStr = classes.slice(0, 2).map(c => `.${escapeCss(c)}`).join('');
    
    selectors.push(`${tag}${classStr}`);
    
    if (element.type) {
      selectors.push(`${tag}${classStr}[type="${escapeCss(element.type)}"]`);
    }
  }
  
  return selectors;
}

function strategy6ParentChild(element, tag) {
  const selectors = [];
  const parent = findStableParent(element);
  
  if (!parent) return selectors;
  
  const parentSelector = getParentSelector(parent);
  const childSelector = getChildSelector(element);
  
  selectors.push(`${parentSelector} > ${childSelector}`);
  
  return selectors;
}

function strategy7Descendant(element, tag) {
  const selectors = [];
  const parent = findStableParent(element);
  
  if (!parent) return selectors;
  
  const parentSelector = getParentSelector(parent);
  const childSelector = getChildSelector(element);
  
  selectors.push(`${parentSelector} ${childSelector}`);
  
  return selectors;
}

function strategy8Pseudo(element, tag) {
  const selectors = [];
  
  if (element.disabled) {
    selectors.push(`${tag}:disabled`);
  }
  
  if (element.required) {
    selectors.push(`${tag}:required`);
  }
  
  if (element.checked !== undefined) {
    selectors.push(`${tag}:checked`);
  }
  
  return selectors;
}

function strategy9NthChild(element, tag) {
  const selectors = [];
  const parent = element.parentElement;
  
  if (!parent) return selectors;
  
  const siblings = Array.from(parent.children);
  const index = siblings.indexOf(element) + 1;
  
  if (index === 0) return selectors;
  
  const parentSelector = getParentSelector(parent);
  
  selectors.push(`${parentSelector} > ${tag}:nth-child(${index})`);
  
  return selectors;
}

function strategy10NthType(element, tag) {
  const parent = element.parentElement;
  
  if (!parent) {
    return [tag];
  }
  
  const siblings = Array.from(parent.children)
    .filter(e => e.tagName === element.tagName);
  const index = siblings.indexOf(element) + 1;
  
  const parentSelector = getParentSelector(parent);
  
  return [`${parentSelector} > ${tag}:nth-of-type(${index})`];
}

// ==================== HELPER FUNCTIONS ====================

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

function getFirstDataAttr(element) {
  const attrs = Array.from(element.attributes);
  const dataAttr = attrs.find(a => a.name.startsWith('data-') && a.value);
  return dataAttr || null;
}

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
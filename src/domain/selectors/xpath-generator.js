// XPath Generator: Production Tournament Engine (Single Selector Output)
// Returns: Single best XPath string (null if generation fails)

import config from '../../infrastructure/config.js';
import errorTracker, { ErrorCodes } from '../../infrastructure/error-tracker.js';
import logger from '../../infrastructure/logger.js';
import { safeExecute } from '../../infrastructure/safe-execute.js';
import {
  cleanText,
  collectStableAttributes,
  extractTagFromUniversal,
  findBestSemanticAncestor,
  findNearbyTextElements,
  getBestAttribute,
  getDataAttributes,
  getStableAncestorChain,
  getUniversalTag,
  isStableClass,
  isStableId,
  isStableValue,
  isStaticText
} from '../../shared/dom-utils.js';

// Main entry point that orchestrates XPath generation using a tournament strategy.
// Executes strategies in priority order, returning the first valid unique XPath within the timeout.
export function generateBestXPath(element) {
  if (!element || !element.tagName) {
    logger.debug('Invalid element for XPath generation', { element });
    return null;
  }

  const timeout = config.get('selectors.xpath.strategyTimeout', 100);
  
  return safeExecute(
    () => generateBestXPathUnsafe(element),
    { timeout, fallback: null, operation: 'xpath-generation' }
  );
}

function generateBestXPathUnsafe(element) {
  const startTime = performance.now();
  const tag = getUniversalTag(element);
  const context = document;
  const totalTimeout = config.get('selectors.xpath.totalTimeout', 2000);

  const allStrategies = buildAllStrategies(element, tag);

  for (const { fn } of allStrategies) {
    if (performance.now() - startTime > totalTimeout) {
      logger.debug('XPath generation timeout', { 
        element: element.tagName,
        duration: Math.round(performance.now() - startTime)
      });
      break;
    }

    try {
      const candidates = fn();
      if (!candidates || candidates.length === 0) continue;

      for (const candidate of candidates) {
        if (!candidate?.xpath) continue;

        const validation = strictValidate(candidate.xpath, element, context);
        if (!validation.isValid || !validation.pointsToTarget) continue;

        const uniqueXPath = validation.isUnique
          ? candidate.xpath
          : ensureUniqueness(candidate.xpath, element, context);

        const finalValidation = strictValidate(uniqueXPath, element, context);
        if (!finalValidation.isUnique || !finalValidation.pointsToTarget) continue;

        const duration = performance.now() - startTime;
        logger.debug('XPath generated', { 
          element: element.tagName,
          duration: Math.round(duration)
        });
        
        return uniqueXPath;
      }
    } catch (error) {
      logger.warn('XPath strategy failed', { 
        error: error.message,
        element: element.tagName 
      });
      continue;
    }
  }

  const fallbackResults = executeFallbackStrategies(element, tag, context);
  if (fallbackResults.length > 0) {
    const duration = performance.now() - startTime;
    logger.debug('XPath generated via fallback', { 
      element: element.tagName,
      duration: Math.round(duration)
    });
    return fallbackResults[0].xpath;
  }
  
  errorTracker.logError(
    ErrorCodes.XPATH_GENERATION_FAILED,
    'No valid XPath found',
    { element: element.tagName, id: element.id }
  );
  
  return null;
}

// ==================== EMBEDDED STRATEGIES (22 TIERS) ====================

class XPathStrategies {
  
  // Tier 0: Exact visible text matching without normalization.
  // Most specific and reliable method for elements with unique readable content.
  static strategyExactVisibleText(element, tag) {
    const results = [];
    const text = cleanText(element.textContent);
    
    if (!text || text.length === 0 || text.length > 150) return results;
    if (!isStaticText(text)) return results;
    
    results.push({ xpath: `//${tag}[text()=${escapeXPath(text)}]` });
    return results;
  }

  // Tier 1: QA/testing-specific data attributes that developers explicitly mark for automation.
  // These are the most reliable indicators as they are intentionally set for selectors.
  static strategyTestAttributes(element, tag) {
    const results = [];
    const testAttrs = ['data-testid', 'data-test', 'data-qa', 'data-cy', 
                       'data-automation-id', 'data-key', 'data-record-id', 
                       'data-component-id', 'data-row-key-value'];
    
    for (const attr of testAttrs) {
      const value = element.getAttribute(attr);
      if (value && isStableValue(value)) {
        results.push({ xpath: `//${tag}[@${attr}=${escapeXPath(value)}]` });
      }
    }
    return results;
  }

  // Tier 2: Element ID attribute which is typically unique and stable within a page.
  // IDs are guaranteed to be unique when properly used, making them highly reliable.
  static strategyStableId(element, tag) {
    const results = [];
    const id = element.id;
    
    if (id && isStableId(id)) {
      results.push({ xpath: `//${tag}[@id=${escapeXPath(id)}]` });
    }
    return results;
  }

  // Tier 3: Normalized text matching that handles whitespace variations in content.
  // Useful for elements where text has multiple spaces, tabs, or line breaks.
  static strategyVisibleTextNormalized(element, tag) {
    const results = [];
    const text = cleanText(element.textContent);
    
    if (!text || text.length === 0 || text.length > 150) return results;
    if (!isStaticText(text)) return results;
    
    results.push({ xpath: `//${tag}[normalize-space()=${escapeXPath(text)}]` });
    return results;
  }

  // Tier 4: Uses preceding sibling element as an anchor point to locate target element.
  // Helpful when the target lacks stable attributes but has a stable reference nearby.
  static strategyPrecedingContext(element, tag) {
    const results = [];
    let sibling = element.previousElementSibling;
    let depth = 0;

    while (sibling && depth < 3) {
      const siblingAttr = getBestAttribute(sibling);
      if (siblingAttr) {
        const siblingTag = getUniversalTag(sibling);
        const elementAttrs = collectStableAttributes(element);
        
        for (const elemAttr of elementAttrs.slice(0, 2)) {
          results.push({
            xpath: `//${siblingTag}[@${siblingAttr.name}=${escapeXPath(siblingAttr.value)}]/following-sibling::${tag}[@${elemAttr.name}=${escapeXPath(elemAttr.value)}]`
          });
        }
      }
      sibling = sibling.previousElementSibling;
      depth++;
    }
    return results;
  }

  // Tier 5: Locates element by traversing up to stable parent, then down to element with identifier.
  // Works well for nested components where the parent is stable but element is not.
  static strategyDescendantContext(element, tag) {
    const results = [];
    let parent = element.parentElement;
    let depth = 0;

    while (parent && depth < 6) {
      const parentAttr = getBestAttribute(parent);
      
      if (parentAttr) {
        const parentTag = getUniversalTag(parent);
        const childAttrs = collectStableAttributes(element);
        
        for (const childAttr of childAttrs.slice(0, 2)) {
          results.push({
            xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/descendant::${tag}[@${childAttr.name}=${escapeXPath(childAttr.value)}]`
          });
        }
      }

      parent = parent.parentElement;
      depth++;
    }
    return results;
  }

  // Tier 6: Combines attribute and text content for unique identification of elements.
  // Reduces false positives when either attribute or text alone is not sufficiently unique.
  static strategyAttrTextCombo(element, tag) {
    const results = [];
    const attrs = collectStableAttributes(element);
    const text = cleanText(element.textContent);
    
    if (attrs.length === 0 || !text || text.length > 80) return results;
    if (!isStaticText(text)) return results;
    
    for (const attr of attrs.slice(0, 2)) {
      results.push({
        xpath: `//${tag}[@${attr.name}=${escapeXPath(attr.value)} and normalize-space()=${escapeXPath(text)}]`
      });
    }
    
    return results;
  }

  // Tier 7: Uses anchored reference elements (with IDs or testids) that come after target element.
  // Provides context-based identification when preceding elements are not available or unstable.
  static strategyFollowingContext(element, tag) {
    const results = [];
    const elementAttrs = collectStableAttributes(element);
    
    const anchors = Array.from(document.querySelectorAll('[id], [data-testid], [data-qa], [data-key]')).slice(0, 15);
    
    for (const anchor of anchors) {
      if (anchor === element) continue;
      
      const anchorAttr = getBestAttribute(anchor);
      if (!anchorAttr) continue;
      
      const position = anchor.compareDocumentPosition(element);
      
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        const anchorTag = getUniversalTag(anchor);
        for (const elemAttr of elementAttrs.slice(0, 1)) {
          results.push({
            xpath: `//${anchorTag}[@${anchorAttr.name}=${escapeXPath(anchorAttr.value)}]/following::${tag}[@${elemAttr.name}=${escapeXPath(elemAttr.value)}]`
          });
        }
      }
    }
    return results;
  }

  // Tier 8: Extracts and uses framework-specific data attributes for identification.
  // Captures custom data attributes added by application frameworks and libraries.
  static strategyFrameworkAttributes(element, tag) {
    const results = [];
    const dataAttrs = getDataAttributes(element);
    
    for (const [attrName, attrValue] of Object.entries(dataAttrs)) {
      if (isStableValue(attrValue)) {
        results.push({ xpath: `//${tag}[@${attrName}=${escapeXPath(attrValue)}]` });
      }
    }
    return results;
  }

  // Tier 9: Combines multiple attributes to create a fingerprint for unique identification.
  // Increases specificity when individual attributes overlap across multiple elements.
  static strategyMultiAttributeFingerprint(element, tag) {
    const results = [];
    const attrs = collectStableAttributes(element);
    
    if (attrs.length >= 2) {
      const [a1, a2] = attrs;
      results.push({
        xpath: `//${tag}[@${a1.name}=${escapeXPath(a1.value)} and @${a2.name}=${escapeXPath(a2.value)}]`
      });
    }
    
    if (attrs.length >= 1) {
      const a1 = attrs[0];
      results.push({ xpath: `//${tag}[@${a1.name}=${escapeXPath(a1.value)}]` });
    }
    return results;
  }

  // Tier 10: Matches elements by ARIA role and aria-label attributes for accessibility context.
  // Useful for identifying accessible interactive elements with semantic meaning.
  static strategyAriaRoleLabel(element, tag) {
    const results = [];
    const role = element.getAttribute('role');
    const ariaLabel = element.getAttribute('aria-label');
    
    if (role && ariaLabel && isStableValue(ariaLabel)) {
      results.push({
        xpath: `//${tag}[@role=${escapeXPath(role)} and @aria-label=${escapeXPath(ariaLabel)}]`
      });
    }
    return results;
  }

  // Tier 11: Associates form inputs with their labels to locate elements within labeled contexts.
  // Essential for finding form fields that are logically grouped with descriptive labels.
  static strategyLabelAssociation(element, tag) {
    const results = [];
    const formTags = ['input', 'select', 'textarea'];
    const tagLower = extractTagFromUniversal(tag);
    
    if (!formTags.includes(tagLower)) return results;
    
    const parentLabel = element.closest('label');
    if (parentLabel) {
      const labelText = cleanText(parentLabel.textContent);
      if (labelText && isStaticText(labelText) && labelText.length < 100) {
        const inputType = element.getAttribute('type');
        
        if (inputType) {
          results.push({
            xpath: `//label[normalize-space()=${escapeXPath(labelText)}]/descendant::${tag}[@type=${escapeXPath(inputType)}]`
          });
        }
      }
    }

    return results;
  }

  // Tier 12: Uses substring matching to locate elements with longer text content.
  // Flexible approach that works when exact text matching is too restrictive.
  static strategyPartialTextMatch(element, tag) {
    const results = [];
    const text = cleanText(element.textContent);
    
    if (!text || text.length < 20 || text.length > 200) return results;
    if (!isStaticText(text)) return results;
    
    const partialLength = Math.min(50, Math.floor(text.length * 0.7));
    const partialText = text.substring(0, partialLength);
    
    results.push({ xpath: `//${tag}[contains(text(), ${escapeXPath(partialText)})]` });
    return results;
  }

  // Tier 13: Matches anchor links by combining title attribute and href path pattern.
  // Identifies links based on both their visual title and URL structure for better uniqueness.
  static strategyHrefPattern(element, tag) {
    const results = [];
    const href = element.getAttribute('href');
    
    if (!href || href.startsWith('javascript:')) return results;
    
    const hrefPath = href.split('?')[0];
    const title = element.getAttribute('title');
    
    if (hrefPath.length > 5 && title && isStableValue(title)) {
      results.push({
        xpath: `//a[@title=${escapeXPath(title)} and contains(@href, ${escapeXPath(hrefPath)})]`
      });
    }
    return results;
  }

  // Tier 14: Uses parent element as context and targets descendant by tag type only.
  // Simpler fallback when child-specific identifiers are not available.
  static strategyParentChildAxes(element, tag) {
    const results = [];
    let parent = element.parentElement;
    let depth = 0;

    while (parent && depth < 3) {
      const parentAttr = getBestAttribute(parent);
      
      if (parentAttr) {
        const parentTag = getUniversalTag(parent);
        results.push({
          xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/descendant::${tag}`
        });
      }

      parent = parent.parentElement;
      depth++;
    }
    return results;
  }

  // Tier 15: Locates elements using previous siblings as reference points without additional attributes.
  // Works when siblings are stable anchors but may be less unique than attribute-based methods.
  static strategySiblingAxes(element, tag) {
    const results = [];
    let sibling = element.previousElementSibling;
    let depth = 0;

    while (sibling && depth < 2) {
      const siblingAttr = getBestAttribute(sibling);
      
      if (siblingAttr) {
        const siblingTag = getUniversalTag(sibling);
        results.push({
          xpath: `//${siblingTag}[@${siblingAttr.name}=${escapeXPath(siblingAttr.value)}]/following-sibling::${tag}`
        });
      }

      sibling = sibling.previousElementSibling;
      depth++;
    }
    
    return results;
  }

  // Tier 16: Uses semantically meaningful ancestor elements for context-aware localization.
  // Targets elements based on their logical container relationships in the DOM hierarchy.
  static strategySemanticAncestor(element, tag) {
    const results = [];
    const semanticParent = findBestSemanticAncestor(element);

    if (!semanticParent) return results;
    
    const parentTag = getUniversalTag(semanticParent);
    const parentAttr = getBestAttribute(semanticParent);
    
    if (parentAttr) {
      results.push({
        xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/descendant::${tag}`
      });
    }
    return results;
  }

  // Tier 17: Combines CSS class selectors with attribute predicates for dual-layer matching.
  // Increases precision by leveraging styling classes alongside structural attributes.
  static strategyClassAttributeCombo(element, tag) {
    const results = [];
    const classes = Array.from(element.classList).filter(c => isStableClass(c));
    const attrs = collectStableAttributes(element);
    
    if (classes.length > 0 && attrs.length > 0) {
      const cls = classes[0];
      const attr = attrs[0];
      
      results.push({
        xpath: `//${tag}[contains(@class, ${escapeXPath(cls)}) and @${attr.name}=${escapeXPath(attr.value)}]`
      });
    }
    return results;
  }

  // Tier 18: Chains multiple ancestor elements with stable attributes for robust deep context paths.
  // Useful for deeply nested elements where a single parent context may be insufficient.
  static strategyAncestorChain(element, tag) {
    const results = [];
    const ancestors = getStableAncestorChain(element, 3);
    
    if (ancestors.length === 0) return results;
    
    for (let i = 0; i < ancestors.length; i++) {
      const ancestor = ancestors[i];
      const ancestorTag = getUniversalTag(ancestor.element);
      
      results.push({
        xpath: `//${ancestorTag}[@${ancestor.attr.name}=${escapeXPath(ancestor.attr.value)}]/descendant::${tag}`
      });
    }
    return results;
  }

  // Tier 19 (Fallback): Locates elements within table rows using row attributes for context.
  // Effective for data table cells and elements that are always contained within table rows.
  static strategyTableRowContext(element, tag) {
    const results = [];
    const row = element.closest('tr');
    
    if (!row) return results;
    
    const rowAttrs = collectStableAttributes(row);
    for (const rowAttr of rowAttrs.slice(0, 2)) {
      results.push({
        xpath: `//tr[@${rowAttr.name}=${escapeXPath(rowAttr.value)}]/descendant::${tag}`
      });
    }
    
    return results;
  }

  // Tier 20 (Fallback): Handles SVG elements using namespace-aware XPath syntax for graphic elements.
  // SVG elements require special treatment as they operate within the SVG namespace.
  static strategySVGVisualFingerprint(element, tag) {
    const results = [];
    const isSvgElement = element.namespaceURI === 'http://www.w3.org/2000/svg';
    
    if (isSvgElement) {
      const svgParent = element.tagName.toLowerCase() === 'svg' ? element : element.closest('svg');
      
      if (svgParent) {
        const dataKey = svgParent.getAttribute('data-key');
        if (dataKey && isStableValue(dataKey)) {
          results.push({
            xpath: `//*[local-name()='svg'][@data-key=${escapeXPath(dataKey)}]`
          });
        }
      }
    }
    
    return results;
  }

  // Tier 21 (Fallback): Locates elements using nearby text nodes as spatial reference points.
  // Useful for elements adjacent to stable text content when no direct attributes are available.
  static strategySpatialTextContext(element, tag) {
    const results = [];
    const nearbyTextElements = findNearbyTextElements(element, 200);
    
    for (let i = 0; i < Math.min(nearbyTextElements.length, 3); i++) {
      const textEl = nearbyTextElements[i];
      const textContent = cleanText(textEl.text);
      
      if (!textContent || !isStaticText(textContent) || textContent.length > 80) continue;
      
      const textElTag = getUniversalTag(textEl.element);
      const direction = textEl.direction;
      
      if (direction === 'before') {
        results.push({
          xpath: `//${textElTag}[normalize-space()=${escapeXPath(textContent)}]/following::${tag}`
        });
      }
    }
    
    return results;
  }

  // Tier 22 (Ultimate Fallback): Generates absolute path by walking up DOM tree with position indices.
  // Last-resort strategy that always produces a working path by traversing from root to element.
  static strategyGuaranteedPath(element, tag) {
    const results = [];
    
    if (element.id) {
      results.push({ xpath: `//*[@id=${escapeXPath(element.id)}]` });
    }
    
    const parts = [];
    let current = element;
    
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      const currentTag = getUniversalTag(current);
      
      if (current.id) {
        parts.unshift(`${currentTag}[@id=${escapeXPath(current.id)}]`);
        break;
      }
      
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(e => e.tagName === current.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          parts.unshift(`${currentTag}[${index}]`);
        } else {
          parts.unshift(currentTag);
        }
      } else {
        parts.unshift(currentTag);
      }
      
      current = current.parentElement;
    }
    
    if (parts.length > 0) {
      results.push({ xpath: '//' + parts.join('/') });
    }
    
    return results;
  }
}

// ==================== HELPER FUNCTIONS ====================

// Orchestrates all 22 XPath generation strategies in priority order (tournament).
// Returns array of strategy functions that generate candidates based on their tier ranking.
function buildAllStrategies(element, tag) {
  return [
    { tier: 0, fn: () => XPathStrategies.strategyExactVisibleText(element, tag) },
    { tier: 1, fn: () => XPathStrategies.strategyTestAttributes(element, tag) },
    { tier: 2, fn: () => XPathStrategies.strategyStableId(element, tag) },
    { tier: 3, fn: () => XPathStrategies.strategyVisibleTextNormalized(element, tag) },
    { tier: 4, fn: () => XPathStrategies.strategyPrecedingContext(element, tag) },
    { tier: 5, fn: () => XPathStrategies.strategyDescendantContext(element, tag) },
    { tier: 6, fn: () => XPathStrategies.strategyAttrTextCombo(element, tag) },
    { tier: 7, fn: () => XPathStrategies.strategyFollowingContext(element, tag) },
    { tier: 8, fn: () => XPathStrategies.strategyFrameworkAttributes(element, tag) },
    { tier: 9, fn: () => XPathStrategies.strategyMultiAttributeFingerprint(element, tag) },
    { tier: 10, fn: () => XPathStrategies.strategyAriaRoleLabel(element, tag) },
    { tier: 11, fn: () => XPathStrategies.strategyLabelAssociation(element, tag) },
    { tier: 12, fn: () => XPathStrategies.strategyPartialTextMatch(element, tag) },
    { tier: 13, fn: () => XPathStrategies.strategyHrefPattern(element, tag) },
    { tier: 14, fn: () => XPathStrategies.strategyParentChildAxes(element, tag) },
    { tier: 15, fn: () => XPathStrategies.strategySiblingAxes(element, tag) },
    { tier: 16, fn: () => XPathStrategies.strategySemanticAncestor(element, tag) },
    { tier: 17, fn: () => XPathStrategies.strategyClassAttributeCombo(element, tag) },
    { tier: 18, fn: () => XPathStrategies.strategyAncestorChain(element, tag) }
  ];
}

// Executes fallback strategies for complex scenarios not covered by primary tier strategies.
// Validates each candidate XPath before returning, filtering out invalid paths early.
function executeFallbackStrategies(element, tag, context) {
  const fallbackStrategies = [
    { fn: () => XPathStrategies.strategyTableRowContext(element, tag) },
    { fn: () => XPathStrategies.strategySVGVisualFingerprint(element, tag) },
    { fn: () => XPathStrategies.strategySpatialTextContext(element, tag) },
    { fn: () => XPathStrategies.strategyGuaranteedPath(element, tag) }
  ];

  const validCandidates = [];
  
  for (const { fn } of fallbackStrategies) {
    try {
      const candidates = fn();
      
      for (const candidate of candidates || []) {
        if (!candidate?.xpath) continue;

        const validation = strictValidate(candidate.xpath, element, context);
        if (!validation.isValid || !validation.pointsToTarget) continue;

        const uniqueXPath = validation.isUnique
          ? candidate.xpath
          : ensureUniqueness(candidate.xpath, element, context);

        const finalValidation = strictValidate(uniqueXPath, element, context);
        if (!finalValidation.isUnique || !finalValidation.pointsToTarget) continue;

        validCandidates.push({ xpath: uniqueXPath });
      }
    } catch (error) {
      continue;
    }
  }

  return validCandidates;
}

// Validates XPath against target element by checking uniqueness and correctness of match.
// Returns validation result object with flags indicating validity, uniqueness, and target accuracy.
function strictValidate(xpath, targetElement, context) {
  try {
    const matchCount = countXPathMatches(xpath, context);
    
    if (matchCount === 0) {
      return { isValid: false, isUnique: false, pointsToTarget: false };
    }
    
    if (matchCount > 1) {
      return { isValid: true, isUnique: false, pointsToTarget: false };
    }
    
    const pointsCorrectly = xpathPointsToElement(xpath, targetElement, context);
    
    return {
      isValid: true,
      isUnique: true,
      pointsToTarget: pointsCorrectly
    };
  } catch (error) {
    return { isValid: false, isUnique: false, pointsToTarget: false };
  }
}

// Enhances non-unique XPath by wrapping with ancestor contexts to ensure single match.
// Attempts two strategies: stable ancestor chains first, then direct parent traversal.
function ensureUniqueness(xpath, element, context) {
  const matches = countXPathMatches(xpath, context);
  if (matches === 1) return xpath;

  const ancestors = getStableAncestorChain(element, 4);
  for (const ancestor of ancestors) {
    const ancestorTag = getUniversalTag(ancestor.element);
    const lastSegment = xpath.substring(xpath.lastIndexOf('//'));
    const wrappedXPath = `//${ancestorTag}[@${ancestor.attr.name}=${escapeXPath(ancestor.attr.value)}]${lastSegment}`;

    if (countXPathMatches(wrappedXPath, context) === 1 && xpathPointsToElement(wrappedXPath, element, context)) {
      return wrappedXPath;
    }
  }

  let parent = element.parentElement;
  let depth = 0;

  while (parent && depth < 4) {
    const parentAttr = getBestAttribute(parent);

    if (parentAttr) {
      const parentTag = getUniversalTag(parent);
      const lastSegment = xpath.substring(xpath.lastIndexOf('//'));
      const wrappedXPath = `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]${lastSegment}`;

      if (countXPathMatches(wrappedXPath, context) === 1 && xpathPointsToElement(wrappedXPath, element, context)) {
        return wrappedXPath;
      }
    }

    parent = parent.parentElement;
    depth++;
  }

  return xpath;
}

// ==================== XPATH VALIDATION UTILITIES ====================

// Counts total number of elements matching the given XPath expression in the context.
// Returns -1 on error to distinguish from valid count of 0 matches.
function countXPathMatches(xpath, context = document) {
  try {
    const result = context.evaluate(
      xpath,
      context,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    return result.snapshotLength;
  } catch (error) {
    return -1;
  }
}

// Verifies that the given XPath expression selects exactly the target element when evaluated.
// Critical validation step to ensure XPath is accurate before returning it.
function xpathPointsToElement(xpath, element, context = document) {
  try {
    const result = context.evaluate(
      xpath,
      context,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    return result.singleNodeValue === element;
  } catch (error) {
    return false;
  }
}

// Escapes special characters in XPath string values and uses proper quoting strategy.
// Uses concatenation method for values containing both single and double quotes.
function escapeXPath(value) {
  if (typeof value !== 'string') return '';
  
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  
  const parts = value.split("'");
  const concatParts = [];
  
  parts.forEach((part, index) => {
    if (part) {
      concatParts.push(`'${part}'`);
    }
    if (index < parts.length - 1) {
      concatParts.push(`"'"`);
    }
  });
  
  return concatParts.length > 1 ? `concat(${concatParts.join(',')})` : `'${value}'`;
}
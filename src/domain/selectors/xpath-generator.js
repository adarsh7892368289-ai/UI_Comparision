// XPath Generator: 22-Strategy Tournament with Early-Exit Optimization
// Returns first unique XPath found (not collecting multiple candidates)
// Quality: Full Elements Tracker complexity preserved
// Performance: 4 critical optimizations applied (early exit, caching, validation, limiting)

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

const TIER_ROBUSTNESS_MAP = {
  0: 99, 1: 98, 2: 95, 3: 94, 4: 88, 5: 85, 6: 93, 7: 80, 8: 82, 9: 75,
  10: 76, 11: 80, 12: 72, 13: 74, 14: 68, 15: 64, 16: 64, 17: 60, 18: 58,
  19: 90, 20: 80, 21: 65, 22: 30
};

// Module-level cache for Tier 7 anchor queries (prevents 15,990 redundant DOM scans)
let anchorCache = null;
let anchorCacheTimestamp = 0;
const ANCHOR_CACHE_TTL = 5000;

export function generateBestXPath(element) {
  if (!element || !element.tagName) {
    logger.debug('Invalid element for XPath generation', { element });
    return null;
  }

  const timeout = config.get('selectors.xpath.totalTimeout', 500);
  
  return safeExecute(
    () => generateBestXPathUnsafe(element),
    { timeout, fallback: null, operation: 'xpath-generation' }
  );
}

function generateBestXPathUnsafe(element) {
  const startTime = performance.now();
  const tag = getUniversalTag(element);
  const context = document;
  const totalTimeout = config.get('selectors.xpath.totalTimeout', 500);
  const perStrategyTimeout = 50;

  const allStrategies = buildAllStrategies(element, tag);

  // Tournament loop with early exit after first valid XPath
  for (const { tier, fn, strategyName } of allStrategies) {
    const strategyStartTime = performance.now();
    
    if (performance.now() - startTime > totalTimeout) {
      logger.debug('XPath timeout', { tier, duration: Math.round(performance.now() - startTime) });
      break;
    }

    try {
      const candidates = fn();
      if (!candidates || candidates.length === 0) continue;

      for (const candidate of candidates) {
        if (performance.now() - strategyStartTime > perStrategyTimeout) break;
        if (!candidate?.xpath) continue;

        // Single-pass validation (not double-checking)
        const pointsToTarget = xpathPointsToElement(candidate.xpath, element, context);
        if (!pointsToTarget) continue;

        const matchCount = countXPathMatches(candidate.xpath, context);
        if (matchCount === 0) continue;
        
        let finalXPath = candidate.xpath;
        
        if (matchCount > 1) {
          finalXPath = ensureUniqueness(candidate.xpath, element, context);
          
          const recheckCount = countXPathMatches(finalXPath, context);
          const recheckTarget = xpathPointsToElement(finalXPath, element, context);
          
          if (recheckCount !== 1 || !recheckTarget) continue;
        }

        const duration = performance.now() - startTime;
        const robustness = TIER_ROBUSTNESS_MAP[tier] || 50;
        
        logger.debug('XPath generated', { 
          xpath: finalXPath, strategy: strategyName, tier, robustness, duration: Math.round(duration)
        });
        
        // Return immediately after first valid
        return { xpath: finalXPath, strategy: strategyName, robustness, tier };
      }
    } catch (error) {
      logger.warn('Strategy failed', { error: error.message, strategy: strategyName });
      continue;
    }
  }

  // Fallback strategies (Tiers 19-22)
  const fallbackResults = executeFallbackStrategies(element, tag, context);
  if (fallbackResults.length > 0) {
    const result = fallbackResults[0];
    logger.debug('XPath via fallback', { strategy: result.strategy, tier: result.tier });
    return result;
  }
  
  errorTracker.logError(ErrorCodes.XPATH_GENERATION_FAILED, 'No valid XPath found', { 
    element: element.tagName, id: element.id 
  });
  
  return null;
}

// Strategy implementations (Tiers 0-18)
class XPathStrategies {
  
  // Tier 0: Exact visible text
  static strategyExactVisibleText(element, tag) {
    const results = [];
    const text = cleanText(element.textContent);
    
    if (!text || text.length === 0 || text.length > 150) return results;
    if (!isStaticText(text)) return results;
    
    results.push({ xpath: `//${tag}[text()=${escapeXPath(text)}]` });
    return results;
  }

  // Tier 1: Test attributes (data-testid, data-qa, etc)
  static strategyTestAttributes(element, tag) {
    const results = [];
    const testAttrs = ['data-testid', 'data-test', 'data-qa', 'data-cy', 
                       'data-automation-id', 'data-key', 'data-record-id', 
                       'data-component-id', 'data-row-key-value'];
    
    for (const attr of testAttrs) {
      if (results.length >= 2) break;
      
      const value = element.getAttribute(attr);
      if (value && isStableValue(value)) {
        results.push({ xpath: `//${tag}[@${attr}=${escapeXPath(value)}]` });
      }
    }
    return results;
  }

  // Tier 2: Stable ID
  static strategyStableId(element, tag) {
    const results = [];
    const id = element.id;
    
    if (id && isStableId(id)) {
      results.push({ xpath: `//${tag}[@id=${escapeXPath(id)}]` });
    }
    return results;
  }

  // Tier 3: Normalized text
  static strategyVisibleTextNormalized(element, tag) {
    const results = [];
    const text = cleanText(element.textContent);
    
    if (!text || text.length === 0 || text.length > 150) return results;
    if (!isStaticText(text)) return results;
    
    results.push({ xpath: `//${tag}[normalize-space()=${escapeXPath(text)}]` });
    return results;
  }

  // Tier 4: Preceding sibling context
  static strategyPrecedingContext(element, tag) {
    const results = [];
    let sibling = element.previousElementSibling;
    let depth = 0;

    while (sibling && depth < 2) {
      if (results.length >= 2) break;
      
      const siblingAttr = getBestAttribute(sibling);
      if (siblingAttr) {
        const siblingTag = getUniversalTag(sibling);
        const elementAttrs = collectStableAttributes(element);
        
        for (const elemAttr of elementAttrs.slice(0, 1)) {
          results.push({
            xpath: `//${siblingTag}[@${siblingAttr.name}=${escapeXPath(siblingAttr.value)}]/following-sibling::${tag}[@${elemAttr.name}=${escapeXPath(elemAttr.value)}]`
          });
          break;
        }
      }
      sibling = sibling.previousElementSibling;
      depth++;
    }
    return results;
  }

  // Tier 5: Parent descendant context
  static strategyDescendantContext(element, tag) {
    const results = [];
    let parent = element.parentElement;
    let depth = 0;

    while (parent && depth < 4) {
      if (results.length >= 2) break;
      
      const parentAttr = getBestAttribute(parent);
      
      if (parentAttr) {
        const parentTag = getUniversalTag(parent);
        const childAttrs = collectStableAttributes(element);
        
        for (const childAttr of childAttrs.slice(0, 1)) {
          results.push({
            xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/descendant::${tag}[@${childAttr.name}=${escapeXPath(childAttr.value)}]`
          });
          break;
        }
      }

      parent = parent.parentElement;
      depth++;
    }
    return results;
  }

  // Tier 6: Attribute + text combo
  static strategyAttrTextCombo(element, tag) {
    const results = [];
    const attrs = collectStableAttributes(element);
    const text = cleanText(element.textContent);
    
    if (attrs.length === 0 || !text || text.length > 80) return results;
    if (!isStaticText(text)) return results;
    
    for (const attr of attrs.slice(0, 1)) {
      results.push({
        xpath: `//${tag}[@${attr.name}=${escapeXPath(attr.value)} and normalize-space()=${escapeXPath(text)}]`
      });
      break;
    }
    
    return results;
  }

  // Tier 7: Following anchor context (CACHED)
  static strategyFollowingContext(element, tag) {
    const results = [];
    const elementAttrs = collectStableAttributes(element);
    
    // Cache anchor queries (prevents 15,990 DOM scans)
    const now = Date.now();
    if (!anchorCache || now - anchorCacheTimestamp > ANCHOR_CACHE_TTL) {
      anchorCache = Array.from(document.querySelectorAll('[id], [data-testid], [data-qa], [data-key]'))
        .slice(0, 50);
      anchorCacheTimestamp = now;
    }
    
    const anchors = anchorCache.slice(0, 3);
    
    for (const anchor of anchors) {
      if (results.length >= 2) break;
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
          break;
        }
      }
    }
    return results;
  }

  // Tier 8: Framework attributes
  static strategyFrameworkAttributes(element, tag) {
    const results = [];
    const dataAttrs = getDataAttributes(element);
    
    for (const [attrName, attrValue] of Object.entries(dataAttrs)) {
      if (results.length >= 2) break;
      
      if (isStableValue(attrValue)) {
        results.push({ xpath: `//${tag}[@${attrName}=${escapeXPath(attrValue)}]` });
      }
    }
    return results;
  }

  // Tier 9: Multi-attribute fingerprint
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

  // Tier 10: ARIA role + label
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

  // Tier 11: Label association for form inputs
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

  // Tier 12: Partial text match
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

  // Tier 13: Href pattern
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

  // Tier 14: Parent-child axes
  static strategyParentChildAxes(element, tag) {
    const results = [];
    let parent = element.parentElement;
    let depth = 0;

    while (parent && depth < 2) {
      if (results.length >= 2) break;
      
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

  // Tier 15: Sibling axes
  static strategySiblingAxes(element, tag) {
    const results = [];
    let sibling = element.previousElementSibling;
    let depth = 0;

    while (sibling && depth < 2) {
      if (results.length >= 2) break;
      
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

  // Tier 16: Semantic ancestor
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

  // Tier 17: Class + attribute combo
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

  // Tier 18: Ancestor chain
  static strategyAncestorChain(element, tag) {
    const results = [];
    const ancestors = getStableAncestorChain(element, 2);
    
    if (ancestors.length === 0) return results;
    
    for (let i = 0; i < Math.min(ancestors.length, 2); i++) {
      const ancestor = ancestors[i];
      const ancestorTag = getUniversalTag(ancestor.element);
      
      results.push({
        xpath: `//${ancestorTag}[@${ancestor.attr.name}=${escapeXPath(ancestor.attr.value)}]/descendant::${tag}`
      });
    }
    return results;
  }
}

function buildAllStrategies(element, tag) {
  return [
    { tier: 0, strategyName: 'exact-text', fn: () => XPathStrategies.strategyExactVisibleText(element, tag) },
    { tier: 1, strategyName: 'test-attr', fn: () => XPathStrategies.strategyTestAttributes(element, tag) },
    { tier: 2, strategyName: 'stable-id', fn: () => XPathStrategies.strategyStableId(element, tag) },
    { tier: 3, strategyName: 'normalized-text', fn: () => XPathStrategies.strategyVisibleTextNormalized(element, tag) },
    { tier: 4, strategyName: 'preceding-sibling', fn: () => XPathStrategies.strategyPrecedingContext(element, tag) },
    { tier: 5, strategyName: 'parent-descendant', fn: () => XPathStrategies.strategyDescendantContext(element, tag) },
    { tier: 6, strategyName: 'attr-text', fn: () => XPathStrategies.strategyAttrTextCombo(element, tag) },
    { tier: 7, strategyName: 'following-anchor', fn: () => XPathStrategies.strategyFollowingContext(element, tag) },
    { tier: 8, strategyName: 'framework', fn: () => XPathStrategies.strategyFrameworkAttributes(element, tag) },
    { tier: 9, strategyName: 'multi-attr', fn: () => XPathStrategies.strategyMultiAttributeFingerprint(element, tag) },
    { tier: 10, strategyName: 'role-aria', fn: () => XPathStrategies.strategyAriaRoleLabel(element, tag) },
    { tier: 11, strategyName: 'label', fn: () => XPathStrategies.strategyLabelAssociation(element, tag) },
    { tier: 12, strategyName: 'partial-text', fn: () => XPathStrategies.strategyPartialTextMatch(element, tag) },
    { tier: 13, strategyName: 'href', fn: () => XPathStrategies.strategyHrefPattern(element, tag) },
    { tier: 14, strategyName: 'parent-child', fn: () => XPathStrategies.strategyParentChildAxes(element, tag) },
    { tier: 15, strategyName: 'sibling', fn: () => XPathStrategies.strategySiblingAxes(element, tag) },
    { tier: 16, strategyName: 'semantic', fn: () => XPathStrategies.strategySemanticAncestor(element, tag) },
    { tier: 17, strategyName: 'class-attr', fn: () => XPathStrategies.strategyClassAttributeCombo(element, tag) },
    { tier: 18, strategyName: 'ancestor-chain', fn: () => XPathStrategies.strategyAncestorChain(element, tag) }
  ];
}

// Fallback strategies (Tiers 19-22) - full complexity preserved
function executeFallbackStrategies(element, tag, context) {
  const fallbackStrategies = [
    { tier: 19, strategyName: 'table-row', fn: () => strategyTableRowContext(element, tag) },
    { tier: 20, strategyName: 'svg', fn: () => strategySVGVisualFingerprint(element, tag) },
    { tier: 21, strategyName: 'spatial-text', fn: () => strategySpatialTextContext(element, tag) },
    { tier: 22, strategyName: 'guaranteed-path', fn: () => strategyGuaranteedPath(element, tag) }
  ];

  const validCandidates = [];
  
  for (const { tier, strategyName, fn } of fallbackStrategies) {
    try {
      const candidates = fn();
      
      for (const candidate of candidates || []) {
        if (!candidate?.xpath) continue;

        const pointsToTarget = xpathPointsToElement(candidate.xpath, element, context);
        if (!pointsToTarget) continue;

        const matchCount = countXPathMatches(candidate.xpath, context);
        if (matchCount === 0) continue;
        
        let finalXPath = candidate.xpath;
        
        if (matchCount > 1) {
          finalXPath = ensureUniqueness(candidate.xpath, element, context);
          
          const recheckCount = countXPathMatches(finalXPath, context);
          const recheckTarget = xpathPointsToElement(finalXPath, element, context);
          
          if (recheckCount !== 1 || !recheckTarget) continue;
        }

        const robustness = TIER_ROBUSTNESS_MAP[tier] || 50;
        
        validCandidates.push({ 
          xpath: finalXPath, strategy: strategyName, robustness, tier
        });
        
        return validCandidates; // Return first valid fallback
      }
    } catch (error) {
      continue;
    }
  }

  return validCandidates;
}

// Tier 19: Table row context - FULL IMPLEMENTATION
function strategyTableRowContext(element, tag) {
  const results = [];
  const applicableTags = ['input', 'span', 'td', 'th', 'a', 'button', 'label', 'svg', 'path'];
  const tagLower = extractTagFromUniversal(tag);
  
  if (!applicableTags.includes(tagLower) && !tag.includes('local-name')) return results;
  
  const row = element.closest('tr');
  if (!row) return results;
  
  // Strategy 1: Row attributes
  const rowAttrs = collectStableAttributes(row);
  for (const rowAttr of rowAttrs.slice(0, 2)) {
    const inputType = element.getAttribute('type');
    const elementClass = element.className;
    
    if (elementClass && isStableClass(elementClass)) {
      results.push({
        xpath: `//tr[@${rowAttr.name}=${escapeXPath(rowAttr.value)}]/descendant::${tag}[@class=${escapeXPath(elementClass)}]`
      });
    }
    
    if (inputType) {
      results.push({
        xpath: `//tr[@${rowAttr.name}=${escapeXPath(rowAttr.value)}]/descendant::${tag}[@type=${escapeXPath(inputType)}]`
      });
    }
    
    results.push({
      xpath: `//tr[@${rowAttr.name}=${escapeXPath(rowAttr.value)}]/descendant::${tag}`
    });
  }
  
  // Strategy 2: Row cell text
  const cells = Array.from(row.querySelectorAll('td, th, a'));
  
  for (const cell of cells) {
    if (cell.contains(element) || cell === element) continue;
    
    const cellText = cleanText(cell.textContent);
    if (!cellText || cellText.length === 0 || cellText.length > 100) continue;
    if (!isStaticText(cellText)) continue;
    
    const cellTag = getUniversalTag(cell);
    const elementClass = element.className;
    
    if (elementClass && isStableClass(elementClass)) {
      results.push({
        xpath: `//tr[.//${cellTag}[normalize-space()=${escapeXPath(cellText)}]]/descendant::${tag}[@class=${escapeXPath(elementClass)}]`
      });
    }
    
    results.push({
      xpath: `//tr[.//${cellTag}[normalize-space()=${escapeXPath(cellText)}]]/descendant::${tag}`
    });
  }
  
  return results;
}

// Tier 20: SVG visual fingerprint - FULL IMPLEMENTATION
function strategySVGVisualFingerprint(element, tag) {
  const results = [];
  const tagLower = element.tagName.toLowerCase();
  const isSvgElement = element.namespaceURI === 'http://www.w3.org/2000/svg' || 
                      ['svg', 'path', 'g', 'circle', 'rect'].includes(tagLower);
  
  const svgParent = tagLower === 'svg' ? element : element.closest('svg');
  const isSvgPath = tagLower === 'path' && svgParent;
  
  if (isSvgElement || isSvgPath) {
    if (svgParent) {
      // SVG data-key attribute
      const dataKey = svgParent.getAttribute('data-key');
      if (dataKey && isStableValue(dataKey)) {
        results.push({
          xpath: `//*[local-name()='svg'][@data-key=${escapeXPath(dataKey)}]`
        });
        
        if (isSvgPath && tagLower === 'path') {
          results.push({
            xpath: `//*[local-name()='svg'][@data-key=${escapeXPath(dataKey)}]//*[local-name()='path']`
          });
        }
      }
      
      // SVG in button/interactive parent
      const interactiveParent = svgParent.closest('button, a, [role="button"]');
      if (interactiveParent) {
        const parentAttr = getBestAttribute(interactiveParent);
        if (parentAttr) {
          const parentTag = getUniversalTag(interactiveParent);
          
          results.push({
            xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/descendant::*[local-name()='svg']`
          });
          
          if (isSvgPath && tagLower === 'path') {
            results.push({
              xpath: `//${parentTag}[@${parentAttr.name}=${escapeXPath(parentAttr.value)}]/descendant::*[local-name()='path']`
            });
          }
        }
        
        const ariaLabel = interactiveParent.getAttribute('aria-label');
        if (ariaLabel && isStableValue(ariaLabel)) {
          const parentTag = getUniversalTag(interactiveParent);
          results.push({
            xpath: `//${parentTag}[@aria-label=${escapeXPath(ariaLabel)}]/descendant::*[local-name()='svg']`
          });
        }
      }
      
      // SVG icon classes
      const svgClasses = Array.from(svgParent.classList);
      const iconClasses = svgClasses.filter(c => c.includes('icon') && !c.match(/^icon-\d+$/) && isStableClass(c));
      
      if (iconClasses.length > 0) {
        iconClasses.sort((a, b) => b.length - a.length);
        results.push({
          xpath: `//*[local-name()='svg'][contains(@class, ${escapeXPath(iconClasses[0])})]`
        });
      }
    }
    
    // SVG path data attribute
    if (isSvgPath && tagLower === 'path') {
      const pathD = element.getAttribute('d');
      if (pathD && pathD.length > 20 && pathD.length < 300) {
        results.push({
          xpath: `//*[local-name()='path'][@d=${escapeXPath(pathD)}]`
        });
      }
    }
  }
  
  return results;
}

// Tier 21: Spatial text context - FULL IMPLEMENTATION
function strategySpatialTextContext(element, tag) {
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
      
      const inputType = element.getAttribute('type');
      if (inputType) {
        results.push({
          xpath: `//${textElTag}[normalize-space()=${escapeXPath(textContent)}]/following::${tag}[@type=${escapeXPath(inputType)}]`
        });
      }
    }
    
    if (direction === 'after') {
      results.push({
        xpath: `//${textElTag}[normalize-space()=${escapeXPath(textContent)}]/preceding::${tag}`
      });
    }
  }
  
  return results;
}

// Tier 22: Guaranteed path - FULL IMPLEMENTATION
function strategyGuaranteedPath(element, tag) {
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

// Uniqueness enforcement
function ensureUniqueness(xpath, element, context) {
  const matches = countXPathMatches(xpath, context);
  if (matches === 1) return xpath;

  // Try ancestor wrap
  const ancestors = getStableAncestorChain(element, 2);
  for (const ancestor of ancestors) {
    const ancestorTag = getUniversalTag(ancestor.element);
    const lastSegment = xpath.substring(xpath.lastIndexOf('//'));
    const wrappedXPath = `//${ancestorTag}[@${ancestor.attr.name}=${escapeXPath(ancestor.attr.value)}]${lastSegment}`;

    if (countXPathMatches(wrappedXPath, context) === 1 && xpathPointsToElement(wrappedXPath, element, context)) {
      return wrappedXPath;
    }
  }

  // Try parent wrap
  let parent = element.parentElement;
  let depth = 0;

  while (parent && depth < 2) {
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

// XPath validation utilities
function countXPathMatches(xpath, context = document) {
  try {
    const result = context.evaluate(xpath, context, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    return result.snapshotLength;
  } catch (error) {
    return -1;
  }
}

function xpathPointsToElement(xpath, element, context = document) {
  try {
    const result = context.evaluate(xpath, context, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return result.singleNodeValue === element;
  } catch (error) {
    return false;
  }
}

function escapeXPath(value) {
  if (typeof value !== 'string') return '';
  
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  
  const parts = value.split("'");
  const concatParts = [];
  
  parts.forEach((part, index) => {
    if (part) concatParts.push(`'${part}'`);
    if (index < parts.length - 1) concatParts.push(`"'"`);
  });
  
  return concatParts.length > 1 ? `concat(${concatParts.join(',')})` : `'${value}'`;
}
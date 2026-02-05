// ==========================================================================
// XPath Generator: Production Tournament Engine (Single Selector Output)
// Returns: Single best XPath string (null if generation fails)
// Dependencies: common-utils.js only
// ==========================================================================

import {
  cleanText,
  getDataAttributes,
  getUniversalTag,
  extractTagFromUniversal,
  isStableId,
  isStableValue,
  isStableClass,
  isStaticText,
  collectStableAttributes,
  getBestAttribute,
  getStableAncestorChain,
  findBestSemanticAncestor,
  findNearbyTextElements
} from './common-utils.js';

// ==================== XPATH VALIDATION UTILITIES ====================

function escapeXPath(value) {
  if (typeof value !== 'string') return '';
  
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  
  const parts = value.split("'");
  const escaped = parts.map((part, index) => {
    if (index === 0) return `'${part}'`;
    return `"'",'${part}'`;
  });
  
  return `concat(${escaped.join(',')})`;
}

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

// ==================== EMBEDDED STRATEGIES (22 TIERS) ====================

class XPathStrategies {
  
  static strategyExactVisibleText(element, tag) {
    const results = [];
    const text = cleanText(element.textContent);
    
    if (!text || text.length === 0 || text.length > 150) return results;
    if (!isStaticText(text)) return results;
    
    results.push({ xpath: `//${tag}[text()=${escapeXPath(text)}]` });
    return results;
  }

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

  static strategyStableId(element, tag) {
    const results = [];
    const id = element.id;
    
    if (id && isStableId(id)) {
      results.push({ xpath: `//${tag}[@id=${escapeXPath(id)}]` });
    }
    return results;
  }

  static strategyVisibleTextNormalized(element, tag) {
    const results = [];
    const text = cleanText(element.textContent);
    
    if (!text || text.length === 0 || text.length > 150) return results;
    if (!isStaticText(text)) return results;
    
    results.push({ xpath: `//${tag}[normalize-space()=${escapeXPath(text)}]` });
    return results;
  }

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

// ==================== MAIN GENERATOR ENGINE ====================

export function generateBestXPath(element) {
  if (!element || !element.tagName) return null;

  const startTime = performance.now();
  const tag = getUniversalTag(element);
  const context = document;

  const allStrategies = buildAllStrategies(element, tag);
  const TIMEOUT_MS = 100;

  // Return first valid unique XPath found
  for (const { fn } of allStrategies) {
    if (performance.now() - startTime > TIMEOUT_MS) break;

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

        return uniqueXPath;
      }
    } catch (error) {
      continue;
    }
  }

  // Fallback strategies
  const fallbackResults = executeFallbackStrategies(element, tag, context);
  if (fallbackResults.length > 0) {
    return fallbackResults[0].xpath;
  }
  
  return null;
}

// ==================== HELPER FUNCTIONS ====================

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

function ensureUniqueness(xpath, element, context) {
  const matches = countXPathMatches(xpath, context);
  if (matches === 1) return xpath;

  // Try ancestor wrap
  const ancestors = getStableAncestorChain(element, 4);
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
import {
  cleanText,
  isStableId,
  isStableValue,
  isStaticText,
  getDataAttributes,
  collectStableAttributes,
  getStableAncestorChain,
  findBestSemanticAncestor,
  findNearbyTextElements,
  getUniversalTag
} from '../../../shared/dom-utils.js';
import { escapeXPath } from './validator.js';

const TIER_ROBUSTNESS = {
  0: 99, 1: 98, 2: 95, 3: 94, 4: 88, 5: 85, 6: 93, 7: 80, 8: 82, 9: 75,
  10: 76, 11: 80, 12: 72, 13: 74, 14: 68, 15: 64, 16: 64, 17: 60, 18: 58,
  19: 90, 20: 80, 21: 65, 22: 30
};

class XPathStrategies {

  // Tier 0: Exact visible text
  static tier0ExactText(element, tag) {
    const results = [];
    const text = cleanText(element.textContent);
    if (!text || text.length === 0 || text.length > 150) return results;
    if (!isStaticText(text)) return results;
    results.push({ xpath: `//${tag}[text()=${escapeXPath(text)}]`, strategy: 'exact-text', tier: 0 });
    return results;
  }

  // Tier 1: Test automation attributes
  static tier1TestAttributes(element, tag) {
    const results = [];
    const testAttrs = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-automation-id'];
    for (const attr of testAttrs) {
      const value = element.getAttribute(attr);
      if (value && isStableValue(value)) {
        results.push({ xpath: `//${tag}[@${attr}=${escapeXPath(value)}]`, strategy: 'test-attr', tier: 1 });
      }
    }
    return results;
  }

  // Tier 2: Stable ID
  static tier2StableId(element, tag) {
    const results = [];
    const id = element.id;
    if (id && isStableId(id)) {
      results.push({ xpath: `//${tag}[@id=${escapeXPath(id)}]`, strategy: 'stable-id', tier: 2 });
    }
    return results;
  }

  // Tier 3: Normalized text (normalize-space)
  static tier3NormalizedText(element, tag) {
    const results = [];
    const text = cleanText(element.textContent);
    if (!text || text.length === 0 || text.length > 150) return results;
    if (!isStaticText(text)) return results;
    results.push({ xpath: `//${tag}[normalize-space(.)=${escapeXPath(text)}]`, strategy: 'normalized-text', tier: 3 });
    return results;
  }

  // Tier 4: Stable attributes (data-*, role, type, name, etc.)
  // FIX: collectStableAttributes returns [{name,value}] array — iterate correctly
  static tier4StableAttributes(element, tag) {
    const results = [];
    const stableAttrs = collectStableAttributes(element); // [{name, value}, ...]
    for (const attr of stableAttrs.slice(0, 3)) {
      if (attr && attr.name && attr.value && isStableValue(attr.value)) {
        results.push({ xpath: `//${tag}[@${attr.name}=${escapeXPath(attr.value)}]`, strategy: 'stable-attr', tier: 4 });
      }
    }
    return results;
  }

  // Tier 5: data-* attributes specifically
  static tier5DataAttributes(element, tag) {
    const results = [];
    const dataAttrs = getDataAttributes(element); // {name: value}
    for (const [name, value] of Object.entries(dataAttrs).slice(0, 3)) {
      if (name && value && isStableValue(value)) {
        results.push({ xpath: `//${tag}[@${name}=${escapeXPath(value)}]`, strategy: 'data-attr', tier: 5 });
      }
    }
    return results;
  }

  // Tier 6: Semantic ancestor (form, nav, header, etc.) with stable ID
  static tier6SemanticAncestor(element, tag) {
    const results = [];
    const ancestor = findBestSemanticAncestor(element);
    if (!ancestor) return results;
    const ancestorTag = getUniversalTag(ancestor);
    const ancestorId = ancestor.id;
    if (ancestorId && isStableId(ancestorId)) {
      results.push({ xpath: `//${ancestorTag}[@id=${escapeXPath(ancestorId)}]//${tag}`, strategy: 'semantic-ancestor', tier: 6 });
    }
    return results;
  }

  // Tier 7: Nearby label / preceding text as context
  static tier7NearbyText(element, tag) {
    const results = [];
    const nearbyTexts = findNearbyTextElements(element, 50);
    for (const nearby of nearbyTexts.slice(0, 2)) {
      const text = cleanText(nearby.element.textContent);
      if (text && text.length > 1 && text.length < 50 && isStaticText(text)) {
        const nearbyTag = getUniversalTag(nearby.element);
        results.push({
          xpath: `//${nearbyTag}[normalize-space(.)=${escapeXPath(text)}]/following::${tag}[1]`,
          strategy: 'nearby-text',
          tier: 7
        });
      }
    }
    return results;
  }

  // Tier 8: Sibling with stable ID
  static tier8SiblingContext(element, tag) {
    const results = [];
    const prev = element.previousElementSibling;
    const next = element.nextElementSibling;
    if (prev && prev.id && isStableId(prev.id)) {
      const prevTag = getUniversalTag(prev);
      results.push({ xpath: `//${prevTag}[@id=${escapeXPath(prev.id)}]/following-sibling::${tag}[1]`, strategy: 'sibling-context', tier: 8 });
    }
    if (next && next.id && isStableId(next.id)) {
      const nextTag = getUniversalTag(next);
      results.push({ xpath: `//${nextTag}[@id=${escapeXPath(next.id)}]/preceding-sibling::${tag}[1]`, strategy: 'sibling-context', tier: 8 });
    }
    return results;
  }

  // Tier 9: Closest stable-attribute ancestor as root + descendant tag
  // FIX: getStableAncestorChain returns [{element, attr, depth}] — use anc.element not anc directly
  static tier9AncestorChain(element, tag) {
    const results = [];
    const chain = getStableAncestorChain(element, 3); // [{element, attr, depth}]
    if (chain.length === 0) return results;
    const ancestor = chain[0]; // closest ancestor with a stable attribute
    const ancTag = getUniversalTag(ancestor.element);
    if (ancestor.element.id && isStableId(ancestor.element.id)) {
      results.push({ xpath: `//${ancTag}[@id=${escapeXPath(ancestor.element.id)}]//${tag}`, strategy: 'ancestor-chain', tier: 9 });
    } else if (ancestor.attr && ancestor.attr.name && ancestor.attr.value) {
      results.push({ xpath: `//${ancTag}[@${ancestor.attr.name}=${escapeXPath(ancestor.attr.value)}]//${tag}`, strategy: 'ancestor-chain', tier: 9 });
    }
    return results;
  }

  // Tier 10: type + name (form inputs)
  static tier10TypeAndName(element, tag) {
    const results = [];
    const type = element.getAttribute('type');
    const name = element.getAttribute('name');
    if (type && name && isStableValue(name)) {
      results.push({ xpath: `//${tag}[@type=${escapeXPath(type)} and @name=${escapeXPath(name)}]`, strategy: 'type-name', tier: 10 });
    }
    return results;
  }

  // Tier 11: aria-label
  static tier11AriaLabel(element, tag) {
    const results = [];
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.length > 0 && ariaLabel.length < 100) {
      results.push({ xpath: `//${tag}[@aria-label=${escapeXPath(ariaLabel)}]`, strategy: 'aria-label', tier: 11 });
    }
    return results;
  }

  // Tier 12: Contains first few words of text content
  static tier12PartialText(element, tag) {
    const results = [];
    const text = cleanText(element.textContent);
    if (!text || text.length < 5 || text.length > 200) return results;
    if (!isStaticText(text)) return results;
    const words = text.split(/\s+/).filter(w => w.length > 0);
    if (words.length >= 2) {
      const partial = words.slice(0, Math.min(4, words.length)).join(' ');
      if (partial.length >= 5) {
        results.push({ xpath: `//${tag}[contains(normalize-space(.), ${escapeXPath(partial)})]`, strategy: 'partial-text', tier: 12 });
      }
    }
    return results;
  }

  // Tier 13: Parent with stable ID + indexed direct child
  static tier13ParentWithId(element, tag) {
    const results = [];
    const parent = element.parentElement;
    if (!parent) return results;
    const parentTag = getUniversalTag(parent);
    const parentId = parent.id;
    if (parentId && isStableId(parentId)) {
      const sameTagSiblings = Array.from(parent.children).filter(c => c.tagName === element.tagName);
      if (sameTagSiblings.length === 1) {
        results.push({ xpath: `//${parentTag}[@id=${escapeXPath(parentId)}]/${tag}`, strategy: 'parent-id', tier: 13 });
      } else {
        const idx = sameTagSiblings.indexOf(element) + 1;
        results.push({ xpath: `//${parentTag}[@id=${escapeXPath(parentId)}]/${tag}[${idx}]`, strategy: 'parent-id-indexed', tier: 13 });
      }
    }
    return results;
  }

  // Tier 14: Class combination (stable classes only)
  static tier14ClassCombination(element, tag) {
    const results = [];
    const classAttr = element.getAttribute('class');
    if (!classAttr || !classAttr.trim()) return results;
    const unstablePatterns = [/^Mui[A-Z]/, /^makeStyles-/, /^css-[a-z0-9]+$/i, /^jss\d+$/, /^sc-/, /^emotion-/, /lwc-/i, /^_[a-z0-9]{5,}$/i];
    const stable = classAttr.trim().split(/\s+/).filter(c => c.length >= 2 && !unstablePatterns.some(p => p.test(c)));
    if (stable.length === 0) return results;
    results.push({ xpath: `//${tag}[contains(@class,${escapeXPath(stable[0])})]`, strategy: 'class-single', tier: 14 });
    if (stable.length >= 2) {
      results.push({ xpath: `//${tag}[contains(@class,${escapeXPath(stable[0])}) and contains(@class,${escapeXPath(stable[1])})]`, strategy: 'class-combo', tier: 14 });
    }
    return results;
  }

  // Tier 15: Walk up to find nearest ancestor with any stable attribute
  static tier15AncestorAttributePath(element, tag) {
    const results = [];
    let current = element.parentElement;
    let depth = 0;
    while (current && depth < 5) {
      const currTag = getUniversalTag(current);
      const attrs = collectStableAttributes(current); // [{name, value}]
      if (attrs.length > 0) {
        const attr = attrs[0];
        results.push({ xpath: `//${currTag}[@${attr.name}=${escapeXPath(attr.value)}]//${tag}`, strategy: 'ancestor-attr-path', tier: 15 });
        break;
      }
      current = current.parentElement;
      depth++;
    }
    return results;
  }

  // Tier 16: role attribute
  static tier16RoleAttribute(element, tag) {
    const results = [];
    const role = element.getAttribute('role');
    if (role) {
      results.push({ xpath: `//${tag}[@role=${escapeXPath(role)}]`, strategy: 'role', tier: 16 });
    }
    return results;
  }

  // Tier 17: href or src
  static tier17HrefOrSrc(element, tag) {
    const results = [];
    const href = element.getAttribute('href');
    const src = element.getAttribute('src');
    if (href && href.length > 0 && href.length < 200 && !href.startsWith('javascript:')) {
      results.push({ xpath: `//${tag}[@href=${escapeXPath(href)}]`, strategy: 'href', tier: 17 });
    }
    if (src && src.length > 0 && src.length < 200) {
      results.push({ xpath: `//${tag}[@src=${escapeXPath(src)}]`, strategy: 'src', tier: 17 });
    }
    return results;
  }

  // Tier 18: alt or title
  static tier18AltOrTitle(element, tag) {
    const results = [];
    const alt = element.getAttribute('alt');
    const title = element.getAttribute('title');
    if (alt && alt.length > 0 && alt.length < 150) {
      results.push({ xpath: `//${tag}[@alt=${escapeXPath(alt)}]`, strategy: 'alt', tier: 18 });
    }
    if (title && title.length > 0 && title.length < 150) {
      results.push({ xpath: `//${tag}[@title=${escapeXPath(title)}]`, strategy: 'title', tier: 18 });
    }
    return results;
  }

  // Tier 19: Absolute path (full ancestor chain)
  // FIX: Use same-tag sibling count for position predicates, not all-children count
  static tier19AbsolutePath(element, tag) {
    const results = [];
    let current = element;
    const path = [];
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const parent = current.parentElement;
      if (!parent) {
        path.unshift(getUniversalTag(current));
        break;
      }
      const currTag = getUniversalTag(current);
      // FIX: same-tag siblings only — XPath position predicates are tag-specific
      const sameTag = Array.from(parent.children).filter(c => c.tagName === current.tagName);
      if (sameTag.length === 1) {
        path.unshift(currTag);
      } else {
        const idx = sameTag.indexOf(current) + 1;
        path.unshift(`${currTag}[${idx}]`);
      }
      current = parent;
    }
    if (path.length > 0) {
      results.push({ xpath: `/${path.join('/')}`, strategy: 'absolute-path', tier: 19 });
    }
    return results;
  }

  // Tier 20: Tag position within direct parent
  // FIX: Removed newline from template literal. Use parent.children, not querySelectorAll (deep).
  static tier20TagWithPosition(element, tag) {
    const results = [];
    const parent = element.parentElement;
    if (!parent) return results;
    const directSameTag = Array.from(parent.children).filter(c => c.tagName === element.tagName);
    const index = directSameTag.indexOf(element);
    if (index !== -1) {
      const parentTag = getUniversalTag(parent);
      results.push({ xpath: `//${parentTag}/${tag}[${index + 1}]`, strategy: 'tag-position', tier: 20 });
    }
    return results;
  }

  // Tier 21: Tag position within grandparent > parent context
  static tier21TypePosition(element, tag) {
    const results = [];
    const parent = element.parentElement;
    if (!parent || !parent.parentElement) return results;
    const sameTag = Array.from(parent.children).filter(el => el.tagName === element.tagName);
    const index = sameTag.indexOf(element);
    if (index !== -1) {
      const parentTag = getUniversalTag(parent);
      const grandparentTag = getUniversalTag(parent.parentElement);
      results.push({ xpath: `//${grandparentTag}//${parentTag}/${tag}[${index + 1}]`, strategy: 'type-position', tier: 21 });
    }
    return results;
  }

  // Tier 22: Global document index — last resort
  static tier22FallbackIndex(element) {
    const results = [];
    const allElements = Array.from(document.querySelectorAll('*'));
    const index = allElements.indexOf(element);
    if (index !== -1) {
      results.push({ xpath: `(//*)[${index + 1}]`, strategy: 'fallback-index', tier: 22 });
    }
    return results;
  }
}

function getAllStrategies() {
  return [
    { tier: 0,  fn: (el, tag) => XPathStrategies.tier0ExactText(el, tag),             name: 'exact-text' },
    { tier: 1,  fn: (el, tag) => XPathStrategies.tier1TestAttributes(el, tag),         name: 'test-attr' },
    { tier: 2,  fn: (el, tag) => XPathStrategies.tier2StableId(el, tag),               name: 'stable-id' },
    { tier: 3,  fn: (el, tag) => XPathStrategies.tier3NormalizedText(el, tag),         name: 'normalized-text' },
    { tier: 4,  fn: (el, tag) => XPathStrategies.tier4StableAttributes(el, tag),       name: 'stable-attr' },
    { tier: 5,  fn: (el, tag) => XPathStrategies.tier5DataAttributes(el, tag),         name: 'data-attr' },
    { tier: 6,  fn: (el, tag) => XPathStrategies.tier6SemanticAncestor(el, tag),       name: 'semantic-ancestor' },
    { tier: 7,  fn: (el, tag) => XPathStrategies.tier7NearbyText(el, tag),             name: 'nearby-text' },
    { tier: 8,  fn: (el, tag) => XPathStrategies.tier8SiblingContext(el, tag),         name: 'sibling-context' },
    { tier: 9,  fn: (el, tag) => XPathStrategies.tier9AncestorChain(el, tag),          name: 'ancestor-chain' },
    { tier: 10, fn: (el, tag) => XPathStrategies.tier10TypeAndName(el, tag),           name: 'type-name' },
    { tier: 11, fn: (el, tag) => XPathStrategies.tier11AriaLabel(el, tag),             name: 'aria-label' },
    { tier: 12, fn: (el, tag) => XPathStrategies.tier12PartialText(el, tag),           name: 'partial-text' },
    { tier: 13, fn: (el, tag) => XPathStrategies.tier13ParentWithId(el, tag),          name: 'parent-id' },
    { tier: 14, fn: (el, tag) => XPathStrategies.tier14ClassCombination(el, tag),      name: 'class-combo' },
    { tier: 15, fn: (el, tag) => XPathStrategies.tier15AncestorAttributePath(el, tag), name: 'ancestor-attr' },
    { tier: 16, fn: (el, tag) => XPathStrategies.tier16RoleAttribute(el, tag),         name: 'role' },
    { tier: 17, fn: (el, tag) => XPathStrategies.tier17HrefOrSrc(el, tag),             name: 'href-src' },
    { tier: 18, fn: (el, tag) => XPathStrategies.tier18AltOrTitle(el, tag),            name: 'alt-title' },
    { tier: 19, fn: (el, tag) => XPathStrategies.tier19AbsolutePath(el, tag),          name: 'absolute-path' },
    { tier: 20, fn: (el, tag) => XPathStrategies.tier20TagWithPosition(el, tag),       name: 'tag-position' },
    { tier: 21, fn: (el, tag) => XPathStrategies.tier21TypePosition(el, tag),          name: 'type-position' },
    { tier: 22, fn: (el)      => XPathStrategies.tier22FallbackIndex(el),              name: 'fallback-index' }
  ];
}

export { XPathStrategies, getAllStrategies, TIER_ROBUSTNESS };
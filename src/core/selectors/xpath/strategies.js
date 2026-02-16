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
  
  static tier0ExactText(element, tag) {
    const results = [];
    const text = cleanText(element.textContent);
    
    if (!text || text.length === 0 || text.length > 150) return results;
    if (!isStaticText(text)) return results;
    
    results.push({ 
      xpath: `//${tag}[text()=${escapeXPath(text)}]`,
      strategy: 'exact-text',
      tier: 0
    });
    return results;
  }

  static tier1TestAttributes(element, tag) {
    const results = [];
    const testAttrs = ['data-testid', 'data-test', 'data-qa', 'data-cy'];
    
    for (const attr of testAttrs) {
      const value = element.getAttribute(attr);
      if (value && isStableValue(value)) {
        results.push({
          xpath: `//${tag}[@${attr}='${value}']`,
          strategy: 'test-attr',
          tier: 1
        });
      }
    }
    return results;
  }

  static tier2StableId(element, tag) {
    const results = [];
    const id = element.id;
    
    if (id && isStableId(id)) {
      results.push({
        xpath: `//${tag}[@id='${id}']`,
        strategy: 'stable-id',
        tier: 2
      });
    }
    return results;
  }

  static tier3NormalizedText(element, tag) {
    const results = [];
    const text = cleanText(element.textContent);
    
    if (!text || text.length === 0 || text.length > 150) return results;
    
    const normalized = text.toLowerCase().replace(/\s+/g, ' ');
    results.push({
      xpath: `//${tag}[normalize-space(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'))=${escapeXPath(normalized)}]`,
      strategy: 'normalized-text',
      tier: 3
    });
    return results;
  }

  static tier4StableAttributes(element, tag) {
    const results = [];
    const stableAttrs = collectStableAttributes(element);
    
    for (const [attr, value] of Object.entries(stableAttrs).slice(0, 3)) {
      if (isStableValue(value)) {
        results.push({
          xpath: `//${tag}[@${attr}='${value}']`,
          strategy: 'stable-attr',
          tier: 4
        });
      }
    }
    return results;
  }

  static tier5DataAttributes(element, tag) {
    const results = [];
    const dataAttrs = getDataAttributes(element);
    
    for (const [attr, value] of Object.entries(dataAttrs).slice(0, 3)) {
      if (isStableValue(value)) {
        results.push({
          xpath: `//${tag}[@${attr}='${value}']`,
          strategy: 'data-attr',
          tier: 5
        });
      }
    }
    return results;
  }

  static tier6SemanticAncestor(element, tag) {
    const results = [];
    const ancestor = findBestSemanticAncestor(element);
    
    if (ancestor) {
      const ancestorTag = getUniversalTag(ancestor);
      const ancestorId = ancestor.id;
      
      if (ancestorId && isStableId(ancestorId)) {
        results.push({
          xpath: `//${ancestorTag}[@id='${ancestorId}']//${tag}`,
          strategy: 'semantic-ancestor',
          tier: 6
        });
      }
    }
    return results;
  }

  static tier7NearbyText(element, tag) {
    const results = [];
    const nearbyTexts = findNearbyTextElements(element, 50);
    
    for (const textEl of nearbyTexts.slice(0, 2)) {
      const text = cleanText(textEl.textContent);
      if (text && text.length > 0 && text.length < 50 && isStaticText(text)) {
        results.push({
          xpath: `//${tag}[following::text()[normalize-space()=${escapeXPath(text)}]]`,
          strategy: 'nearby-text',
          tier: 7
        });
      }
    }
    return results;
  }

  static tier8SiblingContext(element, tag) {
    const results = [];
    const prev = element.previousElementSibling;
    const next = element.nextElementSibling;
    
    if (prev) {
      const prevTag = getUniversalTag(prev);
      const prevId = prev.id;
      if (prevId && isStableId(prevId)) {
        results.push({
          xpath: `//${prevTag}[@id='${prevId}']/following-sibling::${tag}[1]`,
          strategy: 'sibling-context',
          tier: 8
        });
      }
    }
    
    if (next) {
      const nextTag = getUniversalTag(next);
      const nextId = next.id;
      if (nextId && isStableId(nextId)) {
        results.push({
          xpath: `//${nextTag}[@id='${nextId}']/preceding-sibling::${tag}[1]`,
          strategy: 'sibling-context',
          tier: 8
        });
      }
    }
    return results;
  }

  static tier9AncestorChain(element, tag) {
    const results = [];
    const chain = getStableAncestorChain(element, 3);
    
    if (chain.length >= 2) {
      const parts = chain.map(anc => {
        const ancTag = getUniversalTag(anc.element);
        if (anc.id && isStableId(anc.id)) {
          return `${ancTag}[@id='${anc.id}']`;
        }
        return ancTag;
      });
      
      results.push({
        xpath: `//${parts.join('//')}`,
        strategy: 'ancestor-chain',
        tier: 9
      });
    }
    return results;
  }

  static tier10TypeAndName(element, tag) {
    const results = [];
    const type = element.getAttribute('type');
    const name = element.getAttribute('name');
    
    if (type && name && isStableValue(name)) {
      results.push({
        xpath: `//${tag}[@type='${type}'][@name='${name}']`,
        strategy: 'type-name',
        tier: 10
      });
    }
    return results;
  }

  static tier11AriaLabel(element, tag) {
    const results = [];
    const ariaLabel = element.getAttribute('aria-label');
    
    if (ariaLabel && ariaLabel.length > 0 && ariaLabel.length < 100) {
      results.push({
        xpath: `//${tag}[@aria-label=${escapeXPath(ariaLabel)}]`,
        strategy: 'aria-label',
        tier: 11
      });
    }
    return results;
  }

  static tier12PartialText(element, tag) {
    const results = [];
    const text = cleanText(element.textContent);
    
    if (text && text.length >= 10 && text.length <= 50) {
      const firstWords = text.split(/\s+/).slice(0, 3).join(' ');
      if (firstWords.length >= 10) {
        results.push({
          xpath: `//${tag}[contains(text(),${escapeXPath(firstWords)})]`,
          strategy: 'partial-text',
          tier: 12
        });
      }
    }
    return results;
  }

  static tier13ParentWithId(element, tag) {
    const results = [];
    const parent = element.parentElement;
    
    if (parent) {
      const parentTag = getUniversalTag(parent);
      const parentId = parent.id;
      
      if (parentId && isStableId(parentId)) {
        results.push({
          xpath: `//${parentTag}[@id='${parentId}']/${tag}`,
          strategy: 'parent-id',
          tier: 13
        });
      }
    }
    return results;
  }

  static tier14ClassCombination(element, tag) {
    const results = [];
    const classes = element.className;
    
    if (typeof classes === 'string' && classes.trim()) {
      const classList = classes.trim().split(/\s+/).slice(0, 3);
      const classPath = classList.map(c => `contains(@class,'${c}')`).join(' and ');
      
      results.push({
        xpath: `//${tag}[${classPath}]`,
        strategy: 'class-combo',
        tier: 14
      });
    }
    return results;
  }

  static tier15DescendantPath(element, tag) {
    const results = [];
    let current = element;
    const path = [];
    
    for (let i = 0; i < 3 && current.parentElement; i++) {
      const currTag = getUniversalTag(current);
      path.unshift(currTag);
      current = current.parentElement;
    }
    
    if (path.length >= 2) {
      results.push({
        xpath: `//${path.join('/')}`,
        strategy: 'descendant-path',
        tier: 15
      });
    }
    return results;
  }

  static tier16RoleAttribute(element, tag) {
    const results = [];
    const role = element.getAttribute('role');
    
    if (role) {
      results.push({
        xpath: `//${tag}[@role='${role}']`,
        strategy: 'role',
        tier: 16
      });
    }
    return results;
  }

  static tier17HrefOrSrc(element, tag) {
    const results = [];
    const href = element.getAttribute('href');
    const src = element.getAttribute('src');
    
    if (href && href.length > 0 && href.length < 200) {
      results.push({
        xpath: `//${tag}[@href='${href}']`,
        strategy: 'href',
        tier: 17
      });
    }
    
    if (src && src.length > 0 && src.length < 200) {
      results.push({
        xpath: `//${tag}[@src='${src}']`,
        strategy: 'src',
        tier: 17
      });
    }
    return results;
  }

  static tier18AltOrTitle(element, tag) {
    const results = [];
    const alt = element.getAttribute('alt');
    const title = element.getAttribute('title');
    
    if (alt && alt.length > 0) {
      results.push({
        xpath: `//${tag}[@alt=${escapeXPath(alt)}]`,
        strategy: 'alt',
        tier: 18
      });
    }
    
    if (title && title.length > 0) {
      results.push({
        xpath: `//${tag}[@title=${escapeXPath(title)}]`,
        strategy: 'title',
        tier: 18
      });
    }
    return results;
  }

  static tier19AbsolutePath(element, tag) {
    const results = [];
    let current = element;
    const path = [];
    
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const parent = current.parentElement;
      if (!parent) break;
      
      const siblings = Array.from(parent.children);
      const index = siblings.indexOf(current) + 1;
      const currTag = getUniversalTag(current);
      
      path.unshift(`${currTag}[${index}]`);
      current = parent;
    }
    
    if (path.length > 0) {
      results.push({
        xpath: `/${path.join('/')}`,
        strategy: 'absolute-path',
        tier: 19
      });
    }
    return results;
  }

  static tier20TagWithPosition(element, tag) {
    const results = [];
    const parent = element.parentElement;
    
    if (parent) {
      const siblings = Array.from(parent.querySelectorAll(tag));
      const index = siblings.indexOf(element);
      
      if (index !== -1) {
        results.push({
          xpath: `(//

${tag})[${index + 1}]`,
          strategy: 'tag-position',
          tier: 20
        });
      }
    }
    return results;
  }

  static tier21TypePosition(element, tag) {
    const results = [];
    const parent = element.parentElement;
    
    if (parent) {
      const siblings = Array.from(parent.children).filter(el => 
        getUniversalTag(el) === tag
      );
      const index = siblings.indexOf(element);
      
      if (index !== -1 && parent.parentElement) {
        const parentTag = getUniversalTag(parent);
        results.push({
          xpath: `//${parentTag}/${tag}[${index + 1}]`,
          strategy: 'type-position',
          tier: 21
        });
      }
    }
    return results;
  }

  static tier22FallbackIndex(element, tag) {
    const results = [];
    const allElements = Array.from(document.querySelectorAll('*'));
    const index = allElements.indexOf(element);
    
    if (index !== -1) {
      results.push({
        xpath: `(//*)[${index + 1}]`,
        strategy: 'fallback-index',
        tier: 22
      });
    }
    return results;
  }
}

function getAllStrategies() {
  return [
    { tier: 0, fn: XPathStrategies.tier0ExactText, name: 'exact-text' },
    { tier: 1, fn: XPathStrategies.tier1TestAttributes, name: 'test-attr' },
    { tier: 2, fn: XPathStrategies.tier2StableId, name: 'stable-id' },
    { tier: 3, fn: XPathStrategies.tier3NormalizedText, name: 'normalized-text' },
    { tier: 4, fn: XPathStrategies.tier4StableAttributes, name: 'stable-attr' },
    { tier: 5, fn: XPathStrategies.tier5DataAttributes, name: 'data-attr' },
    { tier: 6, fn: XPathStrategies.tier6SemanticAncestor, name: 'semantic-ancestor' },
    { tier: 7, fn: XPathStrategies.tier7NearbyText, name: 'nearby-text' },
    { tier: 8, fn: XPathStrategies.tier8SiblingContext, name: 'sibling-context' },
    { tier: 9, fn: XPathStrategies.tier9AncestorChain, name: 'ancestor-chain' },
    { tier: 10, fn: XPathStrategies.tier10TypeAndName, name: 'type-name' },
    { tier: 11, fn: XPathStrategies.tier11AriaLabel, name: 'aria-label' },
    { tier: 12, fn: XPathStrategies.tier12PartialText, name: 'partial-text' },
    { tier: 13, fn: XPathStrategies.tier13ParentWithId, name: 'parent-id' },
    { tier: 14, fn: XPathStrategies.tier14ClassCombination, name: 'class-combo' },
    { tier: 15, fn: XPathStrategies.tier15DescendantPath, name: 'descendant-path' },
    { tier: 16, fn: XPathStrategies.tier16RoleAttribute, name: 'role' },
    { tier: 17, fn: XPathStrategies.tier17HrefOrSrc, name: 'href-src' },
    { tier: 18, fn: XPathStrategies.tier18AltOrTitle, name: 'alt-title' },
    { tier: 19, fn: XPathStrategies.tier19AbsolutePath, name: 'absolute-path' },
    { tier: 20, fn: XPathStrategies.tier20TagWithPosition, name: 'tag-position' },
    { tier: 21, fn: XPathStrategies.tier21TypePosition, name: 'type-position' },
    { tier: 22, fn: XPathStrategies.tier22FallbackIndex, name: 'fallback-index' }
  ];
}

export { XPathStrategies, getAllStrategies, TIER_ROBUSTNESS };
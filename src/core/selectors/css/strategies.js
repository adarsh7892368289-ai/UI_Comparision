import { isStableId, isStableValue, isStableClass } from '../../../shared/dom-utils.js';
import { escapeCss } from './validator.js';

const TIER_ROBUSTNESS = {
  1: 100, 2: 91, 3: 82, 4: 73, 5: 64, 6: 55, 7: 46, 8: 37, 9: 28, 10: 19
};

class CSSStrategies {
  
  static tier1Id(element, tag) {
    const results = [];
    const id = element.id;
    
    if (id && isStableId(id)) {
      results.push({
        selector: `${tag}#${escapeCss(id)}`,
        strategy: 'id',
        tier: 1
      });
    }
    return results;
  }

  static tier2DataAttributes(element, tag) {
    const results = [];
    const testAttrs = ['data-testid', 'data-test', 'data-qa', 'data-cy'];
    
    for (const attr of testAttrs) {
      const value = element.getAttribute(attr);
      if (value && isStableValue(value)) {
        results.push({
          selector: `${tag}[${attr}="${escapeCss(value)}"]`,
          strategy: 'data-attr',
          tier: 2
        });
      }
    }
    return results;
  }

  static tier3CombinedData(element, tag) {
    const results = [];
    const attrs = ['data-testid', 'data-test', 'data-qa'];
    const values = attrs
      .map(attr => ({ attr, value: element.getAttribute(attr) }))
      .filter(({ value }) => value && isStableValue(value))
      .slice(0, 2);

    if (values.length >= 2) {
      const selector = `${tag}` + values
        .map(({ attr, value }) => `[${attr}="${escapeCss(value)}"]`)
        .join('');
      
      results.push({
        selector,
        strategy: 'combined-data',
        tier: 3
      });
    }
    return results;
  }

  static tier4TypeName(element, tag) {
    const results = [];
    const type = element.getAttribute('type');
    const name = element.getAttribute('name');
    
    if (type && name && isStableValue(name)) {
      results.push({
        selector: `${tag}[type="${type}"][name="${escapeCss(name)}"]`,
        strategy: 'type-name',
        tier: 4
      });
    }
    return results;
  }

  static tier5Classes(element, tag) {
    const results = [];
    const classes = element.className;
    
    if (typeof classes === 'string' && classes.trim()) {
      const classList = classes.trim().split(/\s+/)
        .filter(cls => isStableClass(cls))
        .slice(0, 3);
      
      if (classList.length > 0) {
        const selector = `${tag}.${classList.map(escapeCss).join('.')}`;
        results.push({
          selector,
          strategy: 'classes',
          tier: 5
        });
      }
    }
    return results;
  }

  static tier6ParentChild(element, tag) {
    const results = [];
    const parent = element.parentElement;
    
    if (parent) {
      const parentTag = parent.tagName.toLowerCase();
      const parentId = parent.id;
      
      if (parentId && isStableId(parentId)) {
        results.push({
          selector: `${parentTag}#${escapeCss(parentId)} > ${tag}`,
          strategy: 'parent-child',
          tier: 6
        });
      }
    }
    return results;
  }

  static tier7Descendant(element, tag) {
    const results = [];
    const parent = element.parentElement;
    
    if (parent) {
      const parentTag = parent.tagName.toLowerCase();
      const parentId = parent.id;
      
      if (parentId && isStableId(parentId)) {
        results.push({
          selector: `${parentTag}#${escapeCss(parentId)} ${tag}`,
          strategy: 'descendant',
          tier: 7
        });
      }
    }
    return results;
  }

  static tier8Pseudo(element, tag) {
    const results = [];
    const pseudos = [];
    
    if (element.disabled) pseudos.push(':disabled');
    if (element.required) pseudos.push(':required');
    if (element.checked) pseudos.push(':checked');
    if (element.readOnly) pseudos.push(':read-only');
    
    if (pseudos.length > 0) {
      results.push({
        selector: `${tag}${pseudos.join('')}`,
        strategy: 'pseudo',
        tier: 8
      });
    }
    return results;
  }

  static tier9NthChild(element, tag) {
    const results = [];
    const parent = element.parentElement;
    
    if (parent) {
      const siblings = Array.from(parent.children);
      const index = siblings.indexOf(element);
      
      if (index !== -1) {
        results.push({
          selector: `${tag}:nth-child(${index + 1})`,
          strategy: 'nth-child',
          tier: 9
        });
      }
    }
    return results;
  }

  static tier10NthType(element, tag) {
    const results = [];
    const parent = element.parentElement;
    
    if (parent) {
      const siblings = Array.from(parent.children).filter(el => 
        el.tagName.toLowerCase() === tag
      );
      const index = siblings.indexOf(element);
      
      if (index !== -1) {
        results.push({
          selector: `${tag}:nth-of-type(${index + 1})`,
          strategy: 'nth-type',
          tier: 10
        });
      }
    }
    return results;
  }
}

function getAllStrategies() {
  return [
    { tier: 1, fn: CSSStrategies.tier1Id, name: 'id' },
    { tier: 2, fn: CSSStrategies.tier2DataAttributes, name: 'data-attr' },
    { tier: 3, fn: CSSStrategies.tier3CombinedData, name: 'combined-data' },
    { tier: 4, fn: CSSStrategies.tier4TypeName, name: 'type-name' },
    { tier: 5, fn: CSSStrategies.tier5Classes, name: 'classes' },
    { tier: 6, fn: CSSStrategies.tier6ParentChild, name: 'parent-child' },
    { tier: 7, fn: CSSStrategies.tier7Descendant, name: 'descendant' },
    { tier: 8, fn: CSSStrategies.tier8Pseudo, name: 'pseudo' },
    { tier: 9, fn: CSSStrategies.tier9NthChild, name: 'nth-child' },
    { tier: 10, fn: CSSStrategies.tier10NthType, name: 'nth-type' }
  ];
}

export { CSSStrategies, getAllStrategies, TIER_ROBUSTNESS };
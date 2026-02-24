import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';

let frameworkPatternsCache = null;

function getFrameworkPatterns() {
  if (!frameworkPatternsCache) {
    frameworkPatternsCache = get('attributes.frameworkPatterns').map(p =>
      typeof p === 'string' ? new RegExp(p, 'u') : p
    );
  }
  return frameworkPatternsCache;
}

function collectAttributes(element) {
  try {
    const attributes = {};
    const patterns = getFrameworkPatterns();
    const { attributes: attrs } = element;

    for (let i = 0; i < attrs.length; i++) {
      const { name, value } = attrs[i];
      if (!patterns.some(p => p.test(name))) {
        attributes[name] = value;
      }
    }

    return attributes;
  } catch (err) {
    logger.error('Attribute collection failed', {
      tagName: element.tagName,
      error: err.message
    });
    return {};
  }
}

function getPriorityAttributes(element) {
  const priorityList = get('attributes.priority');
  const supplementary = get('attributes.supplementary');
  const allAttrs = [...priorityList, ...supplementary];
  const attributes = {};

  for (const attrName of allAttrs) {
    const value = element.getAttribute(attrName);
    if (value !== null) {
      attributes[attrName] = value;
    }
  }

  return attributes;
}

function hasTestAttribute(element) {
  const priorityList = get('attributes.priority');
  return priorityList.some(attr => element.hasAttribute(attr));
}

export { collectAttributes, getPriorityAttributes, hasTestAttribute };
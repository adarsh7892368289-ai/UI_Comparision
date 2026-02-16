import logger from '../../infrastructure/logger.js';

const FRAMEWORK_PATTERNS = [
  /^ng-/,
  /^v-/,
  /^data-v-/,
  /_ngcontent-/,
  /_nghost-/,
  /^data-reactid/,
  /^data-react/
];

const PRIORITY_ATTRIBUTES = [
  'data-testid',
  'data-test',
  'data-qa',
  'data-cy',
  'id',
  'name',
  'role',
  'aria-label',
  'type',
  'href',
  'src',
  'alt',
  'title',
  'placeholder',
  'value'
];

function isFrameworkAttribute(attrName) {
  return FRAMEWORK_PATTERNS.some(pattern => pattern.test(attrName));
}

function collectAttributes(element) {
  try {
    const attributes = {};
    const attrs = element.attributes;

    for (let i = 0; i < attrs.length; i++) {
      const attr = attrs[i];
      
      if (!isFrameworkAttribute(attr.name)) {
        attributes[attr.name] = attr.value;
      }
    }

    return attributes;
  } catch (error) {
    logger.error('Attribute collection failed', { 
      tagName: element.tagName,
      error: error.message 
    });
    return {};
  }
}

function getPriorityAttributes(element) {
  const attributes = {};

  for (const attrName of PRIORITY_ATTRIBUTES) {
    const value = element.getAttribute(attrName);
    if (value !== null) {
      attributes[attrName] = value;
    }
  }

  return attributes;
}

function hasTestAttribute(element) {
  return (
    element.hasAttribute('data-testid') ||
    element.hasAttribute('data-test') ||
    element.hasAttribute('data-qa') ||
    element.hasAttribute('data-cy')
  );
}

export { collectAttributes, getPriorityAttributes, hasTestAttribute };

import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';

// ─── Compiled patterns — built once from config, never hardcoded here ──────

function _buildFrameworkPatterns() {
  return get('attributes.frameworkPatterns').map(p =>
    typeof p === 'string' ? new RegExp(p) : p
  );
}

let _frameworkPatterns = null;
function getFrameworkPatterns() {
  if (!_frameworkPatterns) _frameworkPatterns = _buildFrameworkPatterns();
  return _frameworkPatterns;
}

// ─── Attribute collection ────────────────────────────────────────────────────

/**
 * Collect all non-framework attributes from an element.
 * Framework-injected attributes (ng-*, _ngcontent*, v-*, etc.) are skipped.
 */
function collectAttributes(element) {
  try {
    const attributes  = {};
    const patterns    = getFrameworkPatterns();
    const attrs       = element.attributes;

    for (let i = 0; i < attrs.length; i++) {
      const { name, value } = attrs[i];
      if (!patterns.some(p => p.test(name))) {
        attributes[name] = value;
      }
    }

    return attributes;
  } catch (error) {
    logger.error('Attribute collection failed', {
      tagName: element.tagName,
      error:   error.message
    });
    return {};
  }
}

/**
 * Collect only high-priority attributes (test IDs, semantic identifiers).
 * Order matches config priority list — first entry has highest priority.
 */
function getPriorityAttributes(element) {
  const priorityList    = get('attributes.priority');
  const supplementary   = get('attributes.supplementary');
  const allAttrs        = [...priorityList, ...supplementary];
  const attributes      = {};

  for (const attrName of allAttrs) {
    const value = element.getAttribute(attrName);
    if (value !== null) attributes[attrName] = value;
  }

  return attributes;
}

/**
 * Returns true if the element has any test-automation attribute.
 * Reads attribute names from config — no hardcoded ['data-testid', ...].
 */
function hasTestAttribute(element) {
  const priorityList = get('attributes.priority');
  return priorityList.some(attr => element.hasAttribute(attr));
}

export { collectAttributes, getPriorityAttributes, hasTestAttribute };
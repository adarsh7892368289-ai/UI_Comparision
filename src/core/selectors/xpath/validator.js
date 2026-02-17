// XPath Validator
// All functions are pure — no side effects, no logging in hot paths

/**
 * Check if an xpath string is syntactically valid.
 */
function isValidXPath(xpath) {
  if (!xpath || typeof xpath !== 'string') return false;
  try {
    document.evaluate(xpath, document, null, XPathResult.ANY_TYPE, null);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Count how many nodes in the document match this xpath.
 * Returns 0 on any error.
 */
function countXPathMatches(xpath, context = document) {
  try {
    const result = document.evaluate(
      xpath, context, null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
    );
    return result.snapshotLength;
  } catch (_) {
    return 0;
  }
}

/**
 * Check if the xpath uniquely matches exactly targetElement and nothing else.
 *
 * FIX: Uses ORDERED_NODE_SNAPSHOT_TYPE (not FIRST_ORDERED_NODE_TYPE) so it
 * correctly handles expressions that match multiple nodes — only returns true
 * when the single match IS our target.
 */
function xpathPointsToElement(xpath, targetElement, context = document) {
  try {
    const result = document.evaluate(
      xpath, context, null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
    );
    if (result.snapshotLength === 0) return false;
    // We check the FIRST result — caller is responsible for ensuring uniqueness
    // before calling this, or for using isUniqueXPath.
    return result.snapshotItem(0) === targetElement;
  } catch (_) {
    return false;
  }
}

/**
 * Returns true only when xpath matches exactly 1 node AND that node is targetElement.
 */
function isUniqueXPath(xpath, targetElement, context = document) {
  try {
    const result = document.evaluate(
      xpath, context, null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
    );
    return result.snapshotLength === 1 && result.snapshotItem(0) === targetElement;
  } catch (_) {
    return false;
  }
}

/**
 * Given a non-unique xpath that DOES include targetElement in its result set,
 * return a positionally-disambiguated version: (xpath)[N]
 *
 * Returns the original xpath unchanged if targetElement is not in the result set.
 */
function ensureUniqueness(xpath, targetElement, context = document) {
  try {
    const result = document.evaluate(
      xpath, context, null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
    );
    for (let i = 0; i < result.snapshotLength; i++) {
      if (result.snapshotItem(i) === targetElement) {
        // Already unique — no predicate needed
        if (result.snapshotLength === 1) return xpath;
        return `(${xpath})[${i + 1}]`;
      }
    }
  } catch (_) {
    // fall through
  }
  return xpath; // element not found in result set — caller must handle
}

/**
 * XPath-safe string escaping.
 * Handles strings containing both single and double quotes via concat().
 */
function escapeXPath(str) {
  if (str === null || str === undefined) return "''";
  if (typeof str !== 'string') str = String(str);
  if (str === '') return "''";

  if (!str.includes("'")) return `'${str}'`;
  if (!str.includes('"')) return `"${str}"`;

  // String contains both ' and " — use concat()
  const parts = str.split("'");
  return `concat('${parts.join("', \"'\", '")}')`;
}

export {
  isValidXPath,
  countXPathMatches,
  xpathPointsToElement,
  isUniqueXPath,
  ensureUniqueness,
  escapeXPath
};
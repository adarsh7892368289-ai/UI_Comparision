
function isValidXPath(xpath) {
  if (!xpath || typeof xpath !== 'string') return false;
  
  try {
    document.evaluate(xpath, document, null, XPathResult.ANY_TYPE, null);
    return true;
  } catch (error) {
    return false;
  }
}

function xpathPointsToElement(xpath, targetElement, context = document) {
  try {
    const result = document.evaluate(
      xpath,
      context,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    return result.singleNodeValue === targetElement;
  } catch (error) {
    return false;
  }
}

function countXPathMatches(xpath, context = document) {
  try {
    const result = document.evaluate(
      xpath,
      context,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    return result.snapshotLength;
  } catch (error) {
    return 0;
  }
}

function isUniqueXPath(xpath, targetElement, context = document) {
  const count = countXPathMatches(xpath, context);
  if (count !== 1) return false;
  
  return xpathPointsToElement(xpath, targetElement, context);
}

function ensureUniqueness(xpath, targetElement, context = document) {
  if (isUniqueXPath(xpath, targetElement, context)) {
    return xpath;
  }

  const result = document.evaluate(
    xpath,
    context,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null
  );

  for (let i = 0; i < result.snapshotLength; i++) {
    if (result.snapshotItem(i) === targetElement) {
      return `(${xpath})[${i + 1}]`;
    }
  }

  return xpath;
}

function escapeXPath(str) {
  if (!str) return "''";
  
  if (!str.includes("'")) {
    return `'${str}'`;
  }
  
  if (!str.includes('"')) {
    return `"${str}"`;
  }
  
  const parts = str.split("'");
  return `concat('${parts.join("',\"'\",'")}')`; 
}

export {
    countXPathMatches, ensureUniqueness,
    escapeXPath, isUniqueXPath, isValidXPath,
    xpathPointsToElement
};

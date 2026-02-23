import { isStableId, isStableClass, cleanText } from '../../shared/dom-utils.js';
import { get } from '../../config/defaults.js';

const TEXT_IDENTITY_MAX_CHARS = 120;
const SELECTOR_PATH_MAX_DEPTH = 8;

const DYNAMIC_CLASS_PATTERNS = /\b(?:is-|has-|active|open|closed|loading|hidden|visible|selected|disabled|hover|focus|expanded|collapsed|checked)\b/g;

function djb2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash |= 0;
  }
  return hash >>> 0;
}

function normalizeTextForIdentity(rawText) {
  return cleanText(rawText).slice(0, TEXT_IDENTITY_MAX_CHARS);
}

function extractPathOnly(url) {
  if (!url) {
    return '';
  }
  try {
    return url.split('?')[0].split('#')[0];
  } catch {
    return '';
  }
}

function buildSemanticInputs(element) {
  const testAttr = _resolveTestAttribute(element);
  const ariaLabel = element.getAttribute('aria-label') ?? '';
  const role = element.getAttribute('role') ?? '';
  const inputType = element.getAttribute('type') ?? '';
  const formName = element.getAttribute('name') ?? '';
  const hrefPath = extractPathOnly(element.getAttribute('href'));
  const srcPath = extractPathOnly(element.getAttribute('src'));
  const alt = element.getAttribute('alt') ?? '';
  const text = normalizeTextForIdentity(element.textContent ?? '');

  return `${element.tagName}|${testAttr}|${ariaLabel}|${role}|${inputType}|${formName}|${hrefPath}|${srcPath}|${alt}|${text}`;
}

function _resolveTestAttribute(element) {
  const priorityAttrs = get('attributes.priority');
  for (const attr of priorityAttrs) {
    const value = element.getAttribute(attr);
    if (value !== null) {
      return value;
    }
  }
  return '';
}

function buildStructuralInputs(element, depth, sameTagSiblingIndex) {
  const parentTag = element.parentElement?.tagName ?? 'root';
  const parentRole = element.parentElement?.getAttribute('role') ?? '';
  const childCount = element.childElementCount;

  return `${depth}|${element.tagName}|${parentTag}|${parentRole}|${sameTagSiblingIndex}|${childCount}`;
}

function computeSameTagSiblingIndex(element) {
  if (!element.parentElement) {
    return 0;
  }
  let index = 0;
  const siblings = element.parentElement.children;
  for (let i = 0; i < siblings.length; i++) {
    if (siblings[i] === element) {
      return index;
    }
    if (siblings[i].tagName === element.tagName) {
      index++;
    }
  }
  return index;
}

function buildStableSelectorSegment(element) {
  const testAttr = _resolveTestAttribute(element);
  if (testAttr) {
    const attrName = _resolveTestAttributeName(element);
    return `[${attrName}="${CSS.escape(testAttr)}"]`;
  }

  const id = element.getAttribute('id');
  if (id && isStableId(id)) {
    return `#${CSS.escape(id)}`;
  }

  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) {
    return `${element.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`;
  }

  const role = element.getAttribute('role');
  if (role) {
    return `${element.tagName.toLowerCase()}[role="${role}"]`;
  }

  const stableClasses = _extractStableClasses(element);
  if (stableClasses.length > 0) {
    return `${element.tagName.toLowerCase()}.${stableClasses.slice(0, 2).join('.')}`;
  }

  return element.tagName.toLowerCase();
}

function _resolveTestAttributeName(element) {
  const priorityAttrs = get('attributes.priority');
  for (const attr of priorityAttrs) {
    if (element.hasAttribute(attr)) {
      return attr;
    }
  }
  return 'data-testid';
}

function _extractStableClasses(element) {
  const raw = element.getAttribute('class') ?? '';
  return raw
    .split(/\s+/)
    .filter(cls => cls.length > 0 && isStableClass(cls) && !DYNAMIC_CLASS_PATTERNS.test(cls));
}

function buildStableSelectorPath(element) {
  const segments = [];
  let current = element;
  let depth = 0;

  while (current && current.tagName !== 'BODY' && current.tagName !== 'HTML' && depth < SELECTOR_PATH_MAX_DEPTH) {
    const segment = buildStableSelectorSegment(current);
    segments.unshift(segment);

    const isAnchorSegment = segment.includes('[') || segment.startsWith('#');
    if (isAnchorSegment) {
      break;
    }

    current = current.parentElement;
    depth++;
  }

  return segments.join(' > ');
}

function resolveSemanticKey(element) {
  const testAttr = _resolveTestAttribute(element);
  if (testAttr) {
    return testAttr;
  }

  const ariaLabel = element.getAttribute('aria-label');
  const role = element.getAttribute('role');
  if (ariaLabel || role) {
    return `${ariaLabel ?? ''}::${role ?? ''}`;
  }

  return null;
}

function buildFingerprint(element, depth) {
  performance.mark('fingerprint-start');

  const sameTagSiblingIndex = computeSameTagSiblingIndex(element);
  const semanticInputs = buildSemanticInputs(element);
  const structuralInputs = buildStructuralInputs(element, depth, sameTagSiblingIndex);

  const fingerprint = {
    semanticKey: resolveSemanticKey(element),
    semanticHash: djb2(semanticInputs),
    structuralHash: djb2(structuralInputs),
    selectorPath: buildStableSelectorPath(element)
  };

  performance.mark('fingerprint-end');
  performance.measure('fingerprint', 'fingerprint-start', 'fingerprint-end');

  return fingerprint;
}

export { buildFingerprint, djb2, buildStableSelectorPath, resolveSemanticKey };
import { isStableId, isStableClass, cleanText } from '../../shared/dom-utils.js';
import { get } from '../../config/defaults.js';

let stateClassRegex = null;

function getStateClassRegex() {
  if (!stateClassRegex) {
    stateClassRegex = new RegExp(get('fingerprint.stateClassPattern'), 'u');
  }
  return stateClassRegex;
}

function djb2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash |= 0;
  }
  return hash >>> 0;
}

function extractUrlPath(url) {
  if (!url) {
    return '';
  }
  try {
    return url.split('?')[0].split('#')[0];
  } catch {
    return '';
  }
}

function resolveTestAttribute(element) {
  const priorityAttrs = get('attributes.priority');
  for (const attr of priorityAttrs) {
    const value = element.getAttribute(attr);
    if (value !== null) {
      return value;
    }
  }
  return '';
}

function resolveTestAttributeName(element) {
  const priorityAttrs = get('attributes.priority');
  for (const attr of priorityAttrs) {
    if (element.hasAttribute(attr)) {
      return attr;
    }
  }
  return 'data-testid';
}

function buildSemanticInputs(element) {
  const testAttr = resolveTestAttribute(element);
  const ariaLabel = element.getAttribute('aria-label') ?? '';
  const role = element.getAttribute('role') ?? '';
  const inputType = element.getAttribute('type') ?? '';
  const formName = element.getAttribute('name') ?? '';
  const hrefPath = extractUrlPath(element.getAttribute('href'));
  const srcPath = extractUrlPath(element.getAttribute('src'));
  const alt = element.getAttribute('alt') ?? '';
  const text = cleanText(element.textContent ?? '').slice(0, get('fingerprint.textMaxChars'));

  return `${element.tagName}|${testAttr}|${ariaLabel}|${role}|${inputType}|${formName}|${hrefPath}|${srcPath}|${alt}|${text}`;
}

function buildStructuralInputs(element, depth, sameTagSiblingIndex) {
  const parentTag = element.parentElement?.tagName ?? 'root';
  const parentRole = element.parentElement?.getAttribute('role') ?? '';
  return `${depth}|${element.tagName}|${parentTag}|${parentRole}|${sameTagSiblingIndex}|${element.childElementCount}`;
}

function buildSelectorSegment(element) {
  const testAttr = resolveTestAttribute(element);
  if (testAttr) {
    return `[${resolveTestAttributeName(element)}="${CSS.escape(testAttr)}"]`;
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

  const rawClass = element.getAttribute('class') ?? '';
  const regex = getStateClassRegex();
  const stableClasses = rawClass
    .split(/\s+/u)
    .filter(cls => cls.length > 0 && isStableClass(cls) && !regex.test(cls));

  if (stableClasses.length > 0) {
    return `${element.tagName.toLowerCase()}.${stableClasses.slice(0, 2).join('.')}`;
  }

  return element.tagName.toLowerCase();
}

function buildSelectorPath(element) {
  const segments = [];
  let current = element;
  let depth = 0;
  const maxDepth = get('fingerprint.selectorMaxDepth');

  while (current && current.tagName !== 'BODY' && current.tagName !== 'HTML' && depth < maxDepth) {
    const segment = buildSelectorSegment(current);
    segments.unshift(segment);
    if (segment.includes('[') || segment.startsWith('#')) {
      break;
    }
    current = current.parentElement;
    depth++;
  }

  return segments.join(' > ');
}

function resolveSemanticKey(element) {
  const testAttr = resolveTestAttribute(element);
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

function buildFingerprint(element, depth, sameTagSiblingIndex) {
  return {
    semanticKey: resolveSemanticKey(element),
    semanticHash: djb2(buildSemanticInputs(element)),
    structuralHash: djb2(buildStructuralInputs(element, depth, sameTagSiblingIndex)),
    selectorPath: buildSelectorPath(element)
  };
}

export { buildFingerprint, djb2, buildSelectorPath, resolveSemanticKey, buildSemanticInputs };
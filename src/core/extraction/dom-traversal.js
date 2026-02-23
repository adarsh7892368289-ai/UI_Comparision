import { isTierZero, matchesFilters } from './element-classifier.js';

const SHADOW_ID_SEPARATOR = '::shadow::';

function createVisitRecord(element, depth, shadowContext) {
  return { element, depth, shadowContext };
}

function getSameTagSiblingIndex(element) {
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

function buildTreeWalkerFilter(filters) {
  return {
    acceptNode(node) {
      if (isTierZero(node)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!matchesFilters(node, filters)) {
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  };
}

function collectFromRoot(root, startDepth, filters, shadowContext, accumulator) {
  const filter = buildTreeWalkerFilter(filters);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, filter);

  let node = walker.nextNode();
  while (node) {
    const depth = startDepth + computeRelativeDepth(node, root);
    accumulator.push(createVisitRecord(node, depth, shadowContext));

    if (node.shadowRoot) {
      const childShadowContext = {
        inShadow: true,
        hostId: shadowContext?.hostId ?? null,
        shadowDepth: (shadowContext?.shadowDepth ?? 0) + 1
      };
      collectFromRoot(node.shadowRoot, depth + 1, filters, childShadowContext, accumulator);
    }

    node = walker.nextNode();
  }
}

function computeRelativeDepth(node, root) {
  let depth = 0;
  let current = node.parentElement ?? node.parentNode;
  while (current && current !== root) {
    depth++;
    current = current.parentElement ?? current.parentNode;
  }
  return depth;
}

function traverseDocument(filters) {
  performance.mark('traversal-start');

  const visits = [];
  collectFromRoot(document.body ?? document.documentElement, 0, filters, null, visits);

  performance.mark('traversal-end');
  performance.measure('dom-traversal', 'traversal-start', 'traversal-end');

  return visits;
}

function traverseFilteredScoped(roots, filters) {
  const visits = [];
  const seen = new WeakSet();

  for (const root of roots) {
    if (seen.has(root)) {
      continue;
    }
    seen.add(root);
    collectFromRoot(root, computeDocumentDepth(root), filters, null, visits);

    const descendants = root.querySelectorAll('*');
    for (const desc of descendants) {
      seen.add(desc);
    }
  }

  return visits;
}

function computeDocumentDepth(element) {
  let depth = 0;
  let current = element.parentElement;
  while (current) {
    depth++;
    current = current.parentElement;
  }
  return depth;
}

function buildShadowHostId(visit, captureIndex) {
  if (!visit.shadowContext) {
    return null;
  }
  const { shadowDepth } = visit.shadowContext;
  return `${SHADOW_ID_SEPARATOR}${shadowDepth}-${captureIndex}`;
}

export { traverseDocument, traverseFilteredScoped, getSameTagSiblingIndex, buildShadowHostId };
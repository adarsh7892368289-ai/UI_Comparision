import { getT0Tags, matchesFilters } from './element-classifier.js';

const STACK_CAPACITY = 1024;
const sharedStackNodes = new Array(STACK_CAPACITY);
const sharedStackDepths = new Int32Array(STACK_CAPACITY);
const sharedStackIds = new Int32Array(STACK_CAPACITY);

function buildFilter(t0Tags, filters) {
  return {
    acceptNode(node) {
      if (t0Tags.has(node.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      return matchesFilters(node, filters) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  };
}

function buildShadowContext(parentContext, hostElement) {
  return {
    inShadow: true,
    hostElement,
    shadowDepth: (parentContext?.shadowDepth ?? 0) + 1
  };
}

function collectFromRoot(root, baseDepth, shadowContext, ctx, stackBase) {
  const { filter, siblingMap, accumulator } = ctx;

  sharedStackNodes[stackBase] = root;
  sharedStackDepths[stackBase] = baseDepth - 1;
  sharedStackIds[stackBase] = ctx.nextId++;
  let stackTop = stackBase;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, filter);
  let node = walker.nextNode();

  while (node) {
    const parent = node.parentNode;

    while (stackTop > stackBase && sharedStackNodes[stackTop] !== parent) {
      stackTop--;
    }

    const depth = sharedStackDepths[stackTop] + 1;
    stackTop = Math.min(stackTop + 1, STACK_CAPACITY - 1);
    sharedStackNodes[stackTop] = node;
    sharedStackDepths[stackTop] = depth;
    sharedStackIds[stackTop] = ctx.nextId++;

    if (stackTop > ctx.maxStackTop) {
      ctx.maxStackTop = stackTop;
    }

    const sibKey = `${sharedStackIds[stackTop - 1]}|${node.tagName}`;
    const sameTagSiblingIndex = siblingMap.get(sibKey) ?? 0;
    siblingMap.set(sibKey, sameTagSiblingIndex + 1);

    accumulator.push({ element: node, depth, sameTagSiblingIndex, shadowContext });

    if (node.shadowRoot) {
      const innerBase = Math.min(stackTop + 1, STACK_CAPACITY - 1);
      collectFromRoot(
        node.shadowRoot,
        depth + 1,
        buildShadowContext(shadowContext, node),
        ctx,
        innerBase
      );
    }

    node = walker.nextNode();
  }
}

function traverseDocument(filters) {
  const t0Tags = getT0Tags();
  const filter = buildFilter(t0Tags, filters);
  const siblingMap = new Map();
  const accumulator = [];
  const ctx = { filter, siblingMap, accumulator, nextId: 1, maxStackTop: 0 };
  const root = document.body ?? document.documentElement;

  collectFromRoot(root, 0, null, ctx, 0);

  for (let i = 0; i <= ctx.maxStackTop; i++) {
    sharedStackNodes[i] = null;
  }

  siblingMap.clear();

  return accumulator;
}

function buildShadowHostId(visit, captureIndex) {
  if (!visit.shadowContext) {
    return null;
  }
  const { shadowDepth } = visit.shadowContext;
  return `::shadow::${shadowDepth}-${captureIndex}`;
}

export { traverseDocument, buildShadowHostId };
import logger from '../../infrastructure/logger.js';
import { get } from '../../config/defaults.js';
import { yieldToEventLoop, YIELD_CHUNK_SIZE } from '../../shared/async-utils.js';

const MATCH_STRATEGIES = Object.freeze({
  TEST_ATTRIBUTE:  'test-attribute',
  ID:              'id',
  SEMANTIC_KEY:    'semantic-key',
  STRUCTURAL_HASH: 'structural-hash',
  SELECTOR_PATH:   'selector-path',
  TOPOLOGICAL:     'topological',
  POSITION:        'position'
});

const MatchType = Object.freeze({
  DEFINITIVE:         'definitive',
  AMBIGUOUS:          'ambiguous',
  POSITIONAL:         'positional',
  UNMATCHED_BASELINE: 'unmatched-baseline',
  UNMATCHED_COMPARE:  'unmatched-compare'
});

const MUTATION_TYPE = Object.freeze({
  STRUCTURAL:       'structural-modification',
  SELECTOR_CHANGED: 'selector-changed',
  TOPOLOGICAL_MOVE: 'topological-move'
});

const CONFIDENCE = Object.freeze({
  TEST_ATTR:       1.00,
  ID:              0.95,
  SEMANTIC_KEY:    0.90,
  STRUCTURAL_HASH: 0.80,
  SELECTOR_PATH:   0.72,
  TOPOLOGICAL:     0.65,
  POSITION:        0.30
});

const PASS_PCT = Object.freeze({
  ANCHOR_END:      25,
  STRUCTURAL_END:  40,
  TOPOLOGICAL_END: 47,
  POSITION_END:    50
});

function progressFrame(label, pct) {
  return { type: 'progress', label, pct };
}

function resultFrame(payload) {
  return { type: 'result', payload };
}

function getTestAttrKey(el, priorityAttrs) {
  for (const attr of priorityAttrs) {
    const attrVal = el.attributes?.[attr];
    if (attrVal) {
      return `${attr}::${attrVal}`;
    }
  }
  return null;
}

function buildMultiMap(items, availableIdxs, keyFn) {
  const map = new Map();
  for (const i of availableIdxs) {
    const key = keyFn(items[i]);
    if (key == null) {
      continue;
    }
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(i);
  }
  return map;
}

function buildAnchorMaps(compareElements, allIdxs, priorityAttrs) {
  return {
    testAttr:    buildMultiMap(compareElements, allIdxs, el => getTestAttrKey(el, priorityAttrs)),
    byId:        buildMultiMap(compareElements, allIdxs, el => el.elementId || null),
    semanticKey: buildMultiMap(compareElements, allIdxs, el => el.fingerprint?.semanticKey ?? null)
  };
}

function buildStructuralMaps(compareElements, availableIdxs) {
  return {
    structuralHash: buildMultiMap(compareElements, availableIdxs, el => el.fingerprint?.structuralHash ?? null),
    selectorPath:   buildMultiMap(compareElements, availableIdxs, el => el.fingerprint?.selectorPath ?? null)
  };
}

function buildSemanticHashMap(compareElements, availableIdxs) {
  return buildMultiMap(compareElements, availableIdxs, el => el.fingerprint?.semanticHash ?? null);
}

function gridCellKey(x, y, tag, cellSize) {
  return `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}:${tag}`;
}

function buildPositionGrid(compareElements, availableIdxs, cellSize) {
  const grid = new Map();
  for (const i of availableIdxs) {
    const { boundingRect, tagName } = compareElements[i];
    if (!boundingRect || boundingRect.x == null || boundingRect.y == null) {
      continue;
    }
    const key = gridCellKey(boundingRect.x, boundingRect.y, tagName, cellSize);
    if (!grid.has(key)) {
      grid.set(key, []);
    }
    grid.get(key).push({ index: i, x: boundingRect.x, y: boundingRect.y });
  }
  return grid;
}

function pickFromGrid(bx, by, gridCtx, usedCompare) {
  const { grid, cellSize, tag } = gridCtx;
  const cx     = Math.floor(bx / cellSize);
  const cy     = Math.floor(by / cellSize);
  let bestIdx  = null;
  let bestDist = Infinity;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = grid.get(`${cx + dx}:${cy + dy}:${tag}`);
      if (!bucket) {
        continue;
      }
      for (const { index, x, y } of bucket) {
        if (usedCompare.has(index)) {
          continue;
        }
        const dist = Math.hypot(bx - x, by - y);
        if (dist < cellSize && dist < bestDist) {
          bestDist = dist;
          bestIdx  = index;
        }
      }
    }
  }

  if (bestIdx === null) {
    return null;
  }
  return { index: bestIdx, confidence: Math.max(0.1, 1 - bestDist / cellSize) * CONFIDENCE.POSITION };
}

function resolveFromMultiMap(indices, confidence, usedCompare, minMatchThreshold, ambiguityWindow) {
  if (!indices) {
    return { verdict: 'no_match' };
  }
  const available = indices.filter(i => !usedCompare.has(i));
  if (available.length === 0) {
    return { verdict: 'no_match' };
  }
  if (available.length === 1) {
    if (confidence >= minMatchThreshold) {
      return { verdict: 'definitive', index: available[0], confidence };
    }
    return { verdict: 'below_threshold', index: available[0], confidence };
  }
  if (confidence >= minMatchThreshold) {
    return {
      verdict:    'ambiguous',
      confidence,
      candidates: available.map(compareIndex => ({ compareIndex, confidence, deltaFromBest: 0 }))
    };
  }
  return { verdict: 'no_match' };
}

function detectMutations(baselineEl, compareEl, isTopological) {
  const mutations = [];
  const baseFp    = baselineEl.fingerprint;
  const cmpFp     = compareEl.fingerprint;
  if (!baseFp || !cmpFp) {
    return mutations;
  }
  if (baseFp.structuralHash !== cmpFp.structuralHash) {
    mutations.push(MUTATION_TYPE.STRUCTURAL);
  }
  if (baseFp.selectorPath && cmpFp.selectorPath && baseFp.selectorPath !== cmpFp.selectorPath) {
    mutations.push(MUTATION_TYPE.SELECTOR_CHANGED);
  }
  if (isTopological) {
    mutations.push(MUTATION_TYPE.TOPOLOGICAL_MOVE);
  }
  return mutations;
}

function makeDefinitiveMatch({ bi, ci, conf, strat, matchType, nodeCtx }) {
  const { baseline, compareElements } = nodeCtx;
  return {
    baselineIndex:       bi,
    compareIndex:        ci,
    confidence:          conf,
    strategy:            strat,
    matchType,
    isAmbiguous:         false,
    ambiguousCandidates: null,
    baselineElement:     baseline[bi],
    compareElement:      compareElements[ci],
    mutations:           detectMutations(baseline[bi], compareElements[ci], strat === MATCH_STRATEGIES.TOPOLOGICAL)
  };
}

function makeAmbiguousMatch(bi, conf, strat, candidates, baseline) {
  return {
    baselineIndex:       bi,
    compareIndex:        null,
    confidence:          conf,
    strategy:            strat,
    matchType:           MatchType.AMBIGUOUS,
    isAmbiguous:         true,
    ambiguousCandidates: candidates.map(candidate => ({ ...candidate, strategy: strat })),
    baselineElement:     baseline[bi],
    compareElement:      null,
    mutations:           []
  };
}

async function* runChunkedPass(indices, classifyFn, progressCtx) {
  const { label, startPct, endPct } = progressCtx;
  const total     = indices.length;
  const matches   = [];
  const ambiguous = [];
  const orphans   = [];

  for (let start = 0; start < total; start += YIELD_CHUNK_SIZE) {
    const end = Math.min(start + YIELD_CHUNK_SIZE, total);
    for (let i = start; i < end; i++) {
      const hit = classifyFn(indices[i]);
      if (hit.kind === 'match') {
        matches.push(hit.match);
      } else if (hit.kind === 'ambiguous') {
        ambiguous.push(hit.entry);
      } else {
        orphans.push(indices[i]);
      }
    }
    await yieldToEventLoop();
    yield progressFrame(label, Math.round(startPct + (end / total) * (endPct - startPct)));
  }

  if (total === 0) {
    yield progressFrame(label, endPct);
  }

  yield resultFrame({ matches, ambiguous, orphans });
}

function buildAnchorClassifier(anchorMaps, passCtx, nodeCtx) {
  const { usedCompare, matchConfig } = passCtx;
  const { baseline } = nodeCtx;
  const { priorityAttrs, minMatchThreshold, ambiguityWindow } = matchConfig;

  return (bi) => {
    const el      = baseline[bi];
    const testKey = getTestAttrKey(el, priorityAttrs);

    if (testKey) {
      const res = resolveFromMultiMap(anchorMaps.testAttr.get(testKey), CONFIDENCE.TEST_ATTR, usedCompare, minMatchThreshold, ambiguityWindow);
      if (res.verdict === 'definitive') {
        usedCompare.add(res.index);
        return { kind: 'match', match: makeDefinitiveMatch({ bi, ci: res.index, conf: res.confidence, strat: MATCH_STRATEGIES.TEST_ATTRIBUTE, matchType: MatchType.DEFINITIVE, nodeCtx }) };
      }
      if (res.verdict === 'ambiguous') {
        return { kind: 'ambiguous', entry: makeAmbiguousMatch(bi, res.confidence, MATCH_STRATEGIES.TEST_ATTRIBUTE, res.candidates, baseline) };
      }
    }

    if (el.elementId) {
      const res = resolveFromMultiMap(anchorMaps.byId.get(el.elementId), CONFIDENCE.ID, usedCompare, minMatchThreshold, ambiguityWindow);
      if (res.verdict === 'definitive') {
        usedCompare.add(res.index);
        return { kind: 'match', match: makeDefinitiveMatch({ bi, ci: res.index, conf: res.confidence, strat: MATCH_STRATEGIES.ID, matchType: MatchType.DEFINITIVE, nodeCtx }) };
      }
      if (res.verdict === 'ambiguous') {
        return { kind: 'ambiguous', entry: makeAmbiguousMatch(bi, res.confidence, MATCH_STRATEGIES.ID, res.candidates, baseline) };
      }
    }

    const semanticKey = el.fingerprint?.semanticKey;
    if (semanticKey) {
      const res = resolveFromMultiMap(anchorMaps.semanticKey.get(semanticKey), CONFIDENCE.SEMANTIC_KEY, usedCompare, minMatchThreshold, ambiguityWindow);
      if (res.verdict === 'definitive') {
        usedCompare.add(res.index);
        return { kind: 'match', match: makeDefinitiveMatch({ bi, ci: res.index, conf: res.confidence, strat: MATCH_STRATEGIES.SEMANTIC_KEY, matchType: MatchType.DEFINITIVE, nodeCtx }) };
      }
      if (res.verdict === 'ambiguous') {
        return { kind: 'ambiguous', entry: makeAmbiguousMatch(bi, res.confidence, MATCH_STRATEGIES.SEMANTIC_KEY, res.candidates, baseline) };
      }
    }

    return { kind: 'orphan' };
  };
}

function buildStructuralClassifier(orphanCmpIdxs, passCtx, nodeCtx) {
  const { usedCompare, matchConfig } = passCtx;
  const { baseline } = nodeCtx;
  const { minMatchThreshold, ambiguityWindow } = matchConfig;
  const structMaps = buildStructuralMaps(nodeCtx.compareElements, orphanCmpIdxs);

  return (bi) => {
    const fp = baseline[bi].fingerprint;

    if (fp?.structuralHash != null) {
      const res = resolveFromMultiMap(structMaps.structuralHash.get(fp.structuralHash), CONFIDENCE.STRUCTURAL_HASH, usedCompare, minMatchThreshold, ambiguityWindow);
      if (res.verdict === 'definitive') {
        usedCompare.add(res.index);
        return { kind: 'match', match: makeDefinitiveMatch({ bi, ci: res.index, conf: res.confidence, strat: MATCH_STRATEGIES.STRUCTURAL_HASH, matchType: MatchType.DEFINITIVE, nodeCtx }) };
      }
      if (res.verdict === 'ambiguous') {
        return { kind: 'ambiguous', entry: makeAmbiguousMatch(bi, res.confidence, MATCH_STRATEGIES.STRUCTURAL_HASH, res.candidates, baseline) };
      }
    }

    if (fp?.selectorPath) {
      const res = resolveFromMultiMap(structMaps.selectorPath.get(fp.selectorPath), CONFIDENCE.SELECTOR_PATH, usedCompare, minMatchThreshold, ambiguityWindow);
      if (res.verdict === 'definitive') {
        usedCompare.add(res.index);
        return { kind: 'match', match: makeDefinitiveMatch({ bi, ci: res.index, conf: res.confidence, strat: MATCH_STRATEGIES.SELECTOR_PATH, matchType: MatchType.DEFINITIVE, nodeCtx }) };
      }
      if (res.verdict === 'ambiguous') {
        return { kind: 'ambiguous', entry: makeAmbiguousMatch(bi, res.confidence, MATCH_STRATEGIES.SELECTOR_PATH, res.candidates, baseline) };
      }
    }

    return { kind: 'orphan' };
  };
}

function buildTopologicalClassifier(orphanCmpIdxs, passCtx, nodeCtx) {
  const { usedCompare, minConf } = passCtx;
  const { baseline } = nodeCtx;
  const semanticMap  = buildSemanticHashMap(nodeCtx.compareElements, orphanCmpIdxs);

  return (bi) => {
    const hash = baseline[bi].fingerprint?.semanticHash;
    if (hash == null) {
      return { kind: 'orphan' };
    }
    const indices   = semanticMap.get(hash);
    if (!indices) {
      return { kind: 'orphan' };
    }
    const available = indices.filter(i => !usedCompare.has(i));
    if (available.length !== 1 || CONFIDENCE.TOPOLOGICAL < minConf) {
      return { kind: 'orphan' };
    }
    const ci = available[0];
    usedCompare.add(ci);
    return { kind: 'match', match: makeDefinitiveMatch({ bi, ci, conf: CONFIDENCE.TOPOLOGICAL, strat: MATCH_STRATEGIES.TOPOLOGICAL, matchType: MatchType.DEFINITIVE, nodeCtx }) };
  };
}

function buildPositionClassifier(orphanCmpIdxs, passCtx, nodeCtx) {
  const { usedCompare, minConf, cellSize } = passCtx;
  const { baseline } = nodeCtx;
  const grid         = buildPositionGrid(nodeCtx.compareElements, orphanCmpIdxs, cellSize);
  const usedLocal    = new Set();

  return (bi) => {
    const rect = baseline[bi].boundingRect;
    if (rect?.x == null || rect?.y == null) {
      return { kind: 'orphan' };
    }
    const gridCtx = { grid, cellSize, tag: baseline[bi].tagName };
    const hit     = pickFromGrid(rect.x, rect.y, gridCtx, usedCompare);
    if (hit && hit.confidence >= minConf && !usedLocal.has(hit.index)) {
      usedLocal.add(hit.index);
      usedCompare.add(hit.index);
      return { kind: 'match', match: makeDefinitiveMatch({ bi, ci: hit.index, conf: hit.confidence, strat: MATCH_STRATEGIES.POSITION, matchType: MatchType.POSITIONAL, nodeCtx }) };
    }
    return { kind: 'orphan' };
  };
}

class ElementMatcher {
  #minConf;
  #minMatchThreshold;
  #ambiguityWindow;
  #cellSize;
  #priorityAttrs;

  constructor() {
    this.#minConf           = get('comparison.matching.confidenceThreshold', 0.5);
    this.#minMatchThreshold = get('comparison.matching.minMatchThreshold', 0.70);
    this.#ambiguityWindow   = get('comparison.matching.ambiguityWindow', 0.12);
    this.#cellSize          = get('comparison.matching.positionTolerance', 50);
    this.#priorityAttrs     = get('attributes.priority').slice(0, 4);
  }

  async* matchElements(baseline, compareElements) {
    logger.info('Multi-pass matching start', { baseline: baseline.length, compare: compareElements.length });

    const usedCompare = new Set();
    const allCmpIdxs  = Array.from({ length: compareElements.length }, (_, i) => i);
    const allBaseIdxs = Array.from({ length: baseline.length }, (_, i) => i);
    const anchorMaps  = buildAnchorMaps(compareElements, allCmpIdxs, this.#priorityAttrs);
    const nodeCtx     = { baseline, compareElements };
    const matchConfig = {
      priorityAttrs:     this.#priorityAttrs,
      minMatchThreshold: this.#minMatchThreshold,
      ambiguityWindow:   this.#ambiguityWindow
    };
    const passCtx = { usedCompare, matchConfig, minConf: this.#minConf, cellSize: this.#cellSize };

    let p1 = null;
    const anchorGen = runChunkedPass(
      allBaseIdxs,
      buildAnchorClassifier(anchorMaps, passCtx, nodeCtx),
      { label: 'Anchoring elements…', startPct: 0, endPct: PASS_PCT.ANCHOR_END }
    );
    for await (const frame of anchorGen) {
      if (frame.type === 'result') { p1 = frame.payload; }
      else { yield frame; }
    }

    const p1CmpOrphans = allCmpIdxs.filter(i => !usedCompare.has(i));
    let p2 = null;
    const structGen = runChunkedPass(
      p1.orphans,
      buildStructuralClassifier(p1CmpOrphans, passCtx, nodeCtx),
      { label: 'Structural matching…', startPct: PASS_PCT.ANCHOR_END, endPct: PASS_PCT.STRUCTURAL_END }
    );
    for await (const frame of structGen) {
      if (frame.type === 'result') { p2 = frame.payload; }
      else { yield frame; }
    }

    const p2CmpOrphans = p1CmpOrphans.filter(i => !usedCompare.has(i));
    let p3 = null;
    const topoGen = runChunkedPass(
      p2.orphans,
      buildTopologicalClassifier(p2CmpOrphans, passCtx, nodeCtx),
      { label: 'Topological matching…', startPct: PASS_PCT.STRUCTURAL_END, endPct: PASS_PCT.TOPOLOGICAL_END }
    );
    for await (const frame of topoGen) {
      if (frame.type === 'result') { p3 = frame.payload; }
      else { yield frame; }
    }

    const p3CmpOrphans = p2CmpOrphans.filter(i => !usedCompare.has(i));
    let p4 = null;
    const posGen = runChunkedPass(
      p3.orphans,
      buildPositionClassifier(p3CmpOrphans, passCtx, nodeCtx),
      { label: 'Positional matching…', startPct: PASS_PCT.TOPOLOGICAL_END, endPct: PASS_PCT.POSITION_END }
    );
    for await (const frame of posGen) {
      if (frame.type === 'result') { p4 = frame.payload; }
      else { yield frame; }
    }

    const allMatches   = [...p1.matches,   ...p2.matches,  ...p3.matches,  ...p4.matches];
    const allAmbiguous = [...p1.ambiguous, ...p2.ambiguous];

    const reservedByAmbiguous = new Set(
      allAmbiguous.flatMap(entry => (entry.ambiguousCandidates ?? []).map(c => c.compareIndex))
    );

    const unmatchedBaseline = p4.orphans.map(i => baseline[i]);
    const unmatchedCompare  = p3CmpOrphans
      .filter(i => !usedCompare.has(i) && !reservedByAmbiguous.has(i))
      .map(i => compareElements[i]);

    logger.info('Multi-pass matching complete', {
      matched:           allMatches.length,
      ambiguous:         allAmbiguous.length,
      unmatchedBaseline: unmatchedBaseline.length,
      unmatchedCompare:  unmatchedCompare.length,
      pass1Anchors:      p1.matches.length,
      pass2Structural:   p2.matches.length,
      pass3Topological:  p3.matches.length,
      pass4Position:     p4.matches.length
    });

    yield resultFrame({ matches: allMatches, ambiguous: allAmbiguous, unmatchedBaseline, unmatchedCompare });
  }
}

export { ElementMatcher, MATCH_STRATEGIES, MatchType, MUTATION_TYPE };
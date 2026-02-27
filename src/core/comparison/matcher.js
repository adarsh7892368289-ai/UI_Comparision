import logger                                from '../../infrastructure/logger.js';
import { get }                               from '../../config/defaults.js';
import { yieldToEventLoop, YIELD_CHUNK_SIZE } from '../../shared/async-utils.js';

const MatchType = Object.freeze({
  DEFINITIVE:         'definitive',
  AMBIGUOUS:          'ambiguous',
  POSITIONAL:         'positional',
  UNMATCHED_BASELINE: 'unmatched-baseline',
  UNMATCHED_COMPARE:  'unmatched-compare'
});

const MUTATION_TYPE = Object.freeze({
  HPID_MOVED:       'hpid-position-moved',
  SELECTOR_CHANGED: 'selector-changed',
  TOPOLOGICAL_MOVE: 'topological-move'
});

function progressFrame(label, pct) {
  return { type: 'progress', label, pct };
}

function resultFrame(payload) {
  return { type: 'result', payload };
}

function getTestAttrKey(el, anchorAttributes) {
  for (const attr of anchorAttributes) {
    const attrVal = el.attributes?.[attr];
    if (attrVal) return `${attr}::${attrVal}`;
  }
  return null;
}

function buildMultiMap(items, availableIdxs, keyFn) {
  const map = new Map();
  for (const i of availableIdxs) {
    const key = keyFn(items[i]);
    if (key == null) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(i);
  }
  return map;
}

function gridCellKey(x, y, tag, cellSize) {
  return `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}:${tag}`;
}

function buildPositionGrid(compareElements, availableIdxs, cellSize) {
  const grid = new Map();
  for (const i of availableIdxs) {
    const { rect, tagName } = compareElements[i];
    if (!rect || rect.x == null || rect.y == null) continue;
    const key = gridCellKey(rect.x, rect.y, tagName, cellSize);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push({ index: i, x: rect.x, y: rect.y });
  }
  return grid;
}

function pickFromGrid(bx, by, gridCtx, usedCompare) {
  const { grid, cellSize, tag, baseConfidence } = gridCtx;
  const cx     = Math.floor(bx / cellSize);
  const cy     = Math.floor(by / cellSize);
  let bestIdx  = null;
  let bestDist = Infinity;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = grid.get(`${cx + dx}:${cy + dy}:${tag}`);
      if (!bucket) continue;
      for (const { index, x, y } of bucket) {
        if (usedCompare.has(index)) continue;
        const dist = Math.hypot(bx - x, by - y);
        if (dist < cellSize && dist < bestDist) {
          bestDist = dist;
          bestIdx  = index;
        }
      }
    }
  }

  if (bestIdx === null) return null;
  return { index: bestIdx, confidence: Math.max(0.1, 1 - bestDist / cellSize) * baseConfidence };
}

function resolveFromMultiMap(indices, confidence, usedCompare, minMatchThreshold, ambiguityWindow) {
  if (!indices) return { verdict: 'no_match' };
  const available = indices.filter(i => !usedCompare.has(i));
  if (available.length === 0) return { verdict: 'no_match' };
  if (available.length === 1) {
    return confidence >= minMatchThreshold
      ? { verdict: 'definitive', index: available[0], confidence }
      : { verdict: 'below_threshold', index: available[0], confidence };
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

function detectMutations(baselineEl, compareEl, strategyId) {
  const mutations = [];

  if (baselineEl.absoluteHpid && compareEl.absoluteHpid &&
      baselineEl.absoluteHpid !== compareEl.absoluteHpid) {
    mutations.push(MUTATION_TYPE.HPID_MOVED);
  }

  if (baselineEl.cssSelector && compareEl.cssSelector &&
      baselineEl.cssSelector !== compareEl.cssSelector) {
    mutations.push(MUTATION_TYPE.SELECTOR_CHANGED);
  }

  if (strategyId === 'hpid-prefix') {
    mutations.push(MUTATION_TYPE.TOPOLOGICAL_MOVE);
  }

  return mutations;
}

function makeDefinitiveMatch(opts) {
  const { bi, ci, conf, strat, matchType, nodeCtx } = opts;
  const { baseline, compareElements }               = nodeCtx;
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
    mutations:           detectMutations(baseline[bi], compareElements[ci], strat)
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
      if (hit.kind === 'match')          matches.push(hit.match);
      else if (hit.kind === 'ambiguous') ambiguous.push(hit.entry);
      else orphans.push(indices[i]);
    }
    await yieldToEventLoop();
    yield progressFrame(label, Math.round(startPct + (end / total) * (endPct - startPct)));
  }

  if (total === 0) yield progressFrame(label, endPct);
  yield resultFrame({ matches, ambiguous, orphans });
}

function buildTestAttributeClassifier(cmpIdxs, passCtx, nodeCtx, strategy) {
  const { usedCompare, matchConfig } = passCtx;
  const { baseline, compareElements } = nodeCtx;
  const { anchorAttributes, minMatchThreshold, ambiguityWindow } = matchConfig;
  const map = buildMultiMap(compareElements, cmpIdxs, el => getTestAttrKey(el, anchorAttributes));

  return (bi) => {
    const key = getTestAttrKey(baseline[bi], anchorAttributes);
    if (!key) return { kind: 'orphan' };
    const res = resolveFromMultiMap(map.get(key), strategy.confidence, usedCompare, minMatchThreshold, ambiguityWindow);
    if (res.verdict === 'definitive') {
      usedCompare.add(res.index);
      return { kind: 'match', match: makeDefinitiveMatch({ bi, ci: res.index, conf: res.confidence, strat: strategy.id, matchType: MatchType.DEFINITIVE, nodeCtx }) };
    }
    if (res.verdict === 'ambiguous') {
      return { kind: 'ambiguous', entry: makeAmbiguousMatch(bi, res.confidence, strategy.id, res.candidates, baseline) };
    }
    return { kind: 'orphan' };
  };
}

function buildAbsoluteHpidClassifier(cmpIdxs, passCtx, nodeCtx, strategy) {
  const { usedCompare, matchConfig } = passCtx;
  const { baseline, compareElements } = nodeCtx;
  const { minMatchThreshold, ambiguityWindow } = matchConfig;
  const map = buildMultiMap(compareElements, cmpIdxs, el => el.absoluteHpid ?? null);

  return (bi) => {
    const hpid = baseline[bi].absoluteHpid;
    if (!hpid) return { kind: 'orphan' };
    const res = resolveFromMultiMap(map.get(hpid), strategy.confidence, usedCompare, minMatchThreshold, ambiguityWindow);
    if (res.verdict === 'definitive') {
      usedCompare.add(res.index);
      return { kind: 'match', match: makeDefinitiveMatch({ bi, ci: res.index, conf: res.confidence, strat: strategy.id, matchType: MatchType.DEFINITIVE, nodeCtx }) };
    }
    if (res.verdict === 'ambiguous') {
      return { kind: 'ambiguous', entry: makeAmbiguousMatch(bi, res.confidence, strategy.id, res.candidates, baseline) };
    }
    return { kind: 'orphan' };
  };
}

function buildIdClassifier(cmpIdxs, passCtx, nodeCtx, strategy) {
  const { usedCompare, matchConfig } = passCtx;
  const { baseline, compareElements } = nodeCtx;
  const { minMatchThreshold, ambiguityWindow } = matchConfig;
  const map = buildMultiMap(compareElements, cmpIdxs, el => el.elementId || null);

  return (bi) => {
    const elId = baseline[bi].elementId;
    if (!elId) return { kind: 'orphan' };
    const res = resolveFromMultiMap(map.get(elId), strategy.confidence, usedCompare, minMatchThreshold, ambiguityWindow);
    if (res.verdict === 'definitive') {
      usedCompare.add(res.index);
      return { kind: 'match', match: makeDefinitiveMatch({ bi, ci: res.index, conf: res.confidence, strat: strategy.id, matchType: MatchType.DEFINITIVE, nodeCtx }) };
    }
    if (res.verdict === 'ambiguous') {
      return { kind: 'ambiguous', entry: makeAmbiguousMatch(bi, res.confidence, strategy.id, res.candidates, baseline) };
    }
    return { kind: 'orphan' };
  };
}

function buildCssSelectorClassifier(cmpIdxs, passCtx, nodeCtx, strategy) {
  const { usedCompare, matchConfig } = passCtx;
  const { baseline, compareElements } = nodeCtx;
  const { minMatchThreshold, ambiguityWindow } = matchConfig;
  const map = buildMultiMap(compareElements, cmpIdxs, el => el.cssSelector ?? null);

  return (bi) => {
    const sel = baseline[bi].cssSelector;
    if (!sel) return { kind: 'orphan' };
    const res = resolveFromMultiMap(map.get(sel), strategy.confidence, usedCompare, minMatchThreshold, ambiguityWindow);
    if (res.verdict === 'definitive') {
      usedCompare.add(res.index);
      return { kind: 'match', match: makeDefinitiveMatch({ bi, ci: res.index, conf: res.confidence, strat: strategy.id, matchType: MatchType.DEFINITIVE, nodeCtx }) };
    }
    if (res.verdict === 'ambiguous') {
      return { kind: 'ambiguous', entry: makeAmbiguousMatch(bi, res.confidence, strategy.id, res.candidates, baseline) };
    }
    return { kind: 'orphan' };
  };
}

function buildXpathClassifier(cmpIdxs, passCtx, nodeCtx, strategy) {
  const { usedCompare, matchConfig } = passCtx;
  const { baseline, compareElements } = nodeCtx;
  const { minMatchThreshold, ambiguityWindow } = matchConfig;
  const map = buildMultiMap(compareElements, cmpIdxs, el => el.xpath ?? null);

  return (bi) => {
    const xp = baseline[bi].xpath;
    if (!xp) return { kind: 'orphan' };
    const res = resolveFromMultiMap(map.get(xp), strategy.confidence, usedCompare, minMatchThreshold, ambiguityWindow);
    if (res.verdict === 'definitive') {
      usedCompare.add(res.index);
      return { kind: 'match', match: makeDefinitiveMatch({ bi, ci: res.index, conf: res.confidence, strat: strategy.id, matchType: MatchType.DEFINITIVE, nodeCtx }) };
    }
    if (res.verdict === 'ambiguous') {
      return { kind: 'ambiguous', entry: makeAmbiguousMatch(bi, res.confidence, strategy.id, res.candidates, baseline) };
    }
    return { kind: 'orphan' };
  };
}

function buildHpidPrefixClassifier(cmpIdxs, passCtx, nodeCtx, strategy) {
  const { usedCompare, minConf } = passCtx;
  const { baseline, compareElements } = nodeCtx;
  const prefixMap = buildMultiMap(compareElements, cmpIdxs, el => {
    const hpid = el.absoluteHpid;
    if (!hpid) return null;
    const lastDot = hpid.lastIndexOf('.');
    return lastDot > 0 ? hpid.substring(0, lastDot) : null;
  });

  return (bi) => {
    const hpid = baseline[bi].absoluteHpid;
    if (!hpid) return { kind: 'orphan' };

    const lastDot = hpid.lastIndexOf('.');
    const prefix  = lastDot > 0 ? hpid.substring(0, lastDot) : null;
    if (!prefix) return { kind: 'orphan' };

    const indices   = prefixMap.get(prefix);
    if (!indices) return { kind: 'orphan' };
    const available = indices.filter(i => !usedCompare.has(i));
    if (available.length !== 1 || strategy.confidence < minConf) {
      return { kind: 'orphan' };
    }
    const ci = available[0];
    usedCompare.add(ci);
    return {
      kind:  'match',
      match: makeDefinitiveMatch({ bi, ci, conf: strategy.confidence, strat: strategy.id, matchType: MatchType.DEFINITIVE, nodeCtx })
    };
  };
}

function buildPositionClassifier(cmpIdxs, passCtx, nodeCtx, strategy) {
  const { usedCompare, minConf, cellSize } = passCtx;
  const { baseline } = nodeCtx;
  const grid        = buildPositionGrid(nodeCtx.compareElements, cmpIdxs, cellSize);
  const usedLocal   = new Set();

  return (bi) => {
    const rect = baseline[bi].rect;
    if (rect?.x == null || rect?.y == null) return { kind: 'orphan' };

    const gridCtx = { grid, cellSize, tag: baseline[bi].tagName, baseConfidence: strategy.confidence };
    const hit     = pickFromGrid(rect.x, rect.y, gridCtx, usedCompare);
    if (hit && hit.confidence >= minConf && !usedLocal.has(hit.index)) {
      usedLocal.add(hit.index);
      usedCompare.add(hit.index);
      return {
        kind:  'match',
        match: makeDefinitiveMatch({ bi, ci: hit.index, conf: hit.confidence, strat: strategy.id, matchType: MatchType.POSITIONAL, nodeCtx })
      };
    }
    return { kind: 'orphan' };
  };
}

const CLASSIFIER_BUILDERS = Object.freeze({
  'test-attribute': buildTestAttributeClassifier,
  'absolute-hpid':  buildAbsoluteHpidClassifier,
  'id':             buildIdClassifier,
  'css-selector':   buildCssSelectorClassifier,
  'xpath':          buildXpathClassifier,
  'hpid-prefix':    buildHpidPrefixClassifier,
  'position':       buildPositionClassifier
});

function buildClassifierForStrategy(cmpIdxs, passCtx, nodeCtx, strategy) {
  const builder = CLASSIFIER_BUILDERS[strategy.id];
  return builder ? builder(cmpIdxs, passCtx, nodeCtx, strategy) : null;
}

class ElementMatcher {
  #minConf;
  #minMatchThreshold;
  #ambiguityWindow;
  #cellSize;
  #anchorAttributes;

  constructor() {
    this.#minConf           = get('comparison.matching.confidenceThreshold', 0.5);
    this.#minMatchThreshold = get('comparison.matching.minMatchThreshold', 0.70);
    this.#ambiguityWindow   = get('comparison.matching.ambiguityWindow', 0.12);
    this.#cellSize          = get('comparison.matching.positionTolerance', 50);
    this.#anchorAttributes  = get('comparison.matching.anchorAttributes');
  }

  async* matchElements(baseline, compareElements) {
    const enabledStrategies = get('comparison.matching.strategies')
      .filter(s => s.enabled)
      .sort((a, b) => b.confidence - a.confidence);

    logger.info('Config-driven matching start', {
      baseline:   baseline.length,
      compare:    compareElements.length,
      strategies: enabledStrategies.map(s => s.id)
    });

    const usedCompare   = new Set();
    const allCmpIdxs    = Array.from({ length: compareElements.length }, (_, i) => i);
    const allBaseIdxs   = Array.from({ length: baseline.length },        (_, i) => i);
    const nodeCtx       = { baseline, compareElements };
    const matchConfig   = {
      anchorAttributes:  this.#anchorAttributes,
      minMatchThreshold: this.#minMatchThreshold,
      ambiguityWindow:   this.#ambiguityWindow
    };
    const passCtx = {
      usedCompare,
      matchConfig,
      minConf:  this.#minConf,
      cellSize: this.#cellSize
    };

    const allMatches   = [];
    const allAmbiguous = [];
    let baselineOrphans = allBaseIdxs;
    let cmpOrphans      = allCmpIdxs;
    const total         = enabledStrategies.length;

    for (let si = 0; si < total; si++) {
      const strategy = enabledStrategies[si];
      const startPct = Math.round((si       / total) * 100);
      const endPct   = Math.round(((si + 1) / total) * 100);
      const classify = buildClassifierForStrategy(cmpOrphans, passCtx, nodeCtx, strategy);

      if (!classify) continue;

      let passResult = null;
      for await (const frame of runChunkedPass(
        baselineOrphans,
        classify,
        { label: strategy.label, startPct, endPct }
      )) {
        if (frame.type === 'result') passResult = frame.payload;
        else yield frame;
      }

      allMatches.push(...passResult.matches);
      allAmbiguous.push(...passResult.ambiguous);
      baselineOrphans = passResult.orphans;
      cmpOrphans      = cmpOrphans.filter(i => !usedCompare.has(i));
    }

    const reservedByAmbiguous = new Set(
      allAmbiguous.flatMap(entry => (entry.ambiguousCandidates ?? []).map(c => c.compareIndex))
    );

    const unmatchedBaseline = baselineOrphans.map(i => baseline[i]);
    const unmatchedCompare  = cmpOrphans
      .filter(i => !reservedByAmbiguous.has(i))
      .map(i => compareElements[i]);

    logger.info('Config-driven matching complete', {
      matched:           allMatches.length,
      ambiguous:         allAmbiguous.length,
      unmatchedBaseline: unmatchedBaseline.length,
      unmatchedCompare:  unmatchedCompare.length
    });

    yield resultFrame({ matches: allMatches, ambiguous: allAmbiguous, unmatchedBaseline, unmatchedCompare });
  }
}

export { ElementMatcher, MatchType, MUTATION_TYPE };
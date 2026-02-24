import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';

const MATCH_STRATEGIES = Object.freeze({
  TEST_ATTRIBUTE:  'test-attribute',
  SEMANTIC_KEY:    'semantic-key',
  SEMANTIC_HASH:   'semantic-hash',
  STRUCTURAL_HASH: 'structural-hash',
  SELECTOR_PATH:   'selector-path',
  ID:              'id',
  POSITION:        'position'
});

// Confidence weights per spec §5.2
// sum of weights: 1.00 + 0.30 + 0.25 + 0.12 + 0.95 + 0.30 = these are individual hit confidences
const CONFIDENCE = Object.freeze({
  TEST_ATTR:       1.00,
  SEMANTIC_KEY:    0.90,
  SEMANTIC_HASH:   0.75,
  STRUCTURAL_HASH: 0.60,
  SELECTOR_PATH:   0.80,
  ID:              0.95,
  POSITION:        0.30
});

class ElementMatcher {
  constructor() {
    this.minConfidence     = get('comparison.confidence.min');
    this.highThreshold     = get('comparison.confidence.high');
    this.positionTolerance = get('comparison.matching.positionTolerance');
    this.priorityAttrs     = get('attributes.priority').slice(0, 4);
  }

  matchElements(baselineElements, compareElements) {
    logger.info('Building lookup maps', {
      baseline: baselineElements.length,
      compare:  compareElements.length
    });

    const maps = this._buildLookupMaps(compareElements);

    const matches            = [];
    const unmatchedBaseline  = [];
    const usedCompare        = new Set();

    for (let i = 0; i < baselineElements.length; i++) {
      const base = baselineElements[i];
      const hit  = this._lookupMatch(base, maps, usedCompare);

      if (hit && hit.confidence >= this.minConfidence) {
        usedCompare.add(hit.index);
        matches.push({
          baselineIndex:   i,
          compareIndex:    hit.index,
          confidence:      hit.confidence,
          strategy:        hit.strategy,
          baselineElement: base,
          compareElement:  compareElements[hit.index]
        });
      } else {
        unmatchedBaseline.push(base);
      }
    }

    const usedSet          = new Set(matches.map(m => m.compareIndex));
    const unmatchedCompare = compareElements.filter((_, i) => !usedSet.has(i));

    logger.info('Matching complete', {
      matched:          matches.length,
      unmatchedBaseline: unmatchedBaseline.length,
      unmatchedCompare:  unmatchedCompare.length
    });

    return { matches, unmatchedBaseline, unmatchedCompare };
  }

  _buildLookupMaps(elements) {
    const testAttr      = new Map();
    const byId          = new Map();
    const semanticKey   = new Map();
    const semanticHash  = new Map();
    const structHash    = new Map();
    const selectorPath  = new Map();
    const grid          = new Map();
    const cellSize      = this.positionTolerance;

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];

      // Priority test-attributes (data-testid etc.)
      for (const attr of this.priorityAttrs) {
        const v = el.attributes?.[attr];
        if (v) {
          testAttr.set(`${attr}::${v}`, i);
          break;
        }
      }

      // Legacy stable ID
      if (el.elementId) {
        byId.set(el.elementId, i);
      }

      // Fingerprint-based lookup (Sprint 2 extraction output)
      const fp = el.fingerprint;
      if (fp) {
        if (fp.semanticKey)    { semanticKey.set(fp.semanticKey, i); }
        if (fp.semanticHash)   { semanticHash.set(fp.semanticHash, i); }
        if (fp.structuralHash) { structHash.set(fp.structuralHash, i); }
        if (fp.selectorPath)   { selectorPath.set(fp.selectorPath, i); }
      }

      // Spatial grid — use boundingRect (extractor field), not legacy position
      const rect = el.boundingRect;
      if (rect?.x != null && rect?.y != null) {
        const key = this._gridKey(rect.x, rect.y, el.tagName, cellSize);
        if (!grid.has(key)) {
          grid.set(key, []);
        }
        grid.get(key).push({ index: i, x: rect.x, y: rect.y });
      }
    }

    return { testAttr, byId, semanticKey, semanticHash, structHash, selectorPath, grid, cellSize };
  }

  _lookupMatch(base, maps, usedCompare) {
    const { testAttr, byId, semanticKey, semanticHash, structHash, selectorPath, grid, cellSize } = maps;

    // 1. Priority test-attributes (highest confidence)
    for (const attr of this.priorityAttrs) {
      const v = base.attributes?.[attr];
      if (!v) {
        continue;
      }
      const idx = testAttr.get(`${attr}::${v}`);
      if (idx != null && !usedCompare.has(idx)) {
        return { index: idx, confidence: CONFIDENCE.TEST_ATTR, strategy: MATCH_STRATEGIES.TEST_ATTRIBUTE };
      }
    }

    // 2. Stable DOM ID
    if (base.elementId) {
      const idx = byId.get(base.elementId);
      if (idx != null && !usedCompare.has(idx)) {
        return { index: idx, confidence: CONFIDENCE.ID, strategy: MATCH_STRATEGIES.ID };
      }
    }

    const fp = base.fingerprint;
    if (fp) {
      // 3. Semantic key (aria-label / role composite — stable across rerenders)
      if (fp.semanticKey) {
        const idx = semanticKey.get(fp.semanticKey);
        if (idx != null && !usedCompare.has(idx)) {
          return { index: idx, confidence: CONFIDENCE.SEMANTIC_KEY, strategy: MATCH_STRATEGIES.SEMANTIC_KEY };
        }
      }

      // 4. Selector path (CSS path built from stable anchors)
      if (fp.selectorPath) {
        const idx = selectorPath.get(fp.selectorPath);
        if (idx != null && !usedCompare.has(idx)) {
          return { index: idx, confidence: CONFIDENCE.SELECTOR_PATH, strategy: MATCH_STRATEGIES.SELECTOR_PATH };
        }
      }

      // 5. Semantic hash (tag + content + semantic attrs — tolerates minor rewording)
      if (fp.semanticHash) {
        const idx = semanticHash.get(fp.semanticHash);
        if (idx != null && !usedCompare.has(idx)) {
          return { index: idx, confidence: CONFIDENCE.SEMANTIC_HASH, strategy: MATCH_STRATEGIES.SEMANTIC_HASH };
        }
      }

      // 6. Structural hash (depth + parent + sibling index)
      if (fp.structuralHash) {
        const idx = structHash.get(fp.structuralHash);
        if (idx != null && !usedCompare.has(idx)) {
          return { index: idx, confidence: CONFIDENCE.STRUCTURAL_HASH, strategy: MATCH_STRATEGIES.STRUCTURAL_HASH };
        }
      }
    }

    // 7. Positional fallback — use boundingRect
    const rect = base.boundingRect;
    if (rect?.x != null && rect?.y != null) {
      return this._positionFallback(rect.x, rect.y, base.tagName, grid, cellSize, usedCompare);
    }

    return null;
  }

  _positionFallback(bx, by, tag, grid, cellSize, usedCompare) {
    let bestIdx  = null;
    let bestDist = Infinity;

    const cx = Math.floor(bx / cellSize);
    const cy = Math.floor(by / cellSize);

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
          if (dist < this.positionTolerance && dist < bestDist) {
            bestDist = dist;
            bestIdx  = index;
          }
        }
      }
    }

    if (bestIdx === null) {
      return null;
    }

    const confidence = Math.max(0.1, 1 - bestDist / this.positionTolerance) * CONFIDENCE.POSITION;
    return { index: bestIdx, confidence, strategy: MATCH_STRATEGIES.POSITION };
  }

  _gridKey(x, y, tag, cellSize) {
    return `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}:${tag}`;
  }
}

export { ElementMatcher, MATCH_STRATEGIES };
import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';

const MATCH_STRATEGIES = {
  TEST_ATTRIBUTE: 'test-attribute',
  ID:             'id',
  CSS_SELECTOR:   'css-selector',
  XPATH:          'xpath',
  POSITION:       'position'
};

const CONFIDENCE = {
  TEST_ATTR: 1.00,
  ID:        0.95,
  CSS:       0.85,
  XPATH:     0.80,
  POSITION:  0.30
};

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

    const matches           = [];
    const unmatchedBaseline = [];
    const usedCompare       = new Set();

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

    const usedSet       = new Set(matches.map(m => m.compareIndex));
    const unmatchedCompare = compareElements.filter((_, i) => !usedSet.has(i));

    logger.info('Matching complete', {
      matched:          matches.length,
      unmatchedBaseline: unmatchedBaseline.length,
      unmatchedCompare:  unmatchedCompare.length
    });

    return { matches, unmatchedBaseline, unmatchedCompare };
  }

  _buildLookupMaps(elements) {
    const testAttr = new Map();
    const byId     = new Map();
    const byCss    = new Map();
    const byXPath  = new Map();
    const grid     = new Map();

    const cellSize = this.positionTolerance;

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];

      for (const attr of this.priorityAttrs) {
        const v = el.attributes?.[attr];
        if (v) { testAttr.set(`${attr}::${v}`, i); break; }
      }

      if (el.elementId) byId.set(el.elementId, i);
      if (el.selectors?.css)   byCss.set(el.selectors.css, i);
      if (el.selectors?.xpath) byXPath.set(el.selectors.xpath, i);

      if (el.position?.x != null && el.position?.y != null) {
        const key = this._gridKey(el.position.x, el.position.y, el.tagName, cellSize);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push({ index: i, x: el.position.x, y: el.position.y });
      }
    }

    return { testAttr, byId, byCss, byXPath, grid, cellSize };
  }

  _lookupMatch(base, { testAttr, byId, byCss, byXPath, grid, cellSize }, usedCompare) {
    for (const attr of this.priorityAttrs) {
      const v = base.attributes?.[attr];
      if (!v) continue;
      const idx = testAttr.get(`${attr}::${v}`);
      if (idx != null && !usedCompare.has(idx)) {
        return { index: idx, confidence: CONFIDENCE.TEST_ATTR, strategy: MATCH_STRATEGIES.TEST_ATTRIBUTE };
      }
    }

    if (base.elementId) {
      const idx = byId.get(base.elementId);
      if (idx != null && !usedCompare.has(idx)) {
        return { index: idx, confidence: CONFIDENCE.ID, strategy: MATCH_STRATEGIES.ID };
      }
    }

    if (base.selectors?.css) {
      const idx = byCss.get(base.selectors.css);
      if (idx != null && !usedCompare.has(idx)) {
        return { index: idx, confidence: CONFIDENCE.CSS, strategy: MATCH_STRATEGIES.CSS_SELECTOR };
      }
    }

    if (base.selectors?.xpath) {
      const idx = byXPath.get(base.selectors.xpath);
      if (idx != null && !usedCompare.has(idx)) {
        return { index: idx, confidence: CONFIDENCE.XPATH, strategy: MATCH_STRATEGIES.XPATH };
      }
    }

    if (base.position?.x != null && base.position?.y != null) {
      return this._positionFallback(base, grid, cellSize, usedCompare);
    }

    return null;
  }

  _positionFallback(base, grid, cellSize, usedCompare) {
    const bx  = base.position.x;
    const by  = base.position.y;
    const tag = base.tagName;

    let bestIdx  = null;
    let bestDist = Infinity;

    const cx = Math.floor(bx / cellSize);
    const cy = Math.floor(by / cellSize);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key      = `${cx + dx}:${cy + dy}:${tag}`;
        const bucket   = grid.get(key);
        if (!bucket) continue;

        for (const { index, x, y } of bucket) {
          if (usedCompare.has(index)) continue;
          const dist = Math.hypot(bx - x, by - y);
          if (dist < this.positionTolerance && dist < bestDist) {
            bestDist = dist;
            bestIdx  = index;
          }
        }
      }
    }

    if (bestIdx === null) return null;

    const confidence = Math.max(0.1, 1 - bestDist / this.positionTolerance) * CONFIDENCE.POSITION;
    return { index: bestIdx, confidence, strategy: MATCH_STRATEGIES.POSITION };
  }

  _gridKey(x, y, tag, cellSize) {
    return `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}:${tag}`;
  }
}

export { ElementMatcher, MATCH_STRATEGIES };
import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';

const MATCH_STRATEGIES = {
  TEST_ATTRIBUTE: 'test-attribute',
  ID:             'id',
  CSS_SELECTOR:   'css-selector',
  XPATH:          'xpath',
  POSITION:       'position'
};

class ElementMatcher {
  constructor() {
    // All thresholds read from config — no CONFIDENCE_THRESHOLDS object
    this.minConfidence   = get('comparison.confidence.min');
    this.highThreshold   = get('comparison.confidence.high');
    this.positionTolerance = get('comparison.matching.positionTolerance');
    this.priorityAttrs   = get('attributes.priority');
    this.strategies      = this._initStrategies();
  }

  _initStrategies() {
    return [
      { name: MATCH_STRATEGIES.TEST_ATTRIBUTE, weight: 1.0,  fn: this._matchByTestAttribute.bind(this) },
      { name: MATCH_STRATEGIES.ID,             weight: 0.95, fn: this._matchById.bind(this) },
      { name: MATCH_STRATEGIES.CSS_SELECTOR,   weight: 0.85, fn: this._matchByCssSelector.bind(this) },
      { name: MATCH_STRATEGIES.XPATH,          weight: 0.80, fn: this._matchByXPath.bind(this) },
      { name: MATCH_STRATEGIES.POSITION,       weight: 0.30, fn: this._matchByPosition.bind(this) }
    ];
  }

  matchElements(baselineElements, compareElements) {
    const matches           = [];
    const unmatchedBaseline = new Set(baselineElements.map((_, i) => i));
    const unmatchedCompare  = new Set(compareElements.map((_, i) => i));

    logger.info('Starting element matching', {
      baseline: baselineElements.length,
      compare:  compareElements.length
    });

    for (let baseIdx = 0; baseIdx < baselineElements.length; baseIdx++) {
      const baseElement  = baselineElements[baseIdx];
      let bestMatch      = null;
      let bestConfidence = 0;
      let bestStrategy   = null;

      for (const strategy of this.strategies) {
        const match = strategy.fn(baseElement, compareElements, unmatchedCompare);
        if (match && match.confidence > bestConfidence) {
          bestMatch      = match;
          bestConfidence = match.confidence;
          bestStrategy   = strategy.name;
        }
        // Early exit when confidence is high enough — no need to try weaker strategies
        if (bestConfidence >= this.highThreshold) break;
      }

      if (bestMatch && bestConfidence >= this.minConfidence) {
        matches.push({
          baselineIndex:    baseIdx,
          compareIndex:     bestMatch.index,
          confidence:       bestConfidence,
          strategy:         bestStrategy,
          baselineElement:  baseElement,
          compareElement:   compareElements[bestMatch.index]
        });
        unmatchedBaseline.delete(baseIdx);
        unmatchedCompare.delete(bestMatch.index);
      }
    }

    logger.info('Matching complete', {
      matched:           matches.length,
      unmatchedBaseline: unmatchedBaseline.size,
      unmatchedCompare:  unmatchedCompare.size
    });

    return {
      matches,
      unmatchedBaseline: Array.from(unmatchedBaseline).map(i => baselineElements[i]),
      unmatchedCompare:  Array.from(unmatchedCompare).map(i => compareElements[i])
    };
  }

  _matchByTestAttribute(baseElement, compareElements, unmatchedIndices) {
    // Use config-driven priority attribute list — not a hardcoded array
    const testAttrs = this.priorityAttrs.slice(0, 4); // data-testid, data-test, data-qa, data-cy
    for (const attr of testAttrs) {
      const baseValue = baseElement.attributes?.[attr];
      if (!baseValue) continue;
      for (const idx of unmatchedIndices) {
        if (compareElements[idx].attributes?.[attr] === baseValue) {
          return { index: idx, confidence: 1.0 };
        }
      }
    }
    return null;
  }

  _matchById(baseElement, compareElements, unmatchedIndices) {
    const baseId = baseElement.elementId;
    if (!baseId) return null;
    for (const idx of unmatchedIndices) {
      if (compareElements[idx].elementId === baseId) {
        return { index: idx, confidence: 0.95 };
      }
    }
    return null;
  }

  _matchByCssSelector(baseElement, compareElements, unmatchedIndices) {
    const baseCss = baseElement.selectors?.css;
    if (!baseCss) return null;
    const baseConf = (baseElement.selectors?.cssConfidence || 0) / 100;
    for (const idx of unmatchedIndices) {
      const el = compareElements[idx];
      if (el.selectors?.css === baseCss) {
        const compareConf = (el.selectors?.cssConfidence || 0) / 100;
        return { index: idx, confidence: Math.max(0.85, (baseConf + compareConf) / 2) };
      }
    }
    return null;
  }

  _matchByXPath(baseElement, compareElements, unmatchedIndices) {
    const baseXPath = baseElement.selectors?.xpath;
    if (!baseXPath) return null;
    const baseConf = (baseElement.selectors?.xpathConfidence || 0) / 100;
    for (const idx of unmatchedIndices) {
      const el = compareElements[idx];
      if (el.selectors?.xpath === baseXPath) {
        const compareConf = (el.selectors?.xpathConfidence || 0) / 100;
        return { index: idx, confidence: Math.max(0.80, (baseConf + compareConf) / 2) };
      }
    }
    return null;
  }

  _matchByPosition(baseElement, compareElements, unmatchedIndices) {
    const basePos = baseElement.position;
    if (!basePos?.x || !basePos?.y) return null;

    let closestIdx  = null;
    let closestDist = Infinity;

    for (const idx of unmatchedIndices) {
      const el = compareElements[idx];
      if (el.tagName !== baseElement.tagName) continue;
      const pos = el.position;
      if (!pos?.x || !pos?.y) continue;

      const dist = Math.hypot(basePos.x - pos.x, basePos.y - pos.y);
      if (dist < this.positionTolerance && dist < closestDist) {
        closestDist = dist;
        closestIdx  = idx;
      }
    }

    if (closestIdx !== null) {
      const confidence = Math.max(0.3, 1 - (closestDist / this.positionTolerance)) * 0.3;
      return { index: closestIdx, confidence };
    }

    return null;
  }
}

export { ElementMatcher, MATCH_STRATEGIES };
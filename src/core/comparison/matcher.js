import logger from '../../infrastructure/logger.js';
import { get } from '../../config/defaults.js';

const MATCH_STRATEGIES = {
  TEST_ATTRIBUTE: 'test-attribute',
  ID: 'id',
  CSS_SELECTOR: 'css-selector',
  XPATH: 'xpath',
  POSITION: 'position'
};

const CONFIDENCE_THRESHOLDS = {
  HIGH: 0.9,
  MEDIUM: 0.7,
  LOW: 0.5
};

class ElementMatcher {
  constructor() {
    this.minConfidence = get('comparison.minConfidence', 0.5);
    this.strategies = this._initStrategies();
  }

  _initStrategies() {
    return [
      { name: MATCH_STRATEGIES.TEST_ATTRIBUTE, weight: 1.0, fn: this._matchByTestAttribute.bind(this) },
      { name: MATCH_STRATEGIES.ID, weight: 0.95, fn: this._matchById.bind(this) },
      { name: MATCH_STRATEGIES.CSS_SELECTOR, weight: 0.85, fn: this._matchByCssSelector.bind(this) },
      { name: MATCH_STRATEGIES.XPATH, weight: 0.8, fn: this._matchByXPath.bind(this) },
      { name: MATCH_STRATEGIES.POSITION, weight: 0.3, fn: this._matchByPosition.bind(this) }
    ];
  }

  matchElements(baselineElements, compareElements) {
    const matches = [];
    const unmatchedBaseline = new Set(baselineElements.map((_, i) => i));
    const unmatchedCompare = new Set(compareElements.map((_, i) => i));

    logger.info('Starting element matching', {
      baseline: baselineElements.length,
      compare: compareElements.length
    });

    for (let baseIdx = 0; baseIdx < baselineElements.length; baseIdx++) {
      const baseElement = baselineElements[baseIdx];
      let bestMatch = null;
      let bestConfidence = 0;
      let bestStrategy = null;

      for (const strategy of this.strategies) {
        const match = strategy.fn(baseElement, compareElements, unmatchedCompare);
        
        if (match && match.confidence > bestConfidence) {
          bestMatch = match;
          bestConfidence = match.confidence;
          bestStrategy = strategy.name;
        }

        if (bestConfidence >= CONFIDENCE_THRESHOLDS.HIGH) {
          break;
        }
      }

      if (bestMatch && bestConfidence >= this.minConfidence) {
        matches.push({
          baselineIndex: baseIdx,
          compareIndex: bestMatch.index,
          confidence: bestConfidence,
          strategy: bestStrategy,
          baselineElement: baseElement,
          compareElement: compareElements[bestMatch.index]
        });

        unmatchedBaseline.delete(baseIdx);
        unmatchedCompare.delete(bestMatch.index);
      }
    }

    logger.info('Matching complete', {
      matched: matches.length,
      unmatchedBaseline: unmatchedBaseline.size,
      unmatchedCompare: unmatchedCompare.size
    });

    return {
      matches,
      unmatchedBaseline: Array.from(unmatchedBaseline).map(i => baselineElements[i]),
      unmatchedCompare: Array.from(unmatchedCompare).map(i => compareElements[i])
    };
  }

  _matchByTestAttribute(baseElement, compareElements, unmatchedIndices) {
    const testAttrs = ['data-testid', 'data-test', 'data-qa', 'data-cy'];
    
    for (const attr of testAttrs) {
      const baseValue = baseElement.attributes[attr];
      if (!baseValue) continue;

      for (const idx of unmatchedIndices) {
        const compareElement = compareElements[idx];
        const compareValue = compareElement.attributes[attr];

        if (baseValue === compareValue) {
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
      const compareElement = compareElements[idx];
      
      if (compareElement.elementId === baseId) {
        return { index: idx, confidence: 0.95 };
      }
    }

    return null;
  }

  _matchByCssSelector(baseElement, compareElements, unmatchedIndices) {
    const baseCss = baseElement.selectors?.css;
    if (!baseCss) return null;

    const baseConfidence = baseElement.selectors?.cssConfidence || 0;

    for (const idx of unmatchedIndices) {
      const compareElement = compareElements[idx];
      const compareCss = compareElement.selectors?.css;
      const compareConfidence = compareElement.selectors?.cssConfidence || 0;

      if (baseCss === compareCss && baseCss) {
        const avgConfidence = (baseConfidence + compareConfidence) / 200;
        return { index: idx, confidence: Math.max(0.85, avgConfidence) };
      }
    }

    return null;
  }

  _matchByXPath(baseElement, compareElements, unmatchedIndices) {
    const baseXPath = baseElement.selectors?.xpath;
    if (!baseXPath) return null;

    const baseConfidence = baseElement.selectors?.xpathConfidence || 0;

    for (const idx of unmatchedIndices) {
      const compareElement = compareElements[idx];
      const compareXPath = compareElement.selectors?.xpath;
      const compareConfidence = compareElement.selectors?.xpathConfidence || 0;

      if (baseXPath === compareXPath && baseXPath) {
        const avgConfidence = (baseConfidence + compareConfidence) / 200;
        return { index: idx, confidence: Math.max(0.8, avgConfidence) };
      }
    }

    return null;
  }

  _matchByPosition(baseElement, compareElements, unmatchedIndices) {
    const basePos = baseElement.position;
    if (!basePos || !basePos.x || !basePos.y) return null;

    const tolerance = get('comparison.positionTolerance', 50);
    let closestMatch = null;
    let closestDistance = Infinity;

    for (const idx of unmatchedIndices) {
      const compareElement = compareElements[idx];
      const comparePos = compareElement.position;

      if (!comparePos || !comparePos.x || !comparePos.y) continue;

      if (baseElement.tagName !== compareElement.tagName) continue;

      const dx = Math.abs(basePos.x - comparePos.x);
      const dy = Math.abs(basePos.y - comparePos.y);
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < tolerance && distance < closestDistance) {
        closestDistance = distance;
        closestMatch = idx;
      }
    }

    if (closestMatch !== null) {
      const confidence = Math.max(0.3, 1 - (closestDistance / tolerance)) * 0.3;
      return { index: closestMatch, confidence };
    }

    return null;
  }
}

export { ElementMatcher, MATCH_STRATEGIES, CONFIDENCE_THRESHOLDS };
/**
 * STATIC MATCHER
 * Matches elements across pages using stable identifiers
 * 6 strategies in priority order with confidence scoring
 * Uses selector metadata (strategy, robustness) from generators
 * 
 * Strategy Confidence Scores:
 * 1. data-testid: 0.98 (test automation attributes)
 * 2. stable-id: 0.95 (non-dynamic IDs)
 * 3. css-selector: 0.90 (high-quality CSS selectors)
 * 4. xpath: 0.85 (high-quality XPath selectors)
 * 5. position: 0.50-0.70 (spatial proximity, distance-based)
 * 6. text-content: 0.60 (exact text match with tag)
 */

import config from '../../../infrastructure/config.js';
import logger from '../../../infrastructure/logger.js';

export class StaticMatcher {
  constructor() {
    // Configuration
    this.testAttributes = [
      'data-testid', 'data-test', 'data-qa', 'data-cy',
      'data-automation-id', 'data-key', 'data-record-id',
      'data-component-id', 'data-row-key-value'
    ];
    
    // Get strategy confidence scores from config
    this.strategyConfidence = config.get('matching.strategyConfidence', {
      'data-testid': 0.98,
      'stable-id': 0.95,
      'css-selector': 0.90,
      'xpath': 0.85,
      'position': 0.70,
      'text-content': 0.60
    });
  }
  
  /**
   * Match baseline elements to compare elements
   * @param {Array} baselineElements - Elements from baseline page
   * @param {Array} compareElements - Elements from compare page
   * @param {Object} options - Matching options (overrides config defaults)
   * @returns {Object} { matches: [], unmatched: { baseline: [], compare: [] }, stats: {} }
   */
  match(baselineElements, compareElements, options = {}) {
    // Add comprehensive validation
    if (!Array.isArray(baselineElements)) {
      throw new TypeError('baselineElements must be an array');
    }

    if (!Array.isArray(compareElements)) {
      throw new TypeError('compareElements must be an array');
    }

    if (baselineElements.length === 0 || compareElements.length === 0) {
      logger.warn('Empty element arrays', {
        baselineCount: baselineElements.length,
        compareCount: compareElements.length
      });
      return this._emptyResult();
    }

    // Apply defaults from config.matching
    const configMatching = config.getSection('matching');
    const {
      minConfidence = configMatching.minConfidence || 0.50,
      positionTolerance = configMatching.positionTolerance || 50,
      enableTextMatch = true
    } = options;
    
    logger.debug('Starting static matching', {
      baselineCount: baselineElements.length,
      compareCount: compareElements.length,
      minConfidence,
      positionTolerance
    });
    
    const matches = [];
    const unmatchedBaseline = [];
    const unmatchedCompare = new Set(compareElements);
    
    for (const baseEl of baselineElements) {
      try {
        const match = this._findBestMatch(
          baseEl,
          Array.from(unmatchedCompare),
          { minConfidence, positionTolerance, enableTextMatch }
        );
        
        if (match && match.confidence >= minConfidence) {
          matches.push(match);
          unmatchedCompare.delete(match.compare);
        } else {
          unmatchedBaseline.push(baseEl);
        }
      } catch (error) {
        logger.warn('Error matching element', {
          error: error.message,
          element: baseEl.tagName,
          index: baseEl.index
        });
        unmatchedBaseline.push(baseEl);
      }
    }
    
    const avgConfidence = this._calculateAvgConfidence(matches);
    
    logger.info('Static matching complete', {
      matched: matches.length,
      unmatchedBaseline: unmatchedBaseline.length,
      unmatchedCompare: unmatchedCompare.size,
      avgConfidence
    });
    
    return {
      matches,
      unmatched: {
        baseline: unmatchedBaseline,
        compare: Array.from(unmatchedCompare)
      },
      stats: {
        totalBaseline: baselineElements.length,
        totalCompare: compareElements.length,
        matched: matches.length,
        matchRate: (matches.length / baselineElements.length * 100).toFixed(1) + '%',
        avgConfidence
      }
    };
  }
  
  /**
   * Find best match for single baseline element
   * Tries strategies in priority order, returns first valid match
   */
  _findBestMatch(baseEl, comparePool, options) {
    if (!baseEl || !comparePool || comparePool.length === 0) {
      return null;
    }
    
    // Strategy 1: data-testid match (98% confidence)
    const testIdMatch = this._matchByTestId(baseEl, comparePool);
    if (testIdMatch) return testIdMatch;
    
    // Strategy 2: Stable ID match (95% confidence)
    const stableIdMatch = this._matchByStableId(baseEl, comparePool);
    if (stableIdMatch) return stableIdMatch;
    
    // Strategy 3: CSS selector match (90% confidence)
    const cssMatch = this._matchBySelector(baseEl, comparePool, 'css');
    if (cssMatch) return cssMatch;
    
    // Strategy 4: XPath match (85% confidence)
    const xpathMatch = this._matchBySelector(baseEl, comparePool, 'xpath');
    if (xpathMatch) return xpathMatch;
    
    // Strategy 5: Position match (50-70% confidence)
    const positionMatch = this._matchByPosition(baseEl, comparePool, options.positionTolerance);
    if (positionMatch) return positionMatch;
    
    // Strategy 6: Text content match (60% confidence)
    if (options.enableTextMatch) {
      const textMatch = this._matchByText(baseEl, comparePool);
      if (textMatch) return textMatch;
    }
    
    return null;
  }
  
  /**
   * Strategy 1: Match by data-testid (or similar test attributes)
   * Confidence: 98% (highest - explicitly set for automation)
   */
  _matchByTestId(baseEl, comparePool) {
    try {
      // Check XPath metadata for test attribute strategy
      const baseMeta = baseEl.xpathMeta || {};
      const baseStrategy = baseMeta.strategy || '';
      
      // Check if baseline used test attribute strategy
      const usedTestAttr = this.testAttributes.some(attr => 
        baseStrategy.includes(attr) || baseStrategy.includes('test-attr')
      );
      
      if (!usedTestAttr) return null;
      
      // Extract attribute value from XPath
      const baseXPath = baseEl.xpath || '';
      for (const attr of this.testAttributes) {
        const match = baseXPath.match(new RegExp(`\\[@${attr}=['"]?([^'"\\]]+)`));
        if (!match) continue;
        
        const baseValue = match[1];
        if (!baseValue) continue;
        
        // Find compare element with same attribute value
        for (const compEl of comparePool) {
          const compXPath = compEl.xpath || '';
          const compMatch = compXPath.match(new RegExp(`\\[@${attr}=['"]?([^'"\\]]+)`));
          
          if (compMatch && compMatch[1] === baseValue) {
            return {
              baseline: baseEl,
              compare: compEl,
              confidence: this.strategyConfidence['data-testid'],
              strategy: 'data-testid',
              matchedOn: `${attr}="${baseValue}"`,
              metadata: {
                baselineRobustness: baseMeta.robustness || 0,
                compareRobustness: (compEl.xpathMeta || {}).robustness || 0
              }
            };
          }
        }
      }
    } catch (error) {
      logger.debug('data-testid match failed', { error: error.message });
    }
    
    return null;
  }
  
  /**
   * Strategy 2: Match by stable ID
   * Confidence: 95% (very high - IDs are unique)
   */
  _matchByStableId(baseEl, comparePool) {
    try {
      // Check if baseline has stable ID strategy
      const xpathMeta = baseEl.xpathMeta || {};
      const cssMeta = baseEl.cssMeta || {};
      
      const hasStableId = (
        xpathMeta.strategy === 'stable-id' ||
        cssMeta.strategy === 'stable-id' ||
        xpathMeta.tier === 2 ||
        cssMeta.tier === 1
      );
      
      if (!hasStableId) return null;
      
      // Extract ID from element
      const baseId = baseEl.id;
      if (!baseId || baseId.length === 0) return null;
      
      // Find compare element with same ID
      for (const compEl of comparePool) {
        if (compEl.id === baseId) {
          // Use higher robustness score from either selector
          const baseRobustness = Math.max(
            xpathMeta.robustness || 0,
            cssMeta.robustness || 0
          );
          
          const compRobustness = Math.max(
            (compEl.xpathMeta || {}).robustness || 0,
            (compEl.cssMeta || {}).robustness || 0
          );
          
          return {
            baseline: baseEl,
            compare: compEl,
            confidence: this.strategyConfidence['stable-id'],
            strategy: 'stable-id',
            matchedOn: `id="${baseId}"`,
            metadata: {
              baselineRobustness: baseRobustness,
              compareRobustness: compRobustness,
              tier: Math.min(xpathMeta.tier || 99, cssMeta.tier || 99)
            }
          };
        }
      }
    } catch (error) {
      logger.debug('stable-id match failed', { error: error.message });
    }
    
    return null;
  }
  
  /**
   * Strategy 3/4: Match by selector (CSS or XPath)
   * Confidence: 90% (CSS) / 85% (XPath)
   */
  _matchBySelector(baseEl, comparePool, type = 'css') {
    try {
      const baseSelectorStr = type === 'css' ? baseEl.cssSelector : baseEl.xpath;
      const baseMeta = type === 'css' ? (baseEl.cssMeta || {}) : (baseEl.xpathMeta || {});
      
      if (!baseSelectorStr) return null;
      
      // Quality thresholds
      const tier = baseMeta.tier || 99;
      const robustness = baseMeta.robustness || 0;
      
      // Only match if selector is high-quality
      // Tier ≤10 ensures top-tier strategies
      // Robustness ≥70 ensures selector stability
      if (tier > 10 || robustness < 70) return null;
      
      // Find exact selector match
      for (const compEl of comparePool) {
        const compSelectorStr = type === 'css' ? compEl.cssSelector : compEl.xpath;
        const compMeta = type === 'css' ? (compEl.cssMeta || {}) : (compEl.xpathMeta || {});
        
        if (this._selectorsEquivalent(baseSelectorStr, compSelectorStr)) {
          return {
            baseline: baseEl,
            compare: compEl,
            confidence: type === 'css' ? this.strategyConfidence['css-selector'] : this.strategyConfidence['xpath'],
            strategy: type === 'css' ? 'css-selector' : 'xpath',
            matchedOn: baseSelectorStr.substring(0, 100),
            metadata: {
              baselineTier: tier,
              baselineRobustness: robustness,
              baselineStrategy: baseMeta.strategy,
              compareTier: compMeta.tier || 99,
              compareRobustness: compMeta.robustness || 0,
              compareStrategy: compMeta.strategy
            }
          };
        }
      }
    } catch (error) {
      logger.debug(`${type}-selector match failed`, { error: error.message });
    }
    
    return null;
  }
  
  /**
   * Strategy 5: Match by position (within tolerance)
   * Confidence: 50-70% (lower - position can change)
   * Confidence increases as distance decreases
   */
  _matchByPosition(baseEl, comparePool, tolerance = 50) {
    try {
      const basePos = baseEl.positionObj || this._parsePositionString(baseEl.position);
      if (!basePos || (basePos.x === 0 && basePos.y === 0)) return null;
      
      let closest = null;
      let minDistance = Infinity;
      
      for (const compEl of comparePool) {
        // Must be same tag for position matching
        if (compEl.tagName !== baseEl.tagName) continue;
        
        const compPos = compEl.positionObj || this._parsePositionString(compEl.position);
        if (!compPos) continue;
        
        // Calculate Euclidean distance
        const distance = Math.sqrt(
          Math.pow(compPos.x - basePos.x, 2) +
          Math.pow(compPos.y - basePos.y, 2)
        );
        
        // Must be within tolerance and closer than previous matches
        if (distance <= tolerance && distance < minDistance) {
          closest = compEl;
          minDistance = distance;
        }
      }
      
      if (closest) {
        // Calculate confidence based on distance
        // Closer = higher confidence
        // Range: minimum config value (at tolerance) to position config value (at 0 distance)
        const positionConfidence = this.strategyConfidence['position'] || 0.70;
        const minPositionConfidence = 0.50;
        const confidenceRatio = 1 - (minDistance / tolerance);
        const confidence = minPositionConfidence + (confidenceRatio * (positionConfidence - minPositionConfidence));
        
        return {
          baseline: baseEl,
          compare: closest,
          confidence: parseFloat(confidence.toFixed(2)),
          strategy: 'position',
          matchedOn: `within ${Math.round(minDistance)}px`,
          metadata: {
            distance: Math.round(minDistance),
            tolerance: tolerance,
            sameTag: true,
            baselinePos: basePos,
            comparePos: closest.positionObj || this._parsePositionString(closest.position)
          }
        };
      }
    } catch (error) {
      logger.debug('position match failed', { error: error.message });
    }
    
    return null;
  }
  
  /**
   * Strategy 6: Match by text content
   * Confidence: 60% (lowest - text can change)
   */
  _matchByText(baseEl, comparePool) {
    try {
      const baseText = (baseEl.textContent || '').trim();
      
      // Must have meaningful text (>5 chars, not too long)
      if (!baseText || baseText.length < 5 || baseText.length > 200) {
        return null;
      }
      
      for (const compEl of comparePool) {
        const compText = (compEl.textContent || '').trim();
        
        // Must match tag and text exactly
        if (compEl.tagName === baseEl.tagName && compText === baseText) {
          return {
            baseline: baseEl,
            compare: compEl,
            confidence: this.strategyConfidence['text-content'],
            strategy: 'text-content',
            matchedOn: baseText.substring(0, 50),
            metadata: {
              textLength: baseText.length,
              sameTag: true
            }
          };
        }
      }
    } catch (error) {
      logger.debug('text-content match failed', { error: error.message });
    }
    
    return null;
  }
  
  // ==================== HELPER METHODS ====================
  
  /**
   * Check if two selectors are equivalent
   * Handles whitespace normalization
   */
  _selectorsEquivalent(sel1, sel2) {
    if (!sel1 || !sel2) return false;
    if (sel1 === sel2) return true;

    try {
      // Normalize whitespace around combinators
      const normalize = (sel) => sel
        .replace(/\s*([>+~])\s*/g, '$1') // Remove spaces around combinators
        .replace(/\s+/g, ' ')             // Normalize multiple spaces
        .trim()
        .toLowerCase();                   // Case-insensitive

      return normalize(sel1) === normalize(sel2);
    } catch (error) {
      return false;
    }
  }
  
  /**
   * Parse legacy position string "top,left" to {x, y}
   * Supports both "top,left" and "left,top" formats
   */
  _parsePositionString(positionStr) {
    if (!positionStr || typeof positionStr !== 'string') return null;
    
    try {
      const parts = positionStr.split(',');
      if (parts.length !== 2) return null;
      
      const top = parseFloat(parts[0]);
      const left = parseFloat(parts[1]);
      
      if (isNaN(top) || isNaN(left)) return null;
      
      // Return as {x, y} for consistency
      return { x: left, y: top };
    } catch (error) {
      return null;
    }
  }
  
  /**
   * Calculate average confidence across all matches
   */
  _calculateAvgConfidence(matches) {
    if (!matches || matches.length === 0) return '0%';
    
    try {
      const sum = matches.reduce((acc, m) => acc + (m.confidence || 0), 0);
      return (sum / matches.length * 100).toFixed(1) + '%';
    } catch (error) {
      return '0%';
    }
  }
  
  /**
   * Return empty result structure
   */
  _emptyResult() {
    return {
      matches: [],
      unmatched: {
        baseline: [],
        compare: []
      },
      stats: {
        totalBaseline: 0,
        totalCompare: 0,
        matched: 0,
        matchRate: '0%',
        avgConfidence: '0%'
      }
    };
  }
}

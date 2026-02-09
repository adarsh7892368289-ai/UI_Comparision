/**
 * POSITION MATCHER
 * Fallback matcher using spatial proximity
 * Lower confidence but always produces matches when possible
 * 
 * Key Features:
 * - Euclidean distance calculation
 * - Configurable tolerance (default: 50px)
 * - Tag matching (optional)
 * - Distance-based confidence scoring
 * - Confidence range: 0.50-0.70
 */

import config from '../../../infrastructure/config.js';
import logger from '../../../infrastructure/logger.js';

export class PositionMatcher {
  
  /**
   * Match elements by position (within tolerance)
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
      tolerance = configMatching.positionTolerance || 50,
      requireSameTag = true,
      minConfidence = configMatching.minConfidence || 0.50
    } = options;
    
    logger.debug('Starting position matching', {
      baselineCount: baselineElements.length,
      compareCount: compareElements.length,
      tolerance,
      requireSameTag
    });
    
    const matches = [];
    const unmatchedBaseline = [];
    const unmatchedCompare = new Set(compareElements);
    
    for (const baseEl of baselineElements) {
      try {
        const match = this._findClosestMatch(
          baseEl,
          Array.from(unmatchedCompare),
          { tolerance, requireSameTag }
        );
        
        if (match && match.confidence >= minConfidence) {
          matches.push(match);
          unmatchedCompare.delete(match.compare);
        } else {
          unmatchedBaseline.push(baseEl);
        }
      } catch (error) {
        logger.warn('Error matching element by position', {
          error: error.message,
          element: baseEl.tagName,
          index: baseEl.index
        });
        unmatchedBaseline.push(baseEl);
      }
    }
    
    const avgDistance = this._calculateAvgDistance(matches);
    
    logger.info('Position matching complete', {
      matched: matches.length,
      unmatchedBaseline: unmatchedBaseline.length,
      unmatchedCompare: unmatchedCompare.size,
      avgDistance
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
        avgDistance
      }
    };
  }
  
  /**
   * Find closest element by position
   * @param {Object} baseEl - Baseline element
   * @param {Array} comparePool - Pool of compare elements
   * @param {Object} options - Matching options
   * @returns {Object|null} Match object or null
   */
  _findClosestMatch(baseEl, comparePool, options) {
    if (!baseEl || !comparePool || comparePool.length === 0) {
      return null;
    }
    
    try {
      const basePos = this._getPosition(baseEl);
      if (!basePos || !this._isValidPosition(basePos)) {
        return null;
      }
      
      let closest = null;
      let minDistance = Infinity;
      
      for (const compEl of comparePool) {
        // Filter by tag if required
        if (options.requireSameTag && compEl.tagName !== baseEl.tagName) {
          continue;
        }
        
        const compPos = this._getPosition(compEl);
        if (!compPos || !this._isValidPosition(compPos)) {
          continue;
        }
        
        // Calculate Euclidean distance
        const distance = this._calculateDistance(basePos, compPos);
        
        // Must be within tolerance and closer than previous matches
        if (distance <= options.tolerance && distance < minDistance) {
          closest = compEl;
          minDistance = distance;
        }
      }
      
      if (closest) {
        // Calculate confidence based on distance
        // Closer = higher confidence
        // Range: 0.50 (at tolerance) to 0.70 (at 0 distance)
        const confidenceRatio = 1 - (minDistance / options.tolerance);
        const confidence = 0.50 + (confidenceRatio * 0.20);
        
        return {
          baseline: baseEl,
          compare: closest,
          confidence: parseFloat(confidence.toFixed(2)),
          strategy: 'position',
          matchedOn: `within ${Math.round(minDistance)}px`,
          metadata: {
            distance: Math.round(minDistance),
            tolerance: options.tolerance,
            sameTag: closest.tagName === baseEl.tagName,
            baselinePos: basePos,
            comparePos: this._getPosition(closest)
          }
        };
      }
    } catch (error) {
      logger.debug('Failed to find closest match', { 
        error: error.message,
        element: baseEl?.tagName 
      });
    }
    
    return null;
  }
  
  /**
   * Get position from element
   * Supports both positionObj and legacy position string
   * @param {Object} element - Element object
   * @returns {Object|null} { x, y } or null
   */
  _getPosition(element) {
    if (!element) return null;
    
    try {
      // Try structured position object first
      if (element.positionObj) {
        return {
          x: element.positionObj.x || element.positionObj.left || 0,
          y: element.positionObj.y || element.positionObj.top || 0
        };
      }
      
      // Fall back to parsing position string
      if (element.position && typeof element.position === 'string') {
        return this._parsePositionString(element.position);
      }
    } catch (error) {
      logger.debug('Failed to get position', { error: error.message });
    }
    
    return null;
  }
  
  /**
   * Parse position string "top,left" to {x, y}
   * @param {string} positionStr - Position string
   * @returns {Object|null} { x, y } or null
   */
  _parsePositionString(positionStr) {
    if (!positionStr || typeof positionStr !== 'string') return null;
    
    try {
      const parts = positionStr.split(',');
      if (parts.length !== 2) return null;
      
      const top = parseFloat(parts[0]);
      const left = parseFloat(parts[1]);
      
      if (isNaN(top) || isNaN(left)) return null;
      
      return { x: left, y: top };
    } catch (error) {
      return null;
    }
  }
  
  /**
   * Check if position is valid (not at 0,0 and not invalid)
   * @param {Object} pos - Position object { x, y }
   * @returns {boolean} True if valid
   */
  _isValidPosition(pos) {
    if (!pos) return false;
    
    // Check for valid numbers
    if (typeof pos.x !== 'number' || typeof pos.y !== 'number') return false;
    if (isNaN(pos.x) || isNaN(pos.y)) return false;
    if (!isFinite(pos.x) || !isFinite(pos.y)) return false;
    
    // Note: We don't reject (0,0) as some elements may legitimately be at origin
    return true;
  }
  
  /**
   * Calculate Euclidean distance between two positions
   * @param {Object} pos1 - Position 1 { x, y }
   * @param {Object} pos2 - Position 2 { x, y }
   * @returns {number} Distance in pixels
   */
  _calculateDistance(pos1, pos2) {
    if (!pos1 || !pos2) return Infinity;
    
    try {
      const dx = pos2.x - pos1.x;
      const dy = pos2.y - pos1.y;
      
      return Math.sqrt(dx * dx + dy * dy);
    } catch (error) {
      logger.debug('Distance calculation failed', { error: error.message });
      return Infinity;
    }
  }
  
  /**
   * Calculate average distance across all matches
   * @param {Array} matches - Match objects
   * @returns {string} Average distance with unit
   */
  _calculateAvgDistance(matches) {
    if (!matches || matches.length === 0) return '0px';
    
    try {
      const sum = matches.reduce((acc, m) => {
        return acc + (m.metadata?.distance || 0);
      }, 0);
      
      return Math.round(sum / matches.length) + 'px';
    } catch (error) {
      return '0px';
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
        avgDistance: '0px'
      }
    };
  }
}

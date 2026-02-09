/**
 * MATCHER ENGINE
 * Orchestrates all matching strategies
 * Provides unified interface for element matching
 */

import config from '../../infrastructure/config.js';
import logger from '../../infrastructure/logger.js';
import { DynamicMatcher } from '../strategies/matching/dynamic-matcher.js';
import { PositionMatcher } from '../strategies/matching/position-matcher.js';
import { StaticMatcher } from '../strategies/matching/static-matcher.js';
import { DetectorEngine } from './detector-engine.js';

export class MatcherEngine {
  constructor() {
    this.staticMatcher = new StaticMatcher();
    this.dynamicMatcher = new DynamicMatcher();
    this.positionMatcher = new PositionMatcher();
    this.detector = new DetectorEngine();
  }
  
  /**
   * Match elements across two pages
   * @param {Array} baselineElements - Elements from baseline page
   * @param {Array} compareElements - Elements from compare page
   * @param {Object} options - Matching options (overrides config defaults)
   * @returns {Object} Match results with comprehensive stats
   */
  match(baselineElements, compareElements, options = {}) {
    // Apply defaults from config.matching
    const configMatching = config.getSection('matching');
    const {
      mode = configMatching.defaultMode || 'static',
      minConfidence = configMatching.minConfidence || 0.50,
      positionTolerance = configMatching.positionTolerance || 50,
      templateThreshold = configMatching.templateThreshold || 0.90,
      enableFallback = configMatching.enableFallback !== undefined ? configMatching.enableFallback : true
    } = options;
    
    logger.info('Starting matching process', {
      mode,
      baselineCount: baselineElements.length,
      compareCount: compareElements.length
    });
    
    const startTime = performance.now();
    let result;
    
    switch (mode) {
      case 'static':
        result = this._matchStatic(baselineElements, compareElements, {
          minConfidence,
          positionTolerance,
          enableFallback
        });
        break;
        
      case 'dynamic':
        result = this._matchDynamic(baselineElements, compareElements, {
          templateThreshold,
          minConfidence
        });
        break;
        
      case 'hybrid':
        result = this._matchHybrid(baselineElements, compareElements, {
          minConfidence,
          positionTolerance,
          templateThreshold,
          enableFallback
        });
        break;
        
      default:
        throw new Error(`Invalid matching mode: ${mode}`);
    }
    
    const duration = performance.now() - startTime;
    
    // Enhance result with additional stats
    result.mode = mode;
    result.duration = Math.round(duration);
    result.performance = this._calculatePerformanceMetrics(result, duration);
    
    logger.info('Matching complete', {
      mode,
      matched: result.matches.length,
      duration: Math.round(duration),
      matchRate: result.stats.matchRate
    });
    
    return result;
  }
  
  /**
   * Static matching mode
   * Uses stable selectors and identifiers
   */
  _matchStatic(baselineElements, compareElements, options) {
    const result = this.staticMatcher.match(
      baselineElements,
      compareElements,
      options
    );
    
    // If enabled, use position matcher as fallback for unmatched elements
    if (options.enableFallback && result.unmatched.baseline.length > 0) {
      logger.debug('Applying position fallback', {
        unmatchedCount: result.unmatched.baseline.length
      });
      
      const fallbackResult = this.positionMatcher.match(
        result.unmatched.baseline,
        result.unmatched.compare,
        { tolerance: options.positionTolerance }
      );
      
      // Merge fallback matches
      result.matches.push(...fallbackResult.matches);
      result.unmatched = fallbackResult.unmatched;
      
      // Update stats
      result.stats.fallbackMatches = fallbackResult.matches.length;
      result.stats.matched = result.matches.length;
      result.stats.matchRate = (result.matches.length / baselineElements.length * 100).toFixed(1) + '%';
    }
    
    return result;
  }
  
  /**
   * Dynamic matching mode
   * Uses component grouping and template detection
   */
  _matchDynamic(baselineElements, compareElements, options) {
    const result = this.dynamicMatcher.match(
      baselineElements,
      compareElements,
      options
    );
    
    // Dynamic mode doesn't track unmatched elements individually
    // Calculate based on total matches
    const totalBaseline = baselineElements.length;
    const totalCompare = compareElements.length;
    
    result.unmatched = {
      baseline: [],
      compare: []
    };
    
    result.stats = {
      ...result.stats,
      totalBaseline,
      totalCompare,
      matched: result.matches.length,
      matchRate: (result.matches.length / totalBaseline * 100).toFixed(1) + '%'
    };
    
    return result;
  }
  
  /**
   * Hybrid matching mode
   * Tries static first, falls back to dynamic for unmatched
   */
  _matchHybrid(baselineElements, compareElements, options) {
    const staticResult = this.staticMatcher.match(
      baselineElements,
      compareElements,
      { minConfidence: options.minConfidence }
    );

    const allMatches = [...staticResult.matches];
    let unmatchedBaseline = staticResult.unmatched.baseline;
    let unmatchedCompare = staticResult.unmatched.compare;

    // Phase 2: Dynamic matching
    if (unmatchedBaseline.length > 0) {
      const dynamicResult = this.dynamicMatcher.match(
        unmatchedBaseline,
        unmatchedCompare,
        { templateThreshold: options.templateThreshold }
      );

      allMatches.push(...dynamicResult.matches);
      unmatchedBaseline = unmatchedBaseline.filter(el =>
        !dynamicResult.matches.find(m => m.baseline === el)
      );
      unmatchedCompare = unmatchedCompare.filter(el =>
        !dynamicResult.matches.find(m => m.compare === el)
      );
    }

    // Phase 3: Position fallback
    let fallbackResult = null;
    if (options.enableFallback && unmatchedBaseline.length > 0) {
      fallbackResult = this.positionMatcher.match(
        unmatchedBaseline,
        unmatchedCompare,
        { tolerance: options.positionTolerance }
      );

      allMatches.push(...fallbackResult.matches);
      unmatchedBaseline = fallbackResult.unmatched.baseline;
      unmatchedCompare = fallbackResult.unmatched.compare;
    }

    const fallbackMatchCount = fallbackResult ? fallbackResult.matches.length : 0;

    return {
      matches: allMatches,
      unmatched: {
        baseline: unmatchedBaseline,
        compare: unmatchedCompare
      },
      stats: {
        totalBaseline: baselineElements.length,
        totalCompare: compareElements.length,
        matched: allMatches.length,
        matchRate: (allMatches.length / baselineElements.length * 100).toFixed(1) + '%',
        staticMatches: staticResult.matches.length,
        dynamicMatches: allMatches.length - staticResult.matches.length - fallbackMatchCount,
        fallbackMatches: fallbackMatchCount
      }
    };
  }
  
  /**
   * Calculate performance metrics
   */
  _calculatePerformanceMetrics(result, duration) {
    return {
      elementsPerSecond: Math.round((result.stats.totalBaseline / duration) * 1000),
      avgTimePerElement: (duration / result.stats.totalBaseline).toFixed(2) + 'ms',
      matchingEfficiency: result.stats.matchRate
    };
  }
  
  /**
   * Detect dynamic content in elements
   * Useful for pre-filtering before comparison
   */
  detectDynamicContent(elements) {
    const dynamicElements = [];
    
    for (const element of elements) {
      const detection = this.detector.detectDynamicContent(element);
      
      if (detection.isDynamic) {
        dynamicElements.push({
          element,
          detection
        });
      }
    }
    
    logger.info('Dynamic content detection complete', {
      totalElements: elements.length,
      dynamicElements: dynamicElements.length,
      types: [...new Set(dynamicElements.map(d => d.detection.type))]
    });
    
    return dynamicElements;
  }
}
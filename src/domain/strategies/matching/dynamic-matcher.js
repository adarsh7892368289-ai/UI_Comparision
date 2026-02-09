/**
 * DYNAMIC MATCHER
 * Matches elements when content may shuffle or change
 * Uses component grouping and template consistency analysis
 * 
 * Key Features:
 * - Component detection (BEM, ARIA, semantic, class patterns)
 * - Template mode: Detects CSS consistency (>90% similarity)
 * - Individual mode: Matches by position within component type
 * - Confidence: 85% (template), 75% (position-within-type)
 */

import config from '../../../infrastructure/config.js';
import logger from '../../../infrastructure/logger.js';
import { DetectorEngine } from '../../engines/detector-engine.js';

export class DynamicMatcher {
  constructor() {
    this.detector = new DetectorEngine();
    this.structuralProps = [
      // Layout
      'display', 'position', 'width', 'height',
      // Spacing
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      // Typography (structural)
      'font-size', 'font-weight', 'line-height',
      // Visual (structural)
      'background-color', 'border-radius', 'border-width'
    ];
  }
  
  /**
   * Match elements using dynamic strategy
   * @param {Array} baselineElements - Elements from baseline page
   * @param {Array} compareElements - Elements from compare page
   * @param {Object} options - Matching options (overrides config defaults)
   * @returns {Object} { matches: [], unmatched: {}, stats: {} }
   */
  match(baselineElements, compareElements, options = {}) {
    // Apply defaults from config.matching
    const configMatching = config.getSection('matching');
    const {
      templateThreshold = configMatching.templateThreshold || 0.90,
      minConfidence = configMatching.minConfidence || 0.70
    } = options;
    
    // Validate inputs
    if (!Array.isArray(baselineElements) || !Array.isArray(compareElements)) {
      logger.error('Invalid input to dynamic matcher', {
        baselineType: typeof baselineElements,
        compareType: typeof compareElements
      });
      return this._emptyResult();
    }
    
    logger.debug('Starting dynamic matching', {
      baselineCount: baselineElements.length,
      compareCount: compareElements.length,
      templateThreshold
    });
    
    const matches = [];
    
    try {
      // Step 1: Group both sets by component type
      const baselineGroups = this.detector.groupByComponentType(baselineElements);
      const compareGroups = this.detector.groupByComponentType(compareElements);
      
      logger.debug('Component grouping complete', {
        baselineTypes: Object.keys(baselineGroups).length,
        compareTypes: Object.keys(compareGroups).length
      });
      
      // Step 2: Match component groups
      for (const [componentType, baseGroup] of Object.entries(baselineGroups)) {
        const compGroup = compareGroups[componentType];
        
        if (!compGroup) {
          // Component type missing in compare
          logger.debug('Component type missing in compare', { componentType });
          continue;
        }
        
        try {
          // Step 3: Check template consistency
          const baseTemplateConsistent = this._isTemplateConsistent(
            baseGroup.instances,
            templateThreshold
          );
          
          const compTemplateConsistent = this._isTemplateConsistent(
            compGroup.instances,
            templateThreshold
          );
          
          if (baseTemplateConsistent.isConsistent && compTemplateConsistent.isConsistent) {
            // TEMPLATE MODE: All instances share same CSS
            const strategyConfidence = config.get('matching.strategyConfidence', {});
            const templateMatch = {
              baseline: baseGroup.instances[0],
              compare: compGroup.instances[0],
              confidence: strategyConfidence['template'] || 0.85,
              strategy: 'template',
              isTemplate: true,
              componentType: componentType,
              instanceCount: {
                baseline: baseGroup.instances.length,
                compare: compGroup.instances.length
              },
              metadata: {
                note: 'All instances use same CSS template',
                templateConsistency: {
                  baseline: baseTemplateConsistent.similarity.toFixed(2),
                  compare: compTemplateConsistent.similarity.toFixed(2)
                }
              }
            };
            
            matches.push(templateMatch);
            
            logger.debug('Template match found', {
              componentType,
              baselineInstances: baseGroup.instances.length,
              compareInstances: compGroup.instances.length,
              similarity: baseTemplateConsistent.similarity
            });
            
          } else {
            // INDIVIDUAL MODE: Match by position within type
            const individualMatches = this._matchByPositionWithinType(
              baseGroup.instances,
              compGroup.instances,
              componentType
            );
            
            matches.push(...individualMatches);
          }
        } catch (error) {
          logger.warn('Error matching component group', {
            error: error.message,
            componentType
          });
        }
      }
    } catch (error) {
      logger.error('Dynamic matching failed', { error: error.message });
      return this._emptyResult();
    }
    
    logger.info('Dynamic matching complete', {
      matched: matches.length,
      templateMatches: matches.filter(m => m.isTemplate).length,
      individualMatches: matches.filter(m => !m.isTemplate).length
    });
    
    return {
      matches,
      unmatched: {}, // Not tracked in dynamic mode
      stats: {
        totalMatches: matches.length,
        templateMatches: matches.filter(m => m.isTemplate).length,
        individualMatches: matches.filter(m => !m.isTemplate).length,
        componentTypes: new Set(matches.map(m => m.componentType)).size
      }
    };
  }
  
  /**
   * Check if instances have consistent CSS (template mode)
   * @param {Array} instances - Elements to check
   * @param {number} threshold - Similarity threshold (0-1)
   * @returns {Object} { isConsistent: boolean, similarity: number, consistencyRate: number }
   */
  _isTemplateConsistent(instances, threshold = 0.90) {
    if (!instances || instances.length < 2) {
      return { isConsistent: false, similarity: 0, consistencyRate: 0 };
    }
    
    try {
      // Get CSS fingerprint of first instance (template)
      const template = instances[0];
      const templateCSS = this._getCSSFingerprint(template);
      
      // Check similarity across all instances
      let totalSimilarity = 0;
      let matchCount = 0;
      
      for (const instance of instances) {
        const instanceCSS = this._getCSSFingerprint(instance);
        const similarity = this._calculateCSSSimilarity(templateCSS, instanceCSS);
        
        totalSimilarity += similarity;
        
        if (similarity >= threshold) {
          matchCount++;
        }
      }
      
      const avgSimilarity = totalSimilarity / instances.length;
      const consistencyRate = matchCount / instances.length;
      
      return {
        isConsistent: consistencyRate >= threshold,
        similarity: avgSimilarity,
        consistencyRate: consistencyRate
      };
    } catch (error) {
      logger.debug('Template consistency check failed', { error: error.message });
      return { isConsistent: false, similarity: 0, consistencyRate: 0 };
    }
  }
  
  /**
   * Get CSS fingerprint (structural properties only)
   * Excludes content-specific properties
   */
  _getCSSFingerprint(element) {
    if (!element) return {};
    
    try {
      const fingerprint = {};
      const styles = element.normalizedStyles || element.styles || {};
      
      for (const prop of this.structuralProps) {
        if (styles[prop]) {
          fingerprint[prop] = styles[prop];
        }
      }
      
      return fingerprint;
    } catch (error) {
      logger.debug('Failed to get CSS fingerprint', { error: error.message });
      return {};
    }
  }
  
  /**
   * Calculate CSS similarity between two fingerprints
   * @param {Object} css1 - First CSS fingerprint
   * @param {Object} css2 - Second CSS fingerprint
   * @returns {number} Similarity ratio (0-1)
   */
  _calculateCSSSimilarity(css1, css2) {
    if (!css1 || !css2 || typeof css1 !== 'object' || typeof css2 !== 'object') {
      return 0;
    }

    try {
      const props1 = Object.keys(css1);
      const props2 = Object.keys(css2);
      const allProps = new Set([...props1, ...props2]);

      if (allProps.size === 0) return 1; // Both empty = 100% similar

      let matchCount = 0;

      for (const prop of allProps) {
        if (css1[prop] === css2[prop]) {
          matchCount++;
        }
      }

      return matchCount / allProps.size;
    } catch (error) {
      logger.debug('CSS similarity calculation failed', { error: error.message });
      return 0;
    }
  }
  
  /**
   * Match instances by position within component type
   * Used when template mode doesn't apply
   * @param {Array} baseInstances - Baseline instances
   * @param {Array} compInstances - Compare instances
   * @param {string} componentType - Type of component
   * @returns {Array} Matches
   */
  _matchByPositionWithinType(baseInstances, compInstances, componentType) {
    const matches = [];
    
    if (!baseInstances || !compInstances) return matches;
    
    try {
      const minLength = Math.min(baseInstances.length, compInstances.length);
      const strategyConfidence = config.get('matching.strategyConfidence', {});
      
      // Match by index (position in list)
      for (let i = 0; i < minLength; i++) {
        matches.push({
          baseline: baseInstances[i],
          compare: compInstances[i],
          confidence: strategyConfidence['position-within-type'] || 0.75,
          strategy: 'position-within-type',
          isTemplate: false,
          componentType: componentType,
          metadata: {
            positionIndex: i,
            totalBaseline: baseInstances.length,
            totalCompare: compInstances.length
          }
        });
      }
      
      logger.debug('Position-within-type matching complete', {
        componentType,
        matched: matches.length,
        unmatched: Math.abs(baseInstances.length - compInstances.length)
      });
    } catch (error) {
      logger.warn('Position-within-type matching failed', {
        error: error.message,
        componentType
      });
    }
    
    return matches;
  }
  
  /**
   * Return empty result structure
   */
  _emptyResult() {
    return {
      matches: [],
      unmatched: {},
      stats: {
        totalMatches: 0,
        templateMatches: 0,
        individualMatches: 0,
        componentTypes: 0
      }
    };
  }
}

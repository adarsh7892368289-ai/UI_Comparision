/**
 * DETECTOR ENGINE
 * Identifies component types and patterns in UI elements
 * Used for dynamic matching and template detection
 */

import logger from '../../infrastructure/logger.js';
import { isStableClass } from '../../shared/dom-utils.js';

export class DetectorEngine {
  
  //Detect component type for single element
  detectComponentType(element) {
    // Try detection strategies in order of confidence
    
    // Strategy 1: data-component attribute (95% confidence)
    const dataComponent = this._detectByDataComponent(element);
    if (dataComponent) return dataComponent;
    
    // Strategy 2: BEM pattern (85% confidence)
    const bemPattern = this._detectByBEM(element);
    if (bemPattern) return bemPattern;
    
    // Strategy 3: ARIA role (80% confidence)
    const ariaRole = this._detectByARIA(element);
    if (ariaRole) return ariaRole;
    
    // Strategy 4: Semantic tag (70% confidence)
    const semantic = this._detectBySemantic(element);
    if (semantic) return semantic;
    
    // Strategy 5: Class pattern matching (65% confidence)
    const classPattern = this._detectByClassPattern(element);
    if (classPattern) return classPattern;
    
    // Fallback: use tag name (40% confidence)
    return {
      type: element.tagName?.toLowerCase() || 'unknown',
      confidence: 0.40,
      strategy: 'tag-fallback',
      instances: []
    };
  }
  
  /**
   * Group elements by component type
   * @returns {Object} { componentType: [elements] }
   */
  groupByComponentType(elements) {
    const groups = {};
    
    for (const element of elements) {
      const detection = this.detectComponentType(element);
      
      if (!groups[detection.type]) {
        groups[detection.type] = {
          type: detection.type,
          confidence: detection.confidence,
          strategy: detection.strategy,
          instances: []
        };
      }
      
      groups[detection.type].instances.push(element);
    }
    
    logger.debug('Grouped elements by component type', {
      uniqueTypes: Object.keys(groups).length,
      totalElements: elements.length
    });
    
    return groups;
  }
  
  /**
   * Detect if element is dynamic content (carousel, ad, live feed)
   * @returns {Object} { isDynamic, type, confidence, reason }
   */
  detectDynamicContent(element) {
    // Pattern 1: Carousel/slider
    const carouselPatterns = [
      /carousel/i, /slider/i, /swiper/i, /slick/i, 
      /slideshow/i, /gallery/i, /banner.*rotate/i
    ];
    
    if (this._matchesPatterns(element, carouselPatterns)) {
      return {
        isDynamic: true,
        type: 'carousel',
        confidence: 0.90,
        reason: 'class/attribute pattern match'
      };
    }
    
    // Pattern 2: Advertisement
    const adPatterns = [
      /\bad\b/i, /advertisement/i, /sponsored/i, /promo/i,
      /banner/i, /-ad-/i, /adslot/i
    ];
    
    if (this._matchesPatterns(element, adPatterns)) {
      return {
        isDynamic: true,
        type: 'advertisement',
        confidence: 0.85,
        reason: 'ad-related pattern'
      };
    }
    
    // Pattern 3: Live feed/ticker
    const livePatterns = [
      /live/i, /ticker/i, /feed/i, /stream/i, /real.*time/i,
      /updates/i, /notification/i
    ];
    
    if (this._matchesPatterns(element, livePatterns)) {
      return {
        isDynamic: true,
        type: 'live-feed',
        confidence: 0.80,
        reason: 'live content pattern'
      };
    }
    
    // Pattern 4: ARIA live regions
    const ariaLive = element.attributes?.['aria-live'];
    if (ariaLive && ['polite', 'assertive'].includes(ariaLive)) {
      return {
        isDynamic: true,
        type: 'aria-live',
        confidence: 0.95,
        reason: 'aria-live attribute'
      };
    }
    
    // Pattern 5: Role=marquee or timer
    const role = element.attributes?.role;
    if (role && ['marquee', 'timer'].includes(role)) {
      return {
        isDynamic: true,
        type: role,
        confidence: 0.95,
        reason: 'ARIA role'
      };
    }
    
    return {
      isDynamic: false,
      type: null,
      confidence: 0,
      reason: 'no dynamic patterns detected'
    };
  }
  
  // ==================== DETECTION STRATEGIES ====================
  
  /**
   * Strategy 1: Detect by data-component attribute
   */
  _detectByDataComponent(element) {
    const dataComponent = element.attributes?.['data-component'];
    
    if (dataComponent && typeof dataComponent === 'string') {
      return {
        type: dataComponent,
        confidence: 0.95,
        strategy: 'data-component-attribute',
        instances: []
      };
    }
    
    return null;
  }
  
  /**
   * Strategy 2: Detect BEM pattern (Block__Element--Modifier)
   */
  _detectByBEM(element) {
    // Safely get className as string
    let className = '';

    if (typeof element.className === 'string') {
      className = element.className;
    } else if (element.className && element.className.baseVal) {
      // SVG elements have className.baseVal
      className = element.className.baseVal;
    } else if (element.getAttribute) {
      // Fallback to getAttribute
      className = element.getAttribute('class') || '';
    }

    if (!className || typeof className !== 'string') return null;

    const classes = className.trim().split(/\s+/).filter(c => isStableClass(c));
    
    for (const cls of classes) {
      // Match BEM block__element or block--modifier pattern
      const bemMatch = cls.match(/^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(__|--)([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/);
      
      if (bemMatch) {
        const block = bemMatch[1]; // The "block" part
        
        return {
          type: block,
          confidence: 0.85,
          strategy: 'bem-pattern',
          instances: [],
          metadata: {
            fullClass: cls,
            block: block,
            modifier: bemMatch[2] === '--' ? bemMatch[3] : null,
            element: bemMatch[2] === '__' ? bemMatch[3] : null
          }
        };
      }
    }
    
    return null;
  }
  
  /**
   * Strategy 3: Detect by ARIA role
   */
  _detectByARIA(element) {
    const role = element.attributes?.role;
    
    if (role && typeof role === 'string') {
      return {
        type: role,
        confidence: 0.80,
        strategy: 'aria-role',
        instances: []
      };
    }
    
    return null;
  }
  
  /**
   * Strategy 4: Detect by semantic HTML tag
   */
  _detectBySemantic(element) {
    const semanticTags = [
      'article', 'section', 'nav', 'header', 'footer', 
      'aside', 'main', 'figure', 'dialog'
    ];
    
    const tag = element.tagName?.toLowerCase();
    
    if (semanticTags.includes(tag)) {
      return {
        type: tag,
        confidence: 0.70,
        strategy: 'semantic-tag',
        instances: []
      };
    }
    
    return null;
  }
  
  /**
   * Strategy 5: Detect by common class patterns
   */
  _detectByClassPattern(element) {
    // Safely get className as string
    let className = '';

    if (typeof element.className === 'string') {
      className = element.className;
    } else if (element.className && element.className.baseVal) {
      // SVG elements have className.baseVal
      className = element.className.baseVal;
    } else if (element.getAttribute) {
      // Fallback to getAttribute
      className = element.getAttribute('class') || '';
    }

    if (!className || typeof className !== 'string') return null;
    
    const patterns = [
      { regex: /^(card|panel|box|tile)/i, type: 'card' },
      { regex: /^(btn|button)/i, type: 'button' },
      { regex: /^(nav|menu|navigation)/i, type: 'navigation' },
      { regex: /^(modal|dialog|popup)/i, type: 'modal' },
      { regex: /^(alert|notification|toast)/i, type: 'alert' },
      { regex: /^(form|input|field)/i, type: 'form-element' },
      { regex: /^(table|grid|list)/i, type: 'data-container' },
      { regex: /^(header|footer|sidebar)/i, type: 'layout' }
    ];
    
    const classes = className.trim().split(/\s+/).filter(c => isStableClass(c));
    
    for (const cls of classes) {
      for (const pattern of patterns) {
        if (pattern.regex.test(cls)) {
          return {
            type: pattern.type,
            confidence: 0.65,
            strategy: 'class-pattern',
            instances: [],
            metadata: {
              matchedClass: cls,
              pattern: pattern.regex.toString()
            }
          };
        }
      }
    }
    
    return null;
  }
  
  // Helper: Check if element matches any pattern
  _matchesPatterns(element, patterns) {
    // Check classes
    const className = element.className;
    if (className && typeof className === 'string') {
      for (const pattern of patterns) {
        if (pattern.test(className)) return true;
      }
    }
    
    // Check attributes (all attributes)
    const attributes = element.attributes || {};
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value === 'string') {
        for (const pattern of patterns) {
          if (pattern.test(key) || pattern.test(value)) return true;
        }
      }
    }
    
    return false;
  }
}
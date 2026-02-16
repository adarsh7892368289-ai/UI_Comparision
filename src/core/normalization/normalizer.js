import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';
import { NormalizationCache } from './cache.js';
import { normalizeColor } from './color-normalizer.js';
import { normalizeUnit, isContextDependent } from './unit-normalizer.js';
import { normalizeFont } from './font-normalizer.js';
import { expandShorthands } from './shorthand-expander.js';

const COLOR_PROPERTIES = [
  'color', 'background-color', 'border-color',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'outline-color', 'text-decoration-color', 'column-rule-color', 'caret-color'
];

const SIZE_PROPERTIES = [
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'top', 'right', 'bottom', 'left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius', 
  'border-bottom-right-radius', 'border-bottom-left-radius',
  'font-size', 'line-height', 'letter-spacing', 'word-spacing',
  'gap', 'row-gap', 'column-gap', 'grid-gap',
  'outline-width', 'outline-offset',
  'text-indent'
];

const FONT_PROPERTIES = [
  'font-family'
];

class NormalizerEngine {
  constructor() {
    const cacheEnabled = get('normalization.cache.enabled', true);
    const maxEntries = get('normalization.cache.maxEntries', 1000);
    
    this.cache = cacheEnabled ? new NormalizationCache(maxEntries) : null;
    this.initialized = true;
    
    logger.debug('Normalizer engine initialized', { 
      cacheEnabled, 
      maxEntries 
    });
  }

  normalize(styles, element = null) {
    if (!styles || typeof styles !== 'object') {
      return styles;
    }

    try {
      const expanded = expandShorthands(styles);
      const normalized = {};

      for (const [property, value] of Object.entries(expanded)) {
        normalized[property] = this.normalizeProperty(property, value, element);
      }

      return normalized;
    } catch (error) {
      logger.error('Normalization failed', { 
        error: error.message,
        stylesCount: Object.keys(styles).length 
      });
      return styles;
    }
  }

  normalizeProperty(property, value, element = null) {
    if (!value || typeof value !== 'string') {
      return value;
    }

    try {
      if (COLOR_PROPERTIES.includes(property)) {
        return this._normalizeWithCache(
          property, 
          value, 
          false, 
          null, 
          () => normalizeColor(value)
        );
      }

      if (SIZE_PROPERTIES.includes(property)) {
        const contextDependent = isContextDependent(value);
        const context = contextDependent && element ? this._getContext(element) : null;
        
        return this._normalizeWithCache(
          property,
          value,
          contextDependent,
          context,
          () => normalizeUnit(value, property, element)
        );
      }

      if (FONT_PROPERTIES.includes(property)) {
        return this._normalizeWithCache(
          property,
          value,
          false,
          null,
          () => normalizeFont(value)
        );
      }

      return value;
    } catch (error) {
      logger.warn('Property normalization failed', { 
        property, 
        value, 
        error: error.message 
      });
      return value;
    }
  }

  _normalizeWithCache(property, value, isContextDependent, context, normalizeFunc) {
    if (!this.cache) {
      return normalizeFunc();
    }

    const cached = this.cache.get(property, value, isContextDependent, context);
    if (cached !== undefined) {
      return cached;
    }

    const normalized = normalizeFunc();
    this.cache.set(property, value, normalized, isContextDependent, context);

    return normalized;
  }

  _getContext(element) {
    try {
      const parent = element.parentElement;
      const computed = window.getComputedStyle(element);
      const parentComputed = parent ? window.getComputedStyle(parent) : null;

      return {
        fontSize: computed.fontSize,
        parentFontSize: parentComputed ? parentComputed.fontSize : '16px',
        parentWidth: parentComputed ? parentComputed.width : '0px',
        parentHeight: parentComputed ? parentComputed.height : '0px',
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      };
    } catch (error) {
      return null;
    }
  }

  getCacheStats() {
    if (!this.cache) {
      return { cacheEnabled: false };
    }

    return {
      cacheEnabled: true,
      ...this.cache.getStats()
    };
  }

  clearCache() {
    if (this.cache) {
      this.cache.clear();
      logger.info('Normalization cache cleared');
    }
  }
}

export { NormalizerEngine };
/**
 * NORMALIZER ENGINE
 * Orchestrates all normalization strategies
 * Provides LRU caching for performance
 */

import { ColorNormalizer } from '../strategies/normalization/color-normalizer.js';
import { UnitNormalizer } from '../strategies/normalization/unit-normalizer.js';
import { ShorthandExpander } from '../strategies/normalization/shorthand-expander.js';
import { FontNormalizer } from '../strategies/normalization/font-normalizer.js';

export class NormalizerEngine {
  constructor(options = {}) {
    this.colorNormalizer = new ColorNormalizer();
    this.unitNormalizer = new UnitNormalizer();
    this.shorthandExpander = new ShorthandExpander();
    this.fontNormalizer = new FontNormalizer();
    
    this._cache = new Map();
    this._cacheMaxSize = options.cacheMaxSize || 1000;
  }
  
  //Normalize entire CSS object
  normalize(cssObject, element = null) {
    if (!cssObject || typeof cssObject !== 'object') {
      return cssObject;
    }
    
    try {
      const expanded = this.shorthandExpander.expand(cssObject);
      
      const normalized = {};
      
      for (const [property, value] of Object.entries(expanded)) {
        try {
          normalized[property] = this.normalizeProperty(property, value, element);
        } catch (error) {
          normalized[property] = value;
        }
      }
      
      return normalized;
      
    } catch (error) {
      const normalized = {};
      
      for (const [property, value] of Object.entries(cssObject)) {
        try {
          normalized[property] = this.normalizeProperty(property, value, element);
        } catch (error) {
          normalized[property] = value;
        }
      }
      
      return normalized;
    }
  }
  
  //Normalize single property   
  normalizeProperty(property, value, element = null) {
    if (!value || typeof value !== 'string') {
      return value;
    }
    
    if (!element) {
      const cacheKey = `${property}:${value}`;
      if (this._cache.has(cacheKey)) {
        return this._cache.get(cacheKey);
      }
    }
    
    let normalized = value;
    
    try {
      if (this._isColorProperty(property)) {
        normalized = this.colorNormalizer.normalize(value);
      }
      else if (this._isSizeProperty(property)) {
        normalized = this.unitNormalizer.normalize(property, value, element);
      }
      else if (property === 'font-family') {
        normalized = this.fontNormalizer.normalize(value);
      }
      
    } catch (error) {
      normalized = value;
    }
    
    if (!element) {
      this._updateCache(`${property}:${value}`, normalized);
    }
    
    return normalized;
  }
  
  // Update cache with LRU eviction
  _updateCache(key, value) {
    if (this._cache.size >= this._cacheMaxSize) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }
    
    this._cache.set(key, value);
  }
  
  // Check if property is color-related
  _isColorProperty(property) {
    return property.includes('color') || 
           property === 'background' ||
           property === 'border' ||
           property === 'outline' ||
           property === 'fill' ||
           property === 'stroke';
  }
  
  // Check if property is size-related
  _isSizeProperty(property) {
    const sizeProps = [
      'width', 'height', 'font-size', 'line-height',
      'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'border-width', 'border-radius',
      'top', 'right', 'bottom', 'left',
      'gap', 'row-gap', 'column-gap',
      'min-width', 'max-width', 'min-height', 'max-height'
    ];
    
    return sizeProps.includes(property);
  }
  
  clearCache() {
    this._cache.clear();
  }
  
  getCacheStats() {
    return {
      size: this._cache.size,
      maxSize: this._cacheMaxSize,
      hitRate: this._cacheHits / (this._cacheHits + this._cacheMisses) || 0
    };
  }
}
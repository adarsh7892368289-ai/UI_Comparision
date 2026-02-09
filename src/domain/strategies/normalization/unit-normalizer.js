/**
 * UNIT NORMALIZER
 * Converts all CSS units to pixels
 *
 * Handles:
 * - Absolute: pt, pc, in, cm, mm → px
 * - Relative: em, rem, % → px (context-aware)
 * - Viewport: vw, vh, vmin, vmax → px
 * - Special: auto, 0 (no unit)
 */

import logger from '../../../infrastructure/logger.js';

export class UnitNormalizer {
  /**
   * @param {string} property - CSS property name (for context)
   * @param {string} value - CSS value with unit
   * @param {Element} element - DOM element (for relative units)
   * @returns {string} Normalized value in px or special keyword
   */
  normalize(property, value, element) {
    try {
      if (!value || typeof value !== 'string') return value;

      const trimmed = value.trim().toLowerCase();

      // 1. Special values
      if (['auto', 'none', 'inherit', 'initial', 'unset'].includes(trimmed)) {
        return trimmed;
      }

      // 2. Zero (no unit needed)
      if (trimmed === '0') {
        return '0px';
      }

      // 3. Parse value and unit
      const match = trimmed.match(/^([-\d.]+)([a-z%]+)$/);
      if (!match) return value;

      const num = parseFloat(match[1]);
      const unit = match[2];

      // 4. Already pixels
      if (unit === 'px') {
        return `${num.toFixed(1)}px`;
      }

      // 5. Absolute units (no context needed)
      const absoluteConversions = {
        'pt': 1.333,
        'pc': 16,
        'in': 96,
        'cm': 37.7953,
        'mm': 3.77953,
      };

      if (absoluteConversions[unit]) {
        const px = num * absoluteConversions[unit];
        return `${px.toFixed(1)}px`;
      }

      // 6. Relative units (context-aware)
      if (!element) {
        return value;
      }

      return this._normalizeRelative(property, num, unit, element);
    } catch (error) {
      logger.warn('Unit normalization failed', {
        property,
        value,
        error: error.message
      });
      return value; // Return original on error
    }
  }
  
  _normalizeRelative(property, num, unit, element) {
    try {
      // em: relative to element's font-size
      if (unit === 'em') {
        const fontSize = parseFloat(getComputedStyle(element).fontSize);
        const px = num * fontSize;
        return `${px.toFixed(1)}px`;
      }
      
      // rem: relative to root font-size
      if (unit === 'rem') {
        const rootFontSize = parseFloat(
          getComputedStyle(document.documentElement).fontSize
        );
        const px = num * rootFontSize;
        return `${px.toFixed(1)}px`;
      }
      
      // %: depends on property
      if (unit === '%') {
        return this._normalizePercentage(property, num, element);
      }
      
      // Viewport units
      if (unit === 'vw') {
        const px = (num / 100) * window.innerWidth;
        return `${px.toFixed(1)}px`;
      }
      
      if (unit === 'vh') {
        const px = (num / 100) * window.innerHeight;
        return `${px.toFixed(1)}px`;
      }
      
      if (unit === 'vmin') {
        const viewport = Math.min(window.innerWidth, window.innerHeight);
        const px = (num / 100) * viewport;
        return `${px.toFixed(1)}px`;
      }
      
      if (unit === 'vmax') {
        const viewport = Math.max(window.innerWidth, window.innerHeight);
        const px = (num / 100) * viewport;
        return `${px.toFixed(1)}px`;
      }
      
    } catch (error) {
      return `${num}${unit}`;
    }
    
    return `${num}${unit}`;
  }
  
  _normalizePercentage(property, num, element) {
    const parent = element.parentElement;
    if (!parent) return `${num}%`;

    try {
      // Width-related properties
      if (['width', 'max-width', 'min-width', 'left', 'right'].includes(property)) {
        const parentWidth = parseFloat(getComputedStyle(parent).width);
        if (isNaN(parentWidth) || parentWidth === 0) {
          return `${num}%`;
        }
        const px = (num / 100) * parentWidth;
        return `${px.toFixed(1)}px`;
      }

      // Height-related properties
      if (['height', 'max-height', 'min-height', 'top', 'bottom'].includes(property)) {
        const parentHeight = parseFloat(getComputedStyle(parent).height);
        if (isNaN(parentHeight) || parentHeight === 0) {
          return `${num}%`;
        }
        const px = (num / 100) * parentHeight;
        return `${px.toFixed(1)}px`;
      }

      // Font-size
      if (property === 'font-size') {
        const parentFontSize = parseFloat(getComputedStyle(parent).fontSize);
        if (isNaN(parentFontSize) || parentFontSize === 0) {
          return `${num}%`;
        }
        const px = (num / 100) * parentFontSize;
        return `${px.toFixed(1)}px`;
      }

      // Padding/margin (relative to parent width)
      if (property.includes('padding') || property.includes('margin')) {
        const parentWidth = parseFloat(getComputedStyle(parent).width);
        if (isNaN(parentWidth) || parentWidth === 0) {
          return `${num}%`;
        }
        const px = (num / 100) * parentWidth;
        return `${px.toFixed(1)}px`;
      }

    } catch (error) {
      return `${num}%`;
    }

    return `${num}%`;
  }
}
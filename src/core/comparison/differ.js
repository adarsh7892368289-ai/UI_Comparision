import { get } from '../../config/defaults.js';
import { NormalizerEngine } from '../normalization/normalizer.js';

const DIFF_TYPES = {
  UNCHANGED: 'unchanged',
  MODIFIED: 'modified',
  ADDED: 'added',
  REMOVED: 'removed'
};

const PROPERTY_CATEGORIES = {
  LAYOUT: 'layout',
  VISUAL: 'visual',
  TYPOGRAPHY: 'typography',
  SPACING: 'spacing',
  POSITION: 'position',
  OTHER: 'other'
};

const LAYOUT_PROPERTIES = ['display', 'position', 'float', 'clear', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height'];
const VISUAL_PROPERTIES = ['color', 'background-color', 'border-color', 'opacity', 'visibility', 'box-shadow', 'text-shadow'];
const TYPOGRAPHY_PROPERTIES = ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'text-align', 'text-decoration', 'letter-spacing', 'word-spacing'];
const SPACING_PROPERTIES = ['margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
const POSITION_PROPERTIES = ['top', 'right', 'bottom', 'left', 'z-index'];

class PropertyDiffer {
  constructor() {
    this.normalizer = new NormalizerEngine();
    this.colorTolerance = get('comparison.colorTolerance', 5);
    this.sizeTolerance = get('comparison.sizeTolerance', 3);
  }

  compareElements(baselineElement, compareElement, mode = 'static') {
    const baselineNormalized = this.normalizer.normalize(baselineElement.styles);
    const compareNormalized = this.normalizer.normalize(compareElement.styles);

    const differences = [];
    const allProperties = new Set([
      ...Object.keys(baselineNormalized),
      ...Object.keys(compareNormalized)
    ]);

    for (const property of allProperties) {
      const baseValue = baselineNormalized[property];
      const compareValue = compareNormalized[property];

      if (mode === 'dynamic' && this._shouldIgnoreInDynamicMode(property)) {
        continue;
      }

      const diffType = this._getDiffType(baseValue, compareValue);
      
      if (diffType !== DIFF_TYPES.UNCHANGED) {
        const isSignificant = this._isSignificantDifference(property, baseValue, compareValue);

        if (isSignificant) {
          differences.push({
            property,
            baseValue,
            compareValue,
            type: diffType,
            category: this._categorizeProperty(property)
          });
        }
      }
    }

    return {
      elementId: baselineElement.id,
      tagName: baselineElement.tagName,
      totalDifferences: differences.length,
      differences
    };
  }

  _getDiffType(baseValue, compareValue) {
    if (baseValue === undefined && compareValue !== undefined) {
      return DIFF_TYPES.ADDED;
    }
    if (baseValue !== undefined && compareValue === undefined) {
      return DIFF_TYPES.REMOVED;
    }
    if (baseValue === compareValue) {
      return DIFF_TYPES.UNCHANGED;
    }
    return DIFF_TYPES.MODIFIED;
  }

  _isSignificantDifference(property, baseValue, compareValue) {
    if (baseValue === undefined || compareValue === undefined) {
      return true;
    }

    if (this._isColorProperty(property)) {
      return this._isSignificantColorDifference(baseValue, compareValue);
    }

    if (this._isSizeProperty(property)) {
      return this._isSignificantSizeDifference(baseValue, compareValue);
    }

    return baseValue !== compareValue;
  }

  _isColorProperty(property) {
    return VISUAL_PROPERTIES.includes(property) || property.includes('color');
  }

  _isSizeProperty(property) {
    return LAYOUT_PROPERTIES.includes(property) || 
           SPACING_PROPERTIES.includes(property) ||
           POSITION_PROPERTIES.includes(property) ||
           property.includes('width') ||
           property.includes('height') ||
           property.includes('size');
  }

  _isSignificantColorDifference(baseValue, compareValue) {
    const baseRgba = this._parseRgba(baseValue);
    const compareRgba = this._parseRgba(compareValue);

    if (!baseRgba || !compareRgba) {
      return baseValue !== compareValue;
    }

    const rDiff = Math.abs(baseRgba.r - compareRgba.r);
    const gDiff = Math.abs(baseRgba.g - compareRgba.g);
    const bDiff = Math.abs(baseRgba.b - compareRgba.b);
    const aDiff = Math.abs(baseRgba.a - compareRgba.a);

    return rDiff > this.colorTolerance ||
           gDiff > this.colorTolerance ||
           bDiff > this.colorTolerance ||
           aDiff > 0.05;
  }

  _isSignificantSizeDifference(baseValue, compareValue) {
    const basePx = this._parsePx(baseValue);
    const comparePx = this._parsePx(compareValue);

    if (basePx === null || comparePx === null) {
      return baseValue !== compareValue;
    }

    return Math.abs(basePx - comparePx) > this.sizeTolerance;
  }

  _parseRgba(value) {
    if (typeof value !== 'string') return null;

    const match = value.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+))?\s*\)/);
    if (!match) return null;

    return {
      r: parseInt(match[1]),
      g: parseInt(match[2]),
      b: parseInt(match[3]),
      a: match[4] ? parseFloat(match[4]) : 1
    };
  }

  _parsePx(value) {
    if (typeof value !== 'string') return null;

    const match = value.match(/^([0-9.]+)px$/);
    return match ? parseFloat(match[1]) : null;
  }

  _shouldIgnoreInDynamicMode(property) {
    const dynamicIgnoreList = [
      'background-image',
      'content',
      'cursor',
      'pointer-events'
    ];

    return dynamicIgnoreList.includes(property);
  }

  _categorizeProperty(property) {
    if (LAYOUT_PROPERTIES.includes(property)) return PROPERTY_CATEGORIES.LAYOUT;
    if (VISUAL_PROPERTIES.includes(property)) return PROPERTY_CATEGORIES.VISUAL;
    if (TYPOGRAPHY_PROPERTIES.includes(property)) return PROPERTY_CATEGORIES.TYPOGRAPHY;
    if (SPACING_PROPERTIES.includes(property)) return PROPERTY_CATEGORIES.SPACING;
    if (POSITION_PROPERTIES.includes(property)) return PROPERTY_CATEGORIES.POSITION;
    return PROPERTY_CATEGORIES.OTHER;
  }
}

export { DIFF_TYPES, PROPERTY_CATEGORIES, PropertyDiffer };

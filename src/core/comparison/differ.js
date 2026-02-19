import { get } from '../../config/defaults.js';
import { normalizerEngine } from '../normalization/normalizer-engine.js';
import { parseRgba, parsePx } from '../../shared/color-utils.js';

const DIFF_TYPES = {
  UNCHANGED: 'unchanged',
  MODIFIED:  'modified',
  ADDED:     'added',
  REMOVED:   'removed'
};

const PROPERTY_CATEGORIES = {
  LAYOUT:     'layout',
  VISUAL:     'visual',
  TYPOGRAPHY: 'typography',
  SPACING:    'spacing',
  POSITION:   'position',
  OTHER:      'other'
};

class PropertyDiffer {
  constructor() {
    this.normalizer = normalizerEngine;

    this._categories = {
      layout:     new Set(get('comparison.propertyCategories.layout')),
      visual:     new Set(get('comparison.propertyCategories.visual')),
      typography: new Set(get('comparison.propertyCategories.typography')),
      spacing:    new Set(get('comparison.propertyCategories.spacing')),
      position:   new Set(get('comparison.propertyCategories.position'))
    };
  }

  compareElements(baselineElement, compareElement, options = {}) {
    const ignoredProperties = options.ignoredProperties ?? new Set();
    const tolerances = options.tolerances ?? get('comparison.modes.static.tolerances');

    const baseNorm    = this.normalizer.normalize(baselineElement.styles || {});
    const compareNorm = this.normalizer.normalize(compareElement.styles  || {});

    const allProperties = new Set([
      ...Object.keys(baseNorm),
      ...Object.keys(compareNorm)
    ]);

    const differences = [];

    for (const property of allProperties) {
      if (ignoredProperties.has(property)) continue;

      const baseValue    = baseNorm[property];
      const compareValue = compareNorm[property];
      const diffType     = this._getDiffType(baseValue, compareValue);

      if (diffType === DIFF_TYPES.UNCHANGED) continue;

      if (this._withinTolerance(property, baseValue, compareValue, tolerances)) continue;

      differences.push({
        property,
        baseValue,
        compareValue,
        type:     diffType,
        category: this._categorizeProperty(property)
      });
    }

    return {
      elementId:        baselineElement.id,
      tagName:          baselineElement.tagName,
      totalDifferences: differences.length,
      differences
    };
  }

  _getDiffType(baseValue, compareValue) {
    if (baseValue === undefined && compareValue !== undefined) return DIFF_TYPES.ADDED;
    if (baseValue !== undefined && compareValue === undefined) return DIFF_TYPES.REMOVED;
    if (baseValue === compareValue)                            return DIFF_TYPES.UNCHANGED;
    return DIFF_TYPES.MODIFIED;
  }

  _withinTolerance(property, baseValue, compareValue, tolerances) {
    if (baseValue === undefined || compareValue === undefined) return false;

    if (this._categories.visual.has(property) || property.includes('color')) {
      return this._colorWithinTolerance(baseValue, compareValue, tolerances.color ?? 5);
    }

    if (
      this._categories.layout.has(property)   ||
      this._categories.spacing.has(property)  ||
      this._categories.position.has(property) ||
      property.includes('width') ||
      property.includes('height') ||
      property.includes('size')
    ) {
      return this._sizeWithinTolerance(baseValue, compareValue, tolerances.size ?? 3);
    }

    if (property === 'opacity') {
      const b = parseFloat(baseValue);
      const c = parseFloat(compareValue);
      if (!isNaN(b) && !isNaN(c)) return Math.abs(b - c) <= (tolerances.opacity ?? 0.01);
    }

    return false;
  }

  _colorWithinTolerance(baseValue, compareValue, tolerance) {
    const baseRgba    = parseRgba(baseValue);
    const compareRgba = parseRgba(compareValue);
    if (!baseRgba || !compareRgba) return baseValue === compareValue;
    return (
      Math.abs(baseRgba.r - compareRgba.r) <= tolerance &&
      Math.abs(baseRgba.g - compareRgba.g) <= tolerance &&
      Math.abs(baseRgba.b - compareRgba.b) <= tolerance &&
      Math.abs(baseRgba.a - compareRgba.a) <= 0.01
    );
  }

  _sizeWithinTolerance(baseValue, compareValue, tolerance) {
    const basePx    = parsePx(baseValue);
    const comparePx = parsePx(compareValue);
    if (basePx === null || comparePx === null) return baseValue === compareValue;
    return Math.abs(basePx - comparePx) <= tolerance;
  }

  _categorizeProperty(property) {
    if (this._categories.layout.has(property))     return PROPERTY_CATEGORIES.LAYOUT;
    if (this._categories.visual.has(property))     return PROPERTY_CATEGORIES.VISUAL;
    if (this._categories.typography.has(property)) return PROPERTY_CATEGORIES.TYPOGRAPHY;
    if (this._categories.spacing.has(property))    return PROPERTY_CATEGORIES.SPACING;
    if (this._categories.position.has(property))   return PROPERTY_CATEGORIES.POSITION;
    return PROPERTY_CATEGORIES.OTHER;
  }
}

export { PropertyDiffer, DIFF_TYPES, PROPERTY_CATEGORIES };
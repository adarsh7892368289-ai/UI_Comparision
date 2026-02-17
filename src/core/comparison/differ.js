import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';
import { NormalizerEngine } from '../normalization/normalizer-engine.js';

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

// Read property category arrays from config — no hardcoded lists
function getCategories() {
  return {
    layout:     get('comparison.propertyCategories.layout'),
    visual:     get('comparison.propertyCategories.visual'),
    typography: get('comparison.propertyCategories.typography'),
    spacing:    get('comparison.propertyCategories.spacing'),
    position:   get('comparison.propertyCategories.position')
  };
}

class PropertyDiffer {
  constructor() {
    this.normalizer     = new NormalizerEngine();
    // Read tolerances from config — not from comparison.colorTolerance (old key)
    this.colorTolerance = get('comparison.tolerances.color', 5);
    this.sizeTolerance  = get('comparison.tolerances.size', 3);
    this.opacityTolerance = get('comparison.tolerances.opacity', 0.01);
  }

  compareElements(baselineElement, compareElement, mode = 'static') {
    const baselineNormalized = this.normalizer.normalize(baselineElement.styles || {});
    const compareNormalized  = this.normalizer.normalize(compareElement.styles || {});

    // In dynamic mode, use tighter-scoped tolerances from config
    const tolerances = mode === 'dynamic'
      ? get('comparison.modes.dynamic.tolerances')
      : get('comparison.modes.static.tolerances');

    const ignoredProperties = mode === 'dynamic'
      ? new Set(get('comparison.modes.dynamic.ignoredProperties'))
      : new Set(get('comparison.modes.static.ignoredProperties'));

    const differences = [];
    const allProperties = new Set([
      ...Object.keys(baselineNormalized),
      ...Object.keys(compareNormalized)
    ]);

    for (const property of allProperties) {
      if (ignoredProperties.has(property)) continue;

      const baseValue    = baselineNormalized[property];
      const compareValue = compareNormalized[property];
      const diffType     = this._getDiffType(baseValue, compareValue);

      if (diffType === DIFF_TYPES.UNCHANGED) continue;

      const isSignificant = this._isSignificantDifference(
        property, baseValue, compareValue, tolerances
      );

      if (isSignificant) {
        differences.push({
          property,
          baseValue,
          compareValue,
          type:     diffType,
          category: this._categorizeProperty(property)
        });
      }
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

  _isSignificantDifference(property, baseValue, compareValue, tolerances) {
    if (baseValue === undefined || compareValue === undefined) return true;

    if (this._isColorProperty(property)) {
      return this._isSignificantColorDifference(baseValue, compareValue, tolerances.color);
    }
    if (this._isSizeProperty(property)) {
      return this._isSignificantSizeDifference(baseValue, compareValue, tolerances.size);
    }
    return baseValue !== compareValue;
  }

  _isColorProperty(property) {
    const visual = get('comparison.propertyCategories.visual');
    return visual.includes(property) || property.includes('color');
  }

  _isSizeProperty(property) {
    const cats = getCategories();
    return cats.layout.includes(property) ||
           cats.spacing.includes(property) ||
           cats.position.includes(property) ||
           property.includes('width') ||
           property.includes('height') ||
           property.includes('size');
  }

  _isSignificantColorDifference(baseValue, compareValue, colorTolerance) {
    const baseRgba    = this._parseRgba(baseValue);
    const compareRgba = this._parseRgba(compareValue);
    if (!baseRgba || !compareRgba) return baseValue !== compareValue;

    const opacityTol = get('comparison.tolerances.opacity', 0.01);
    return (
      Math.abs(baseRgba.r - compareRgba.r) > colorTolerance ||
      Math.abs(baseRgba.g - compareRgba.g) > colorTolerance ||
      Math.abs(baseRgba.b - compareRgba.b) > colorTolerance ||
      Math.abs(baseRgba.a - compareRgba.a) > opacityTol
    );
  }

  _isSignificantSizeDifference(baseValue, compareValue, sizeTolerance) {
    const basePx    = this._parsePx(baseValue);
    const comparePx = this._parsePx(compareValue);
    if (basePx === null || comparePx === null) return baseValue !== compareValue;
    return Math.abs(basePx - comparePx) > sizeTolerance;
  }

  _parseRgba(value) {
    if (typeof value !== 'string') return null;
    const m = value.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+))?\s*\)/);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] != null ? +m[4] : 1 };
  }

  _parsePx(value) {
    if (typeof value !== 'string') return null;
    const m = value.match(/^([0-9.]+)px$/);
    return m ? parseFloat(m[1]) : null;
  }

  _categorizeProperty(property) {
    const cats = getCategories();
    if (cats.layout.includes(property))     return PROPERTY_CATEGORIES.LAYOUT;
    if (cats.visual.includes(property))     return PROPERTY_CATEGORIES.VISUAL;
    if (cats.typography.includes(property)) return PROPERTY_CATEGORIES.TYPOGRAPHY;
    if (cats.spacing.includes(property))    return PROPERTY_CATEGORIES.SPACING;
    if (cats.position.includes(property))   return PROPERTY_CATEGORIES.POSITION;
    return PROPERTY_CATEGORIES.OTHER;
  }
}

export { PropertyDiffer, DIFF_TYPES, PROPERTY_CATEGORIES };
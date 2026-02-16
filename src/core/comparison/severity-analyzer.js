import logger from '../../infrastructure/logger.js';
import { PROPERTY_CATEGORIES } from './differ.js';

const SEVERITY_LEVELS = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low'
};

const CRITICAL_PROPERTIES = [
  'display', 'visibility', 'position', 'z-index'
];

const HIGH_PROPERTIES = [
  'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
  'color', 'background-color', 'opacity',
  'font-size', 'font-family', 'font-weight'
];

const MEDIUM_PROPERTIES = [
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-width', 'border-color', 'border-style',
  'line-height', 'text-align', 'font-style'
];

class SeverityAnalyzer {
  analyzeDifferences(differences) {
    if (!differences || differences.length === 0) {
      return {
        overallSeverity: null,
        severityCounts: {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0
        },
        annotatedDifferences: []
      };
    }

    const annotated = differences.map(diff => ({
      ...diff,
      severity: this._calculateSeverity(diff)
    }));

    const severityCounts = this._countBySeverity(annotated);
    const overallSeverity = this._determineOverallSeverity(severityCounts);

    return {
      overallSeverity,
      severityCounts,
      annotatedDifferences: annotated
    };
  }

  _calculateSeverity(difference) {
    const { property, baseValue, compareValue, category } = difference;

    if (CRITICAL_PROPERTIES.includes(property)) {
      return SEVERITY_LEVELS.CRITICAL;
    }

    if (this._isLayoutBreaking(property, baseValue, compareValue)) {
      return SEVERITY_LEVELS.CRITICAL;
    }

    if (HIGH_PROPERTIES.includes(property)) {
      return SEVERITY_LEVELS.HIGH;
    }

    if (this._hasHighVisualImpact(property, baseValue, compareValue)) {
      return SEVERITY_LEVELS.HIGH;
    }

    if (MEDIUM_PROPERTIES.includes(property)) {
      return SEVERITY_LEVELS.MEDIUM;
    }

    if (category === PROPERTY_CATEGORIES.LAYOUT) {
      return SEVERITY_LEVELS.MEDIUM;
    }

    return SEVERITY_LEVELS.LOW;
  }

  _isLayoutBreaking(property, baseValue, compareValue) {
    if (property === 'display') {
      const baseIsBlock = ['block', 'flex', 'grid', 'inline-block'].includes(baseValue);
      const compareIsBlock = ['block', 'flex', 'grid', 'inline-block'].includes(compareValue);
      
      if (baseIsBlock !== compareIsBlock) {
        return true;
      }

      if (baseValue === 'none' || compareValue === 'none') {
        return true;
      }
    }

    if (property === 'position') {
      if (baseValue !== compareValue) {
        return ['absolute', 'fixed'].includes(baseValue) || 
               ['absolute', 'fixed'].includes(compareValue);
      }
    }

    if (property === 'width' || property === 'height') {
      const basePx = this._parsePx(baseValue);
      const comparePx = this._parsePx(compareValue);

      if (basePx && comparePx) {
        const percentChange = Math.abs((comparePx - basePx) / basePx) * 100;
        return percentChange > 50;
      }
    }

    return false;
  }

  _hasHighVisualImpact(property, baseValue, compareValue) {
    if (property === 'opacity') {
      const baseOpacity = parseFloat(baseValue);
      const compareOpacity = parseFloat(compareValue);

      if (!isNaN(baseOpacity) && !isNaN(compareOpacity)) {
        return Math.abs(baseOpacity - compareOpacity) > 0.3;
      }
    }

    if (property.includes('color')) {
      const baseRgba = this._parseRgba(baseValue);
      const compareRgba = this._parseRgba(compareValue);

      if (baseRgba && compareRgba) {
        const luminanceBase = this._calculateLuminance(baseRgba);
        const luminanceCompare = this._calculateLuminance(compareRgba);

        return Math.abs(luminanceBase - luminanceCompare) > 0.4;
      }
    }

    if (property === 'font-size') {
      const basePx = this._parsePx(baseValue);
      const comparePx = this._parsePx(compareValue);

      if (basePx && comparePx) {
        const percentChange = Math.abs((comparePx - basePx) / basePx) * 100;
        return percentChange > 25;
      }
    }

    return false;
  }

  _calculateLuminance(rgba) {
    const r = rgba.r / 255;
    const g = rgba.g / 255;
    const b = rgba.b / 255;

    const rLinear = r <= 0.03928 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
    const gLinear = g <= 0.03928 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
    const bLinear = b <= 0.03928 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);

    return 0.2126 * rLinear + 0.7152 * gLinear + 0.0722 * bLinear;
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

  _countBySeverity(annotatedDifferences) {
    const counts = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0
    };

    for (const diff of annotatedDifferences) {
      counts[diff.severity]++;
    }

    return counts;
  }

  _determineOverallSeverity(severityCounts) {
    if (severityCounts.critical > 0) {
      return SEVERITY_LEVELS.CRITICAL;
    }
    if (severityCounts.high > 0) {
      return SEVERITY_LEVELS.HIGH;
    }
    if (severityCounts.medium > 0) {
      return SEVERITY_LEVELS.MEDIUM;
    }
    if (severityCounts.low > 0) {
      return SEVERITY_LEVELS.LOW;
    }
    return null;
  }
}

export { SeverityAnalyzer, SEVERITY_LEVELS };
import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';
import { PropertyDiffer } from './differ.js';
import { SeverityAnalyzer } from './severity-analyzer.js';

const STATIC_FILTER = {
  ignoredProperties:        new Set(get('comparison.modes.static.ignoredProperties')),
  compareTextContent:       get('comparison.modes.static.compareTextContent'),
  structuralAttributesOnly: false,
  tolerances:               get('comparison.modes.static.tolerances')
};

const DYNAMIC_FILTER = {
  ignoredProperties:        new Set(get('comparison.modes.dynamic.ignoredProperties')),
  compareTextContent:       get('comparison.modes.dynamic.compareTextContent'),
  structuralAttributesOnly: true,
  structuralAttributes:     new Set(get('comparison.modes.dynamic.structuralOnlyAttributes', [
    'role', 'aria-label', 'type', 'name', 'data-testid'
  ])),
  tolerances:               get('comparison.modes.dynamic.tolerances')
};

class BaseComparisonMode {
  /**
   * @param {Object} [deps]
   * @param {PropertyDiffer}    [deps.differ]           - injectable for testing
   * @param {SeverityAnalyzer}  [deps.severityAnalyzer] - injectable for testing
   */
  constructor({ differ, severityAnalyzer } = {}) {
    this.differ           = differ           ?? new PropertyDiffer();
    this.severityAnalyzer = severityAnalyzer ?? new SeverityAnalyzer();
  }

  _compareMatch(match, filter) {
    const { baselineElement, compareElement } = match;

    const styleResult = this.differ.compareElements(baselineElement, compareElement, {
      ignoredProperties: filter.ignoredProperties,
      tolerances:        filter.tolerances
    });

    const textDiffs = filter.compareTextContent
      ? this._compareTextContent(baselineElement, compareElement)
      : [];

    const attrDiffs = this._compareAttributes(
      baselineElement,
      compareElement,
      filter.structuralAttributesOnly ? filter.structuralAttributes : null
    );

    const allDiffs = [...styleResult.differences, ...textDiffs, ...attrDiffs];
    const severity = this.severityAnalyzer.analyzeDifferences(allDiffs);

    return {
      ...match,
      elementId:            styleResult.elementId,
      tagName:              styleResult.tagName,
      differences:          allDiffs,
      totalDifferences:     allDiffs.length,
      overallSeverity:      severity.overallSeverity,
      severityCounts:       severity.severityCounts,
      annotatedDifferences: severity.annotatedDifferences
    };
  }

  _compareTextContent(baselineElement, compareElement) {
    const base    = (baselineElement.textContent ?? '').trim();
    const compare = (compareElement.textContent  ?? '').trim();
    if (base === compare) return [];
    return [{ property: 'textContent', baseValue: base, compareValue: compare, category: 'content', type: 'modified' }];
  }

  _compareAttributes(baselineElement, compareElement, allowList = null) {
    const baseAttrs    = baselineElement.attributes ?? {};
    const compareAttrs = compareElement.attributes  ?? {};
    const allKeys      = new Set([...Object.keys(baseAttrs), ...Object.keys(compareAttrs)]);
    const diffs        = [];

    for (const key of allKeys) {
      if (allowList && !allowList.has(key)) continue;
      if (baseAttrs[key] === compareAttrs[key]) continue;
      diffs.push({
        property:     `attr:${key}`,
        baseValue:    baseAttrs[key]    ?? null,
        compareValue: compareAttrs[key] ?? null,
        category:     'attribute',
        type:         this._attrDiffType(baseAttrs[key], compareAttrs[key])
      });
    }
    return diffs;
  }

  _attrDiffType(baseVal, compareVal) {
    if (baseVal == null && compareVal != null) return 'added';
    if (baseVal != null && compareVal == null) return 'removed';
    return 'modified';
  }

  _generateSummary(results, mode) {
    const totalElements     = results.length;
    const unchangedElements = results.filter(r => r.totalDifferences === 0).length;
    const modifiedElements  = results.filter(r => r.totalDifferences > 0).length;
    const totalDifferences  = results.reduce((sum, r) => sum + r.totalDifferences, 0);

    const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const r of results) {
      if (r.severityCounts) {
        severityCounts.critical += r.severityCounts.critical;
        severityCounts.high     += r.severityCounts.high;
        severityCounts.medium   += r.severityCounts.medium;
        severityCounts.low      += r.severityCounts.low;
      }
    }

    logger.info(`${mode} comparison summary`, {
      totalElements, unchangedElements, modifiedElements, totalDifferences, severityCounts
    });

    return { totalElements, unchangedElements, modifiedElements, totalDifferences, severityCounts };
  }
}

class StaticComparisonMode extends BaseComparisonMode {
  constructor(deps = {}) { super(deps); }

  compare(matches) {
    const results = matches.map(match => this._compareMatch(match, STATIC_FILTER));
    return { mode: 'static', results, summary: this._generateSummary(results, 'static') };
  }
}

class DynamicComparisonMode extends BaseComparisonMode {
  constructor(deps = {}) { super(deps); }

  compare(matches) {
    const results = matches.map(match => this._compareMatch(match, DYNAMIC_FILTER));
    return { mode: 'dynamic', results, summary: this._generateSummary(results, 'dynamic') };
  }
}

export { StaticComparisonMode, DynamicComparisonMode, STATIC_FILTER, DYNAMIC_FILTER };
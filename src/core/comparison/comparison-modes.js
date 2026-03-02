import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';
import { PropertyDiffer } from './differ.js';
import { SeverityAnalyzer } from './severity-analyzer.js';
import { yieldToEventLoop, YIELD_CHUNK_SIZE, progressFrame, resultFrame } from './async-utils.js';

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
  #differ;
  #severityAnalyzer;

  constructor({ differ, severityAnalyzer } = {}) {
    this.#differ           = differ           ?? new PropertyDiffer();
    this.#severityAnalyzer = severityAnalyzer ?? new SeverityAnalyzer();
  }

  compareMatch(match, filter) {
    const { baselineElement, compareElement } = match;

    const styleResult = this.#differ.compareElements(baselineElement, compareElement, {
      ignoredProperties: filter.ignoredProperties,
      tolerances:        filter.tolerances
    });

    const textDiffs = filter.compareTextContent
      ? this.compareTextContent(baselineElement, compareElement)
      : [];

    const attrDiffs = this.compareAttributes(
      baselineElement,
      compareElement,
      filter.structuralAttributesOnly ? filter.structuralAttributes : null
    );

    const allDiffs = [...styleResult.differences, ...textDiffs, ...attrDiffs];
    const severity = this.#severityAnalyzer.analyzeDifferences(allDiffs);

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

  compareTextContent(baselineElement, compareElement) {
    const baseText    = (baselineElement.textContent ?? '').trim();
    const compareText = (compareElement.textContent  ?? '').trim();
    if (baseText === compareText) {
      return [];
    }
    return [{
      property:     'textContent',
      baseValue:    baseText,
      compareValue: compareText,
      category:     'content',
      type:         'modified'
    }];
  }

  compareAttributes(baselineElement, compareElement, allowList = null) {
    const baseAttrs    = baselineElement.attributes ?? {};
    const compareAttrs = compareElement.attributes  ?? {};
    const allKeys      = new Set([...Object.keys(baseAttrs), ...Object.keys(compareAttrs)]);
    const diffs        = [];

    for (const key of allKeys) {
      if (allowList && !allowList.has(key)) {
        continue;
      }
      if (baseAttrs[key] === compareAttrs[key]) {
        continue;
      }
      diffs.push({
        property:     `attr:${key}`,
        baseValue:    baseAttrs[key]    ?? null,
        compareValue: compareAttrs[key] ?? null,
        category:     'attribute',
        type:         this.attrDiffType(baseAttrs[key], compareAttrs[key])
      });
    }
    return diffs;
  }

  attrDiffType(baseVal, compareVal) {
    if (baseVal == null && compareVal != null) {
      return 'added';
    }
    if (baseVal != null && compareVal == null) {
      return 'removed';
    }
    return 'modified';
  }

  generateSummary(diffResults, ambiguous, modeName) {
    const totalElements     = diffResults.length;
    const unchangedElements = diffResults.filter(r => r.totalDifferences === 0).length;
    const modifiedElements  = diffResults.filter(r => r.totalDifferences > 0).length;
    const totalDifferences  = diffResults.reduce((sum, r) => sum + r.totalDifferences, 0);
    const ambiguousCount    = ambiguous.length;

    const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const resultItem of diffResults) {
      if (resultItem.severityCounts) {
        severityCounts.critical += resultItem.severityCounts.critical;
        severityCounts.high     += resultItem.severityCounts.high;
        severityCounts.medium   += resultItem.severityCounts.medium;
        severityCounts.low      += resultItem.severityCounts.low;
      }
    }

    logger.info(`${modeName} comparison summary`, {
      totalElements, unchangedElements, modifiedElements,
      totalDifferences, ambiguousCount, severityCounts
    });

    return {
      totalElements,
      unchangedElements,
      modifiedElements,
      totalDifferences,
      ambiguousCount,
      severityCounts
    };
  }

  async* compareChunked(matches, ambiguous, filter, modeName) {
    const total       = matches.length;
    const diffResults = [];

    for (let start = 0; start < total; start += YIELD_CHUNK_SIZE) {
      const end = Math.min(start + YIELD_CHUNK_SIZE, total);
      for (let i = start; i < end; i++) {
        diffResults.push(this.compareMatch(matches[i], filter));
      }
      await yieldToEventLoop();
      yield progressFrame('Comparing properties…', end);
    }

    yield resultFrame({
      modeName,
      results:  diffResults,
      ambiguous,
      summary:  this.generateSummary(diffResults, ambiguous, modeName)
    });
  }
}

class StaticComparisonMode extends BaseComparisonMode {
  constructor(deps = {}) {
    super(deps);
  }

  async* compare(matches, ambiguous = []) {
    yield* this.compareChunked(matches, ambiguous, STATIC_FILTER, 'static');
  }
}

class DynamicComparisonMode extends BaseComparisonMode {
  constructor(deps = {}) {
    super(deps);
  }

  async* compare(matches, ambiguous = []) {
    yield* this.compareChunked(matches, ambiguous, DYNAMIC_FILTER, 'dynamic');
  }
}

export { StaticComparisonMode, DynamicComparisonMode, STATIC_FILTER, DYNAMIC_FILTER };
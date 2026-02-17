import { get } from '../../../config/defaults.js';
import logger from '../../../infrastructure/logger.js';
import { PropertyDiffer } from '../differ.js';
import { SeverityAnalyzer } from '../severity-analyzer.js';

class DynamicComparisonMode {
  constructor() {
    this.differ          = new PropertyDiffer();
    this.severityAnalyzer = new SeverityAnalyzer();
    // Build ignored-property Set once from config — not a hardcoded array
    this._ignoredProps   = new Set(get('comparison.modes.dynamic.ignoredProperties'));
    this._compareText    = get('comparison.modes.dynamic.compareTextContent');
  }

  compare(matches) {
    logger.info('Running dynamic comparison', { matchCount: matches.length });

    const results = [];

    for (const match of matches) {
      // Pass mode='dynamic' so differ uses dynamic tolerances
      const comparison = this.differ.compareElements(
        match.baselineElement,
        match.compareElement,
        'dynamic'
      );

      // Secondary filter: remove any properties still in the ignored set
      // (differ.js already skips them, but this guards against config drift)
      const filteredDifferences = comparison.differences.filter(
        diff => !this._ignoredProps.has(diff.property)
      );

      // Optionally skip text content diffs in dynamic mode
      const finalDifferences = this._compareText
        ? filteredDifferences
        : filteredDifferences.filter(d => d.property !== 'content');

      const severityAnalysis = this.severityAnalyzer.analyzeDifferences(finalDifferences);

      results.push({
        ...match,
        ...comparison,
        differences:      finalDifferences,
        totalDifferences: finalDifferences.length,
        ...severityAnalysis
      });
    }

    const summary = this._generateSummary(results);

    return { mode: 'dynamic', results, summary };
  }

  _generateSummary(results) {
    const totalElements     = results.length;
    const unchangedElements = results.filter(r => r.totalDifferences === 0).length;
    const modifiedElements  = results.filter(r => r.totalDifferences > 0).length;
    const totalDifferences  = results.reduce((sum, r) => sum + r.totalDifferences, 0);

    const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const result of results) {
      if (result.severityCounts) {
        severityCounts.critical += result.severityCounts.critical;
        severityCounts.high     += result.severityCounts.high;
        severityCounts.medium   += result.severityCounts.medium;
        severityCounts.low      += result.severityCounts.low;
      }
    }

    return { totalElements, unchangedElements, modifiedElements, totalDifferences, severityCounts };
  }
}

export { DynamicComparisonMode };
import logger from '../../../infrastructure/logger.js';
import { PropertyDiffer } from '../differ.js';
import { SeverityAnalyzer } from '../severity-analyzer.js';

class StaticComparisonMode {
  constructor() {
    this.differ = new PropertyDiffer();
    this.severityAnalyzer = new SeverityAnalyzer();
  }

  compare(matches) {
    logger.info('Running static comparison', { matchCount: matches.length });

    const results = [];

    for (const match of matches) {
      const comparison = this.differ.compareElements(
        match.baselineElement,
        match.compareElement,
        'static'
      );

      const severityAnalysis = this.severityAnalyzer.analyzeDifferences(
        comparison.differences
      );

      results.push({
        ...match,
        ...comparison,
        ...severityAnalysis
      });
    }

    const summary = this._generateSummary(results);

    return {
      mode: 'static',
      results,
      summary
    };
  }

  _generateSummary(results) {
    const totalElements = results.length;
    const unchangedElements = results.filter(r => r.totalDifferences === 0).length;
    const modifiedElements = results.filter(r => r.totalDifferences > 0).length;

    const totalDifferences = results.reduce((sum, r) => sum + r.totalDifferences, 0);

    const severityCounts = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0
    };

    for (const result of results) {
      if (result.severityCounts) {
        severityCounts.critical += result.severityCounts.critical;
        severityCounts.high += result.severityCounts.high;
        severityCounts.medium += result.severityCounts.medium;
        severityCounts.low += result.severityCounts.low;
      }
    }

    return {
      totalElements,
      unchangedElements,
      modifiedElements,
      totalDifferences,
      severityCounts
    };
  }
}

export { StaticComparisonMode };
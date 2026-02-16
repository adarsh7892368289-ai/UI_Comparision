import logger from '../../../infrastructure/logger.js';
import { PropertyDiffer } from '../differ.js';
import { SeverityAnalyzer } from '../severity-analyzer.js';

class DynamicComparisonMode {
  constructor() {
    this.differ = new PropertyDiffer();
    this.severityAnalyzer = new SeverityAnalyzer();
  }

  compare(matches) {
    logger.info('Running dynamic comparison', { matchCount: matches.length });

    const results = [];

    for (const match of matches) {
      const comparison = this.differ.compareElements(
        match.baselineElement,
        match.compareElement,
        'dynamic'
      );

      const filteredDifferences = this._filterDynamicDifferences(comparison.differences);

      const severityAnalysis = this.severityAnalyzer.analyzeDifferences(filteredDifferences);

      results.push({
        ...match,
        ...comparison,
        differences: filteredDifferences,
        totalDifferences: filteredDifferences.length,
        ...severityAnalysis
      });
    }

    const summary = this._generateSummary(results);

    return {
      mode: 'dynamic',
      results,
      summary
    };
  }

  _filterDynamicDifferences(differences) {
    return differences.filter(diff => !this._isDynamicProperty(diff.property));
  }

  _isDynamicProperty(property) {
    const dynamicProperties = [
      'background-image',
      'content',
      'cursor',
      'pointer-events'
    ];

    return dynamicProperties.includes(property);
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

export { DynamicComparisonMode };
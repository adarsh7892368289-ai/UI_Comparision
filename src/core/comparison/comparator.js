import { ElementMatcher } from './matcher.js';
import { StaticComparisonMode, DynamicComparisonMode } from './comparison-modes.js';

class Comparator {
  constructor({ matcher, modes, logger } = {}) {
    this.matcher = matcher ?? new ElementMatcher();
    this.modes = modes ?? {
      static: new StaticComparisonMode(),
      dynamic: new DynamicComparisonMode()
    };
    this.logger = logger;
  }

  compare(baselineReport, compareReport, mode = 'static') {
    const startTime = performance.now();

    if (this.logger) {
      this.logger.info('Starting comparison', {
        mode,
        baselineUrl: baselineReport.url,
        compareUrl: compareReport.url,
        baselineElements: baselineReport.elements.length,
        compareElements: compareReport.elements.length
      });
    }

    const matchingResult = this.matcher.matchElements(
      baselineReport.elements,
      compareReport.elements
    );

    const comparisonMode = this.modes[mode] ?? this.modes.static;
    const comparisonResult = comparisonMode.compare(matchingResult.matches);

    const duration = performance.now() - startTime;

    const finalResult = {
      baseline: {
        id: baselineReport.id,
        url: baselineReport.url,
        title: baselineReport.title,
        timestamp: baselineReport.timestamp,
        totalElements: baselineReport.elements.length
      },
      compare: {
        id: compareReport.id,
        url: compareReport.url,
        title: compareReport.title,
        timestamp: compareReport.timestamp,
        totalElements: compareReport.elements.length
      },
      mode,
      matching: {
        totalMatched: matchingResult.matches.length,
        unmatchedBaseline: matchingResult.unmatchedBaseline.length,
        unmatchedCompare: matchingResult.unmatchedCompare.length,
        matchRate: this._calculateMatchRate(
          matchingResult.matches.length,
          baselineReport.elements.length
        )
      },
      comparison: comparisonResult,
      unmatchedElements: {
        baseline: matchingResult.unmatchedBaseline.map(el => ({
          id: el.id,
          tagName: el.tagName,
          elementId: el.elementId,
          className: el.className
        })),
        compare: matchingResult.unmatchedCompare.map(el => ({
          id: el.id,
          tagName: el.tagName,
          elementId: el.elementId,
          className: el.className
        }))
      },
      duration: Math.round(duration),
      timestamp: new Date().toISOString()
    };

    if (this.logger) {
      this.logger.info('Comparison complete', {
        duration: Math.round(duration),
        matched: matchingResult.matches.length,
        differences: comparisonResult.summary.totalDifferences
      });
    }

    return finalResult;
  }

  _calculateMatchRate(matched, total) {
    if (total === 0) return 0;
    return Math.round((matched / total) * 100);
  }
}

export { Comparator };
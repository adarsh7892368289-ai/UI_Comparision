import { ElementMatcher } from './matcher.js';
import { StaticComparisonMode, DynamicComparisonMode } from './comparison-modes.js';

class Comparator {
  #matcher;
  #modes;
  #onProgress;

  constructor({ matcher, modes, onProgress } = {}) {
    this.#matcher = matcher ?? new ElementMatcher();
    this.#modes = modes ?? {
      static:  new StaticComparisonMode(),
      dynamic: new DynamicComparisonMode()
    };
    this.#onProgress = typeof onProgress === 'function' ? onProgress : null;
  }

  compare(baselineReport, compareReport, mode = 'static') {
    const startTime = performance.now();

    this.#emit('Matching elements…', 15);

    const matchingResult = this.#matcher.matchElements(
      baselineReport.elements,
      compareReport.elements
    );

    this.#emit('Comparing properties…', 50);

    const comparisonMode = this.#modes[mode] ?? this.#modes.static;
    const comparisonResult = comparisonMode.compare(matchingResult.matches);

    this.#emit('Finalising results…', 90);

    const duration = performance.now() - startTime;

    return {
      baseline: {
        id:            baselineReport.id,
        url:           baselineReport.url,
        title:         baselineReport.title,
        timestamp:     baselineReport.timestamp,
        totalElements: baselineReport.elements.length
      },
      compare: {
        id:            compareReport.id,
        url:           compareReport.url,
        title:         compareReport.title,
        timestamp:     compareReport.timestamp,
        totalElements: compareReport.elements.length
      },
      mode,
      matching: {
        totalMatched:     matchingResult.matches.length,
        unmatchedBaseline: matchingResult.unmatchedBaseline.length,
        unmatchedCompare:  matchingResult.unmatchedCompare.length,
        matchRate:         this.#calculateMatchRate(
          matchingResult.matches.length,
          baselineReport.elements.length
        )
      },
      comparison: comparisonResult,
      unmatchedElements: {
        baseline: matchingResult.unmatchedBaseline.map(el => ({
          id: el.id, tagName: el.tagName, elementId: el.elementId, className: el.className
        })),
        compare: matchingResult.unmatchedCompare.map(el => ({
          id: el.id, tagName: el.tagName, elementId: el.elementId, className: el.className
        }))
      },
      duration:  Math.round(duration),
      timestamp: new Date().toISOString()
    };
  }

  #emit(label, pct) {
    if (this.#onProgress) {
      this.#onProgress(label, pct);
    }
  }

  #calculateMatchRate(matched, total) {
    if (total === 0) {
      return 0;
    }
    return Math.round((matched / total) * 100);
  }
}

export { Comparator };
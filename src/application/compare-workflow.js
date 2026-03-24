/**
 * Orchestrates the full comparison workflow: pre-flight URL checks, schema version
 * validation, element matching, visual diffing, and IDB persistence. Runs in the
 * MV3 service worker.
 * Failure mode contained here: PreFlightError and CompatibilityError are re-thrown
 * as-is so the caller can distinguish user-actionable failures from infrastructure
 * errors. All other errors are wrapped into a plain Error to normalise the message.
 * Callers: background.js (compareReports, exportComparisonAsHTML, getCachedComparison).
 */
import logger from '../infrastructure/logger.js';
import storage, { buildPairKey } from '../infrastructure/idb-repository.js';
import { getReportById } from './report-manager.js';
import { Comparator } from '../core/comparison/comparator.js';
import { computeSeverityBreakdown } from '../core/comparison/comparison-modes.js';
import { exportToHTML } from '../core/export/comparison/html-exporter.js';
import { assessUrlCompatibility } from './url-compatibility.js';
import { captureVisualDiffs } from './visual-workflow.js';

const MINIMUM_SCHEMA_VERSION = '3.0';

/**
 * Thrown when the URL pre-flight check determines the two reports are incompatible
 * or warrant a caution. Carries the full compatResult so the caller can surface
 * details without re-running the check.
 */
class PreFlightError extends Error {
  constructor(code, compatResult) {
    super(`Pre-flight check failed: ${code}`);
    this.name         = 'PreFlightError';
    this.code         = code;
    this.compatResult = compatResult;
  }
}

/**
 * Thrown when either report's schema version is below MINIMUM_SCHEMA_VERSION.
 * The message is user-facing and instructs the user to recapture both reports.
 */
class CompatibilityError extends Error {
  constructor(baselineVersion, compareVersion) {
    super(
      `Report schema version too old: baseline=${baselineVersion ?? 'unknown'}, ` +
      `compare=${compareVersion ?? 'unknown'}. ` +
      `Both reports must be schema version >= ${MINIMUM_SCHEMA_VERSION}. ` +
      'Recapture both reports.'
    );
    this.name            = 'CompatibilityError';
    this.baselineVersion = baselineVersion;
    this.compareVersion  = compareVersion;
  }
}

/** Parses a "major.minor" version string into numeric parts. Treats null/undefined as "0.0". */
function parseVersion(versionStr) {
  const parts = (versionStr ?? '0.0').split('.');
  return {
    major: parseInt(parts[0], 10) || 0,
    minor: parseInt(parts[1], 10) || 0
  };
}

/**
 * Returns true if versionStr is >= minStr. Major version alone determines the result
 * when the majors differ — 2.9 is less than 3.0 purely on major without checking minor.
 */
function versionAtLeast(versionStr, minStr) {
  const subject = parseVersion(versionStr);
  const minimum = parseVersion(minStr);
  if (subject.major !== minimum.major) {
    return subject.major > minimum.major;
  }
  return subject.minor >= minimum.minor;
}

/** Throws CompatibilityError if either report is below the minimum required schema version. */
function assertVersionCompatibility(baselineVersion, compareVersion) {
  const baselineSufficient = versionAtLeast(baselineVersion, MINIMUM_SCHEMA_VERSION);
  const compareSufficient  = versionAtLeast(compareVersion,  MINIMUM_SCHEMA_VERSION);
  if (!baselineSufficient || !compareSufficient) {
    throw new CompatibilityError(baselineVersion, compareVersion);
  }
}

/**
 * Consumes the async comparison generator, forwarding progress frames to onProgress
 * and capturing the final result frame. Only the last result frame is returned —
 * any intermediate result frames emitted before the generator completes are discarded.
 */
async function drainComparisonGenerator(gen, onProgress) {
  let finalResult = null;
  for await (const frame of gen) {
    if (frame.type === 'result') {
      finalResult = frame.payload;
    } else if (onProgress && frame.type === 'progress') {
      onProgress(frame.label, frame.pct);
    }
  }
  return finalResult;
}

/**
 * Main comparison entry point. Validates reports, runs URL pre-flight checks,
 * executes element matching, captures visual diffs, and persists the result.
 *
 * PreFlightError and CompatibilityError propagate as-is — callers must catch
 * by type. All other errors are wrapped into a plain Error.
 *
 * @param {Object} options
 * @param {string} options.baselineId
 * @param {string} options.compareId
 * @param {string} [options.mode='static']
 * @param {{baselineTabId: number, compareTabId: number}|null} [options.tabContext]
 * @param {boolean} [options.includeScreenshots=true]
 * @param {((label: string, pct: number) => void)|null} [options.onProgress]
 * @param {boolean} [options.skipPreFlightGate=false] - Skip URL compatibility checks;
 *   used in tests and programmatic comparisons where URLs are known to be valid.
 * @returns {Promise<Object>} Full comparison result including visualDiffs and matching stats.
 */
async function compareReports(options = {}) {
  const {
    baselineId,
    compareId,
    mode              = 'static',
    tabContext         = null,
    includeScreenshots = true,
    onProgress         = null,
    skipPreFlightGate  = false
  } = options;

  logger.info('Starting comparison', { baselineId, compareId, mode });

  try {
    const [baseline, compareReport] = await Promise.all([
      getReportById(baselineId),
      getReportById(compareId)
    ]);

    if (!baseline || !compareReport) {
      throw new Error('One or both reports not found');
    }
    if (!Array.isArray(baseline.elements)) {
      throw new Error('Baseline report missing elements array');
    }
    if (!Array.isArray(compareReport.elements)) {
      throw new Error('Compare report missing elements array');
    }

    assertVersionCompatibility(baseline.version, compareReport.version);

    let preFlightWarning = null;

    if (!skipPreFlightGate) {
      const urlCompat = assessUrlCompatibility(baseline.url, compareReport.url);

      if (urlCompat.classification === 'INCOMPATIBLE') {
        throw new PreFlightError('INCOMPATIBLE_URLS', urlCompat);
      }

      if (urlCompat.classification === 'CAUTION') {
        preFlightWarning = urlCompat;
        logger.warn('Pre-flight CAUTION: URL state mismatch detected', {
          baselineUrl: baseline.url,
          compareUrl:  compareReport.url,
          delta:       urlCompat.mismatchDelta
        });
      }
    }

    const comparator = new Comparator();
    const comparisonGen = comparator.compare(baseline, compareReport, mode);
    const result = await drainComparisonGenerator(comparisonGen, onProgress);

    result.preFlightWarning = preFlightWarning;

    logger.info('Comparison completed', {
      matched:     result.matching.totalMatched,
      ambiguous:   result.matching.ambiguousCount,
      differences: result.comparison.summary.totalDifferences,
      matchRate:   result.matching.matchRate,
      duration:    result.duration
    });

    const visualResult = await runVisualPhase(result, tabContext, includeScreenshots);
    result.visualDiffs   = visualResult.diffs;
    result.visualSessionId = visualResult.sessionId ?? null;
    result.devToolsWarnings = visualResult.devToolsWarnings ?? [];
    if (includeScreenshots) {
      result.visualDiffStatus = { status: visualResult.status, reason: visualResult.reason };
    }

    await persistComparison(result, baselineId, compareId, mode);

    return result;

  } catch (err) {
    if (err instanceof PreFlightError || err instanceof CompatibilityError) {
      throw err;
    }
    const errorMsg = err?.message || (typeof err === 'string' ? err : null) || String(err) || 'Unknown error';
    logger.error('Compare workflow failed', { error: errorMsg, stack: err.stack });
    throw new Error(errorMsg);
  }
}

/**
 * Gate for the visual diff phase. Returns a skipped result immediately if the user
 * has disabled screenshots, otherwise delegates to captureVisualDiffs.
 */
async function runVisualPhase(result, tabContext, includeScreenshots) {
  const skip = reason => ({ status: 'skipped', reason, diffs: new Map() });

  if (!includeScreenshots) {
    logger.info('Visual phase skipped: user disabled screenshots');
    return skip('Visual diff screenshots were disabled for this comparison.');
  }

  return captureVisualDiffs(result, tabContext);
}

/**
 * Strips a full ambiguous match entry down to its identifiers and selector strings.
 * Full element objects are not structured-clone serialisable and would exceed IDB
 * storage limits if stored whole.
 */
function slimAmbiguousEntry(entry) {
  const el = entry.baselineElement;
  return {
    baselineElementId: el?.id           ?? null,
    tagName:           el?.tagName      ?? null,
    elementId:         el?.elementId    ?? null,
    className:         el?.className    ?? null,
    selectors:         el?.selectors    ?? null,
    confidence:        entry.confidence,
    strategy:          entry.strategy,
    candidateCount:    entry.ambiguousCandidates?.length ?? 0
  };
}

/**
 * Saves the comparison result to IDB via the WAL-guarded saveComparison path.
 * Two conversions happen here before writing:
 * 1. visualDiffs Map → plain object: Maps are not reliably structured-clone
 *    serialisable across all Chrome versions and cannot be stored in IDB directly.
 * 2. Full element objects in comparison results → slim selector/ID records: storing
 *    full elements would duplicate everything already held in STORE_ELEMENTS and
 *    would push individual records past the practical IDB value size limit.
 */
async function persistComparison(result, baselineId, compareId, mode) {
  const id      = crypto.randomUUID();
  const pairKey = buildPairKey(baselineId, compareId, mode);

  const serializedDiffs = result.visualDiffs instanceof Map
    ? Object.fromEntries(result.visualDiffs)
    : (result.visualDiffs ?? null);

  const ambiguousEntries = result.comparison.ambiguous ?? [];

  const meta = {
    id,
    pairKey,
    baselineId,
    compareId,
    mode,
    timestamp:         result.timestamp,
    duration:          result.duration,
    baseline:          result.baseline,
    compare:           result.compare,
    matching:          result.matching,
    summary: {
      ...result.comparison.summary,
      severityBreakdown: computeSeverityBreakdown(result.comparison.results)
    },
    unmatchedElements: result.unmatchedElements,
    ambiguous:         ambiguousEntries.map(slimAmbiguousEntry),
    visualDiffs:       serializedDiffs,
    visualDiffStatus:  result.visualDiffStatus  ?? null,
    visualSessionId:   result.visualSessionId   ?? null,
    preFlightWarning:  result.preFlightWarning   ?? null
  };

  const slimResults = result.comparison.results.map(
    ({ baselineElement, compareElement, ...rest }) => ({
      ...rest,
      baselineElementId: baselineElement.id,
      compareElementId:  compareElement?.id   ?? null,
      tagName:           baselineElement.tagName,
      elementId:         baselineElement.elementId,
      className:         baselineElement.className,
      cssSelector:        baselineElement.cssSelector  ?? null,
      xpath:              baselineElement.xpath         ?? null,
      compareCssSelector: compareElement?.cssSelector  ?? null,
      compareXpath:       compareElement?.xpath         ?? null,
      hpid:              baselineElement.hpid          ?? null,
      absoluteHpid:      baselineElement.absoluteHpid  ?? null,
      textContent:       baselineElement.textContent   ?? null,
      depth:             baselineElement.depth         ?? null,
      tier:              baselineElement.tier          ?? null
    })
  );

  const saved = await storage.saveComparison(meta, slimResults);
  if (!saved.success) {
    logger.warn('Failed to persist comparison', { error: saved.error });
  }
}

/**
 * Looks up a stored comparison by report pair and mode.
 * Returns null on any error or a cache miss — callers treat null as "not cached".
 *
 * @param {string} baselineId
 * @param {string} compareId
 * @param {string} mode
 * @returns {Promise<Object|null>}
 */
async function getCachedComparison(baselineId, compareId, mode) {
  if (!baselineId || !compareId) {
    return null;
  }
  try {
    return await storage.loadComparisonByPair(baselineId, compareId, mode);
  } catch (cacheErr) {
    logger.warn('Failed to load cached comparison', { error: cacheErr.message });
    return null;
  }
}

/**
 * Reconstructs the full comparison object from two separate IDB reads (meta + diffs)
 * and passes it to the HTML exporter. Meta and diffs are stored separately so list
 * reads stay cheap — the full object only needs to be assembled at export time.
 *
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function exportComparisonAsHTML(baselineId, compareId, mode) {
  const meta = await getCachedComparison(baselineId, compareId, mode);
  if (!meta) {
    return { success: false, error: 'No stored comparison found for these reports. Run the comparison first.' };
  }

  const slimResults = await storage.loadComparisonDiffs(meta.id);

  const reconstructed = {
    baseline:          meta.baseline,
    compare:           meta.compare,
    mode:              meta.mode,
    matching:          meta.matching,
    timestamp:         meta.timestamp,
    duration:          meta.duration,
    unmatchedElements: meta.unmatchedElements,
    comparison: {
      summary:   meta.summary,
      results:   slimResults,
      ambiguous: meta.ambiguous ?? []
    },
    visualDiffs:      meta.visualDiffs      ?? null,
    visualDiffStatus: meta.visualDiffStatus ?? null,
    preFlightWarning: meta.preFlightWarning ?? null
  };

  return exportToHTML(reconstructed);
}

export { compareReports, getCachedComparison, exportComparisonAsHTML, PreFlightError, CompatibilityError, parseVersion, versionAtLeast };
import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/storage.js';
import { getReportById } from './report-manager.js';
import { Comparator } from '../core/comparison/comparator.js';
import { buildPairKey } from '../infrastructure/idb-repository.js';
import { runVisualDiffWorkflow } from './visual-workflow.js';
import { diffBlobs } from '../core/comparison/pixel-differ.js';
import { elementLabel } from '../core/export/report-transformer.js';
import { exportToHTML } from '../core/export/html-exporter.js';
import { assessUrlCompatibility } from '../shared/url-utils.js';

const MINIMUM_SCHEMA_VERSION = '3.0';

class PreFlightError extends Error {
  constructor(code, compatResult) {
    super(`Pre-flight check failed: ${code}`);
    this.name         = 'PreFlightError';
    this.code         = code;
    this.compatResult = compatResult;
  }
}

class CompatibilityError extends Error {
  constructor(baselineVersion, compareVersion) {
    super(
      `Report schema version too old: baseline=${baselineVersion ?? 'unknown'}, ` +
      `compare=${compareVersion ?? 'unknown'}. ` +
      `Both reports must be schema version >= ${MINIMUM_SCHEMA_VERSION}. ` +
      `Recapture both reports.`
    );
    this.name            = 'CompatibilityError';
    this.baselineVersion = baselineVersion;
    this.compareVersion  = compareVersion;
  }
}

function parseVersion(versionStr) {
  const parts = (versionStr ?? '0.0').split('.');
  return {
    major: parseInt(parts[0], 10) || 0,
    minor: parseInt(parts[1], 10) || 0
  };
}

function versionAtLeast(versionStr, minStr) {
  const subject = parseVersion(versionStr);
  const minimum = parseVersion(minStr);
  if (subject.major !== minimum.major) {
    return subject.major > minimum.major;
  }
  return subject.minor >= minimum.minor;
}

function assertVersionCompatibility(baselineVersion, compareVersion) {
  const baselineSufficient = versionAtLeast(baselineVersion, MINIMUM_SCHEMA_VERSION);
  const compareSufficient  = versionAtLeast(compareVersion,  MINIMUM_SCHEMA_VERSION);
  if (!baselineSufficient || !compareSufficient) {
    throw new CompatibilityError(baselineVersion, compareVersion);
  }
}

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
    result.visualDiffs = visualResult.diffs;
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

async function runVisualPhase(result, tabContext, includeScreenshots) {
  const skip = reason => ({ status: 'skipped', reason, diffs: new Map() });

  if (!includeScreenshots) {
    logger.info('Visual phase skipped: user disabled screenshots');
    return skip('Visual diff screenshots were disabled for this comparison.');
  }

  const { baselineTabId, compareTabId } = tabContext ?? {};

  if (!Number.isInteger(baselineTabId) || !Number.isInteger(compareTabId)) {
    logger.info('Visual phase skipped: tabContext not provided', { baselineTabId, compareTabId });
    return skip('Source tabs must be open to capture visual diffs.');
  }

  const allModified = result.comparison.results.filter(m => (m.totalDifferences ?? 0) > 0);

  const modifiedElements = allModified
    .slice()
    .sort((a, b) => {
      const sa = a.severityCounts ?? {};
      const sb = b.severityCounts ?? {};
      if ((sb.critical ?? 0) !== (sa.critical ?? 0)) { return (sb.critical ?? 0) - (sa.critical ?? 0); }
      if ((sb.high    ?? 0) !== (sa.high    ?? 0)) { return (sb.high    ?? 0) - (sa.high    ?? 0); }
      if ((sb.medium  ?? 0) !== (sa.medium  ?? 0)) { return (sb.medium  ?? 0) - (sa.medium  ?? 0); }
      if ((sb.low     ?? 0) !== (sa.low     ?? 0)) { return (sb.low     ?? 0) - (sa.low     ?? 0); }
      return (b.totalDifferences ?? 0) - (a.totalDifferences ?? 0);
    })
    .slice(0, 100)
    .map(m => ({ ...m.baselineElement, elementKey: elementLabel(m.baselineElement) }));

  if (modifiedElements.length === 0) {
    logger.info('Visual phase skipped: no modified elements');
    return skip('No modified elements were found that require visual capture.');
  }

  logger.info('Visual phase: element selection complete', {
    total:    allModified.length,
    selected: modifiedElements.length,
    capped:   allModified.length > 100
  });

  try {
    return await runVisualDiffWorkflow({ modifiedElements, baselineTabId, compareTabId, pixelDiffer: diffBlobs });
  } catch (visualErr) {
    logger.error('runVisualDiffWorkflow threw unexpectedly', { error: visualErr.message });
    return { status: 'error', reason: `Unexpected visual diff error: ${visualErr.message}`, diffs: new Map() };
  }
}

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
    summary:           result.comparison.summary,
    unmatchedElements: result.unmatchedElements,
    ambiguous:         ambiguousEntries.map(slimAmbiguousEntry),
    visualDiffs:       serializedDiffs,
    visualDiffStatus:  result.visualDiffStatus  ?? null,
    preFlightWarning:  result.preFlightWarning   ?? null
  };

  const slimResults = result.comparison.results.map(
    ({ baselineElement, compareElement, ...rest }) => ({
      ...rest,
      baselineElementId: baselineElement.id,
      compareElementId:  compareElement?.id ?? null,
      tagName:           baselineElement.tagName,
      elementId:         baselineElement.elementId,
      className:         baselineElement.className,
      selectors:         baselineElement.selectors
    })
  );

  const saved = await storage.saveComparison(meta, slimResults);
  if (!saved.success) {
    logger.warn('Failed to persist comparison', { error: saved.error });
  }
}

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

export { compareReports, getCachedComparison, exportComparisonAsHTML, PreFlightError, CompatibilityError };
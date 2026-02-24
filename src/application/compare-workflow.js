import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/storage.js';
import { getReportById } from './report-manager.js';
import { Comparator } from '../core/comparison/comparator.js';
import { buildPairKey } from '../infrastructure/idb-repository.js';
import { runVisualDiffWorkflow } from './visual-workflow.js';
import { diffBlobs } from '../core/comparison/pixel-differ.js';
import { elementLabel } from '../core/export/report-transformer.js';
import { exportToHTML } from '../core/export/html-exporter.js';

async function compareReports(options = {}) {
  const {
    baselineId,
    compareId,
    mode = 'static',
    tabContext = null,
    includeScreenshots = true,
    onProgress = null
  } = options;

  logger.info('Starting comparison', { baselineId, compareId, mode });

  try {
    const [baseline, compare] = await Promise.all([
      getReportById(baselineId),
      getReportById(compareId)
    ]);

    if (!baseline || !compare) {
      throw new Error('One or both reports not found');
    }
    if (!Array.isArray(baseline.elements)) {
      throw new Error('Baseline report missing elements array');
    }
    if (!Array.isArray(compare.elements)) {
      throw new Error('Compare report missing elements array');
    }

    const comparator = new Comparator({ onProgress });
    const result = await comparator.compare(baseline, compare, mode);

    logger.info('Comparison completed', {
      matched:     result.matching.totalMatched,
      differences: result.comparison.summary.totalDifferences,
      duration:    result.duration
    });

    const visualResult = await runVisualPhase(result, tabContext, includeScreenshots);
    result.visualDiffs = visualResult.diffs;
    if (includeScreenshots) {
      result.visualDiffStatus = { status: visualResult.status, reason: visualResult.reason };
    }

    await persistComparison(result, baselineId, compareId, mode);

    return result;
  } catch (error) {
    const errorMsg = error?.message || (typeof error === 'string' ? error : null) || String(error) || 'Unknown error';
    logger.error('Compare workflow failed', { error: errorMsg, stack: error.stack });
    throw new Error(errorMsg);
  }
}

async function runVisualPhase(result, tabContext, includeScreenshots) {
  const skip = (reason) => ({ status: 'skipped', reason, diffs: new Map() });

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
      const sc = a.severityCounts ?? {};
      const sd = b.severityCounts ?? {};
      if ((sd.critical ?? 0) !== (sc.critical ?? 0)) { return (sd.critical ?? 0) - (sc.critical ?? 0); }
      if ((sd.high ?? 0) !== (sc.high ?? 0))         { return (sd.high ?? 0) - (sc.high ?? 0); }
      if ((sd.medium ?? 0) !== (sc.medium ?? 0))     { return (sd.medium ?? 0) - (sc.medium ?? 0); }
      if ((sd.low ?? 0) !== (sc.low ?? 0))           { return (sd.low ?? 0) - (sc.low ?? 0); }
      return (b.totalDifferences ?? 0) - (a.totalDifferences ?? 0);
    })
    .slice(0, 100)
    .map(m => ({
      ...m.baselineElement,
      elementKey: elementLabel(m.baselineElement)
    }));

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
    const diffResult = await runVisualDiffWorkflow({
      modifiedElements,
      baselineTabId,
      compareTabId,
      pixelDiffer: diffBlobs
    });
    return diffResult;
  } catch (err) {
    logger.error('runVisualDiffWorkflow threw unexpectedly', { error: err.message });
    return { status: 'error', reason: `Unexpected visual diff error: ${err.message}`, diffs: new Map() };
  }
}

async function persistComparison(result, baselineId, compareId, mode) {
  const id = crypto.randomUUID();
  const pairKey = buildPairKey(baselineId, compareId, mode);

  const serializedDiffs = result.visualDiffs instanceof Map
    ? Object.fromEntries(result.visualDiffs)
    : (result.visualDiffs ?? null);

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
    visualDiffs:       serializedDiffs,
    visualDiffStatus:  result.visualDiffStatus ?? null
  };

  const slimResults = result.comparison.results.map(
    ({ baselineElement, compareElement, ...rest }) => ({
      ...rest,
      baselineElementId: baselineElement.id,
      compareElementId:  compareElement.id,
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
    const comparison = await storage.loadComparisonByPair(baselineId, compareId, mode);
    return comparison;
  } catch (error) {
    logger.warn('Failed to load cached comparison', { error: error.message });
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
      summary: meta.summary,
      results: slimResults
    },
    visualDiffs:      meta.visualDiffs      ?? null,
    visualDiffStatus: meta.visualDiffStatus ?? null
  };

  return exportToHTML(reconstructed);
}

export { compareReports, getCachedComparison, exportComparisonAsHTML };
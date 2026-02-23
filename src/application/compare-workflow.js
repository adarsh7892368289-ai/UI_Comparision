import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/storage.js';
import { getReportById } from './report-manager.js';
import { Comparator } from '../core/comparison/comparator.js';
import { buildPairKey } from '../infrastructure/idb-repository.js';
import { runVisualDiffWorkflow } from './visual-workflow.js';
import { diffBlobs } from '../core/comparison/pixel-differ.js';
import { elementLabel } from '../core/export/report-transformer.js';
import { exportToHTML } from '../core/export/html-exporter.js';

/**
 * @param {string} baselineId
 * @param {string} compareId
 * @param {string} [mode='static']
 * @param {{ baselineTabId: number, compareTabId: number } | null} [tabContext=null]
 *   Pass the live tab IDs to enable visual pixel diffing. If null or if either
 *   tab ID is missing/invalid the visual phase is gracefully skipped.
 * @param {boolean} [includeScreenshots=true]
 *   When false, the CDP visual capture phase is bypassed entirely for instant comparison.
 */
async function compareReports(baselineId, compareId, mode = 'static', tabContext = null, includeScreenshots = true) {
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

    const comparator = new Comparator();
    const result     = await comparator.compare(baseline, compare, mode);

    logger.info('Comparison completed', {
      matched:     result.matching.totalMatched,
      differences: result.comparison.summary.totalDifferences,
      duration:    result.duration
    });

    // ── Visual diff phase ────────────────────────────────────────────────────
    // Must run BEFORE _persistComparison so that result.comparison.results
    // still has the full baselineElement objects (persistence strips them to IDs).
    // Visual phase returns { status, reason, diffs }.
    // visualDiffStatus is always set when visual capture was requested so the
    // report banner accurately reflects skip/error/success state.
    const visualResult = await _runVisualPhase(result, tabContext, includeScreenshots);
    result.visualDiffs = visualResult.diffs;
    if (includeScreenshots) {
      result.visualDiffStatus = { status: visualResult.status, reason: visualResult.reason };
    }
    // ────────────────────────────────────────────────────────────────────────

    await _persistComparison(result, baselineId, compareId, mode);

    return result;
  } catch (error) {
    const errorMsg = error?.message || (typeof error === 'string' ? error : null) || String(error) || 'Unknown error';
    logger.error('Compare workflow failed', { error: errorMsg, stack: error.stack });
    throw new Error(errorMsg);
  }
}

/**
 * Adapter between compareReports and runVisualDiffWorkflow.
 * Always returns a VisualDiffResult { status, reason, diffs } — never throws.
 *
 * Element selection strategy:
 *   1. Filter to modified elements only (totalDifferences > 0)
 *   2. Sort by severity descending: critical → high → medium → low
 *      Within same severity level, sort by raw diff count so the most
 *      impactful elements within a tier are always captured first.
 *   3. Cap at 100 to prevent Chrome IPC message-length overflow and
 *      IndexedDB QuotaExceededError on large reports.
 *
 * @param {object}  result              Output of comparator.compare()
 * @param {{ baselineTabId: number, compareTabId: number } | null} tabContext
 * @param {boolean} includeScreenshots  When false, bypass CDP capture entirely.
 * @returns {Promise<{ status: string, reason: string, diffs: Map }>}
 */
async function _runVisualPhase(result, tabContext, includeScreenshots) {
  const SKIP = (reason) => ({ status: 'skipped', reason, diffs: new Map() });

  // Hard bypass — user unchecked the toggle. Instant return, zero CDP overhead.
  if (!includeScreenshots) {
    logger.info('Visual phase skipped: user disabled screenshots');
    return SKIP('Visual diff screenshots were disabled for this comparison.');
  }

  const { baselineTabId, compareTabId } = tabContext ?? {};

  if (!Number.isInteger(baselineTabId) || !Number.isInteger(compareTabId)) {
    logger.info('Visual phase skipped: tabContext not provided or incomplete', {
      baselineTabId,
      compareTabId
    });
    return SKIP('Source tabs must be open to capture visual diffs.');
  }

  // ── Build severity-sorted, capped element list ───────────────────────────
  // Sort critical→high→medium→low, then by raw diff count within each tier.
  // Slice at 100 to prevent IPC overflow and IndexedDB quota errors.
  const allModified = result.comparison.results.filter(m => (m.totalDifferences ?? 0) > 0);

  const modifiedElements = allModified
    .slice()
    .sort((a, b) => {
      const sc = a.severityCounts ?? {};
      const sd = b.severityCounts ?? {};
      if ((sd.critical ?? 0) !== (sc.critical ?? 0)) {return (sd.critical ?? 0) - (sc.critical ?? 0);}
      if ((sd.high     ?? 0) !== (sc.high     ?? 0)) {return (sd.high     ?? 0) - (sc.high     ?? 0);}
      if ((sd.medium   ?? 0) !== (sc.medium   ?? 0)) {return (sd.medium   ?? 0) - (sc.medium   ?? 0);}
      if ((sd.low      ?? 0) !== (sc.low      ?? 0)) {return (sd.low      ?? 0) - (sc.low      ?? 0);}
      return (b.totalDifferences ?? 0) - (a.totalDifferences ?? 0);
    })
    .slice(0, 100)
    .map(m => ({
      ...m.baselineElement,
      // elementKey is a display-only label for the HTML report sidebar.
      // The visualDiffs Map and DIFF_URIS lookup both use el.id ("el-NNN"),
      // the stable DB record ID that is guaranteed unique across the report.
      elementKey: elementLabel(m.baselineElement)
    }));

  if (modifiedElements.length === 0) {
    logger.info('Visual phase skipped: no modified elements');
    return SKIP('No modified elements were found that require visual capture.');
  }

  logger.info('Visual phase: element selection complete', {
    total:    allModified.length,
    selected: modifiedElements.length,
    capped:   allModified.length > 100
  });

  try {
    return await runVisualDiffWorkflow({
      modifiedElements,
      baselineTabId,
      compareTabId,
      pixelDiffer: diffBlobs
    });
  } catch (err) {
    logger.error('runVisualDiffWorkflow threw unexpectedly', { error: err.message });
    return {
      status: 'error',
      reason: `Unexpected visual diff error: ${err.message}`,
      diffs:  new Map()
    };
  }
}

async function _persistComparison(result, baselineId, compareId, mode) {
  const id      = crypto.randomUUID();
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
      // Identity fields kept so report-transformer can reconstruct element labels
      // when full baselineElement objects are unavailable (export-from-storage path).
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
  if (!baselineId || !compareId) {return null;}
  try {
    return await storage.loadComparisonByPair(baselineId, compareId, mode);
  } catch (error) {
    logger.warn('Failed to load cached comparison', { error: error.message });
    return null;
  }
}

/**
 * Loads a stored comparison from IndexedDB and triggers an HTML download.
 * Always runs in the Service Worker — zero IPC payload, no data-URI size risk.
 *
 * The stored meta object carries `visualDiffs` as a plain object (serialized from
 * the original Map by _persistComparison). The stored slimResults carry the full
 * property-diff data plus element identity fields. Together they are sufficient
 * to reconstruct the comparisonResult shape expected by exportToHTML.
 *
 * @param {string} baselineId
 * @param {string} compareId
 * @param {string} mode
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function exportComparisonAsHTML(baselineId, compareId, mode) {

  const meta = await getCachedComparison(baselineId, compareId, mode);
  if (!meta) {
    return { success: false, error: 'No stored comparison found for these reports. Run the comparison first.' };
  }

  const slimResults = await storage.loadComparisonDiffs(meta.id);

  // Reconstruct a comparisonResult object compatible with exportToHTML.
  // report-transformer.transformToGroupedReport handles slim results gracefully:
  //   match.baselineElement falls back to { id: baselineElementId, tagName, elementId, className, selectors }
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
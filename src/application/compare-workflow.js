import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/storage.js';
import { getReportById } from './report-manager.js';
import { Comparator } from '../core/comparison/comparator.js';
import { buildPairKey } from '../infrastructure/idb-repository.js';

async function compareReports(baselineId, compareId, mode = 'static') {
  logger.info('Starting comparison', { baselineId, compareId, mode });

  try {
    const [baseline, compare] = await Promise.all([
      getReportById(baselineId),
      getReportById(compareId),
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
      duration:    result.duration,
    });

    await _persistComparison(result, baselineId, compareId, mode);

    return result;
  } catch (error) {
    const errorMsg = error.message || String(error);
    logger.error('Compare workflow failed', { error: errorMsg, stack: error.stack });
    throw new Error(errorMsg);
  }
}

async function _persistComparison(result, baselineId, compareId, mode) {
  const id      = crypto.randomUUID();
  const pairKey = buildPairKey(baselineId, compareId, mode);

  const meta = {
    id,
    pairKey,
    baselineId,
    compareId,
    mode,
    timestamp:        result.timestamp,
    duration:         result.duration,
    baseline:         result.baseline,
    compare:          result.compare,
    matching:         result.matching,
    summary:          result.comparison.summary,
    unmatchedElements: result.unmatchedElements,
  };

  const slimResults = result.comparison.results.map(
    ({ baselineElement, compareElement, ...rest }) => ({
      ...rest,
      baselineElementId: baselineElement.id,
      compareElementId:  compareElement.id,
    })
  );

  storage.saveComparison(meta, slimResults)
    .then(saved => {
      if (!saved.success) {
        logger.warn('Failed to persist comparison', { error: saved.error });
      }
    })
    .catch(err => {
      logger.warn('Failed to persist comparison', { error: err.message });
    });
}

async function getCachedComparison(baselineId, compareId, mode) {
  if (!baselineId || !compareId) return null;
  try {
    return await storage.loadComparisonByPair(baselineId, compareId, mode);
  } catch (error) {
    logger.warn('Failed to load cached comparison', { error: error.message });
    return null;
  }
}

export { compareReports, getCachedComparison };
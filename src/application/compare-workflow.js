import logger from '../infrastructure/logger.js';
import { getReportById } from './report-manager.js';
import { Comparator } from '../core/comparison/comparator.js';

async function compareReports(baselineId, compareId, mode = 'static') {
  logger.info('Starting comparison', { baselineId, compareId, mode });

  try {
    const baseline = await getReportById(baselineId);
    const compare = await getReportById(compareId);

    if (!baseline || !compare) {
      throw new Error('One or both reports not found');
    }

    if (!baseline.elements || !Array.isArray(baseline.elements)) {
      throw new Error('Baseline report missing elements array');
    }

    if (!compare.elements || !Array.isArray(compare.elements)) {
      throw new Error('Compare report missing elements array');
    }

    const comparator = new Comparator();
    const result = await comparator.compare(baseline, compare, mode);

    logger.info('Comparison completed', {
      matched: result.matching.totalMatched,
      differences: result.comparison.summary.totalDifferences,
      duration: result.duration
    });

    return result;
  } catch (error) {
    const errorMsg = error.message || String(error);
    logger.error('Compare workflow failed', { error: errorMsg, stack: error.stack });
    throw new Error(errorMsg);
  }
}

export { compareReports };
import { validateConfig } from '../config/validator.js';
import { MessageTypes, onMessage } from '../infrastructure/chrome-messaging.js';
import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/storage.js';
import { compareReports, exportComparisonAsHTML, getCachedComparison } from './compare-workflow.js';
import { extractFromActiveTab } from './extract-workflow.js';

logger.init();

try {
  validateConfig({ throwOnError: true });
  logger.info('Config validation passed');
} catch (err) {
  logger.error('STARTUP FAILED: Config validation error', { error: err.message });
  throw err;
}

storage.init();

const handlers = {
  [MessageTypes.EXTRACT_ELEMENTS]:       handleExtractElements,
  [MessageTypes.LOAD_CACHED_COMPARISON]: handleLoadCachedComparison,
  [MessageTypes.EXPORT_COMPARISON_HTML]: handleExportComparisonHTML,
  [MessageTypes.SAVE_REPORT]:            handleSaveReport,
  [MessageTypes.LOAD_REPORTS]:           handleLoadReports,
  [MessageTypes.DELETE_REPORT]:          handleDeleteReport
};

onMessage(async (type, payload, sender) => {
  const handler = handlers[type];
  if (!handler) {
    logger.warn('Unknown message type', { type });
    throw new Error(`Unknown message type: ${type}`);
  }
  return handler(payload, sender);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'comparison') {
    return;
  }

  let aborted = false;

  port.onDisconnect.addListener(() => {
    aborted = true;
    logger.info('Comparison port disconnected — client closed');
  });

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== MessageTypes.START_COMPARISON) {
      return;
    }

    const { baselineId, compareId, mode, baselineTabId, compareTabId, includeScreenshots } = msg;
    logger.info('Comparison port connected', { baselineId, compareId, mode });

    const send = (type, data = {}) => {
      if (aborted) {
        return;
      }
      try {
        port.postMessage({ type, ...data });
      } catch {
        aborted = true;
      }
    };

    try {
      send(MessageTypes.COMPARISON_PROGRESS, { label: 'Loading reports…', pct: 5 });

      const tabContext = (Number.isInteger(baselineTabId) && Number.isInteger(compareTabId))
        ? { baselineTabId, compareTabId }
        : null;

      const onProgress = (label, pct) => send(MessageTypes.COMPARISON_PROGRESS, { label, pct });

      const result = await compareReports({
        baselineId,
        compareId,
        mode,
        tabContext,
        includeScreenshots: includeScreenshots ?? true,
        onProgress
      });

      const { visualDiffs, ...slim } = result;
      slim.hasVisualDiffs = (visualDiffs instanceof Map)
        ? visualDiffs.size > 0
        : Object.keys(visualDiffs ?? {}).length > 0;

      send(MessageTypes.COMPARISON_COMPLETE, { result: slim });
      logger.info('Comparison complete via port', { baselineId, compareId });

    } catch (error) {
      const errorMsg = error?.message || String(error) || 'Unknown error';
      logger.error('Comparison failed via port', { error: errorMsg });
      send(MessageTypes.COMPARISON_ERROR, { error: errorMsg });
    }
  });
});

async function handleExtractElements(payload) {
  const { filters } = payload;
  logger.info('Extract elements requested', { filters });
  const report = await extractFromActiveTab(filters);
  return { report };
}

async function handleExportComparisonHTML(payload) {
  const { baselineId, compareId, mode } = payload;
  let exportResult;
  try {
    exportResult = await exportComparisonAsHTML(baselineId, compareId, mode);
  } catch (err) {
    const msg = (err instanceof Error ? err.message : null) || String(err) || 'Unknown export error';
    logger.error('handleExportComparisonHTML: unexpected throw', { error: msg });
    throw new Error(msg);
  }
  if (!exportResult.success) {
    const msg = exportResult.error || 'HTML export failed';
    logger.error('handleExportComparisonHTML failed', { error: msg });
    throw new Error(msg);
  }
  logger.info('handleExportComparisonHTML: download triggered');
  return { success: true };
}

async function handleSaveReport(payload) {
  const { report } = payload;
  return storage.saveReport(report);
}

async function handleLoadReports() {
  const reports = await storage.loadReports();
  return { reports };
}

async function handleDeleteReport(payload) {
  const { id } = payload;
  return storage.deleteReport(id);
}

async function handleLoadCachedComparison(payload) {
  const { baselineId, compareId, mode } = payload;
  const cached = await getCachedComparison(baselineId, compareId, mode);
  return { cached };
}

logger.info('Background service worker initialized');
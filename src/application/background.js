import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/storage.js';
import { get } from '../config/defaults.js';
import { validateConfig } from '../config/validator.js';
import { MessageTypes, onMessage } from '../infrastructure/chrome-messaging.js';
import { TabAdapter } from '../infrastructure/chrome-tabs.js';
import { extractFromActiveTab } from './extract-workflow.js';
import { compareReports, getCachedComparison, exportComparisonAsHTML } from './compare-workflow.js';

logger.init();

try {
  validateConfig({ throwOnError: true });
  logger.info('Config validation passed ✓');
} catch (err) {
  logger.error('STARTUP FAILED: Config validation error', { error: err.message });
  throw err;
}

storage.init();

// ─── Short-lived message handlers (sendMessage / one-shot) ────────────────────

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

// ─── Long-running comparison via chrome.runtime.connect() ─────────────────────
//
// WHY NOT sendMessage for START_COMPARISON:
//   chrome.runtime.sendMessage creates a one-shot port that Chrome closes after
//   ~5 minutes regardless of 'return true'. A visual diff run (100 elements ×
//   CDP × 2 tabs in parallel) takes 8–90 seconds. Holding the port reliably is
//   impossible.
//
// WHY chrome.runtime.connect():
//   A persistent port created by connect() keeps the SW alive for its entire
//   lifetime — Chrome will not kill the SW while the port is open. The popup
//   opens the port, the SW runs compareReports(), sends progress messages through
//   the port, and finally sends the result. The popup closes the port when done.
//   No polling. No storage writes. No fire-and-forget races.
//
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'comparison') {return;}

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== MessageTypes.START_COMPARISON) {return;}

    const { baselineId, compareId, mode, baselineTabId, compareTabId, includeScreenshots } = msg;
    logger.info('Comparison port connected', { baselineId, compareId, mode });

    const send = (type, data = {}) => {
      try { port.postMessage({ type, ...data }); } catch (_) {}
    };

    try {
      send(MessageTypes.COMPARISON_PROGRESS, { label: 'Loading reports…',       pct: 5  });

      const tabContext = (Number.isInteger(baselineTabId) && Number.isInteger(compareTabId))
        ? { baselineTabId, compareTabId }
        : null;

      send(MessageTypes.COMPARISON_PROGRESS, { label: 'Matching elements…',     pct: 15 });

      const result = await compareReports(
        baselineId, compareId, mode, tabContext, includeScreenshots ?? true,
        (label, pct) => send(MessageTypes.COMPARISON_PROGRESS, { label, pct })
      );

      // Strip visualDiffs from the port message — data URIs are large and already
      // in IndexedDB. Popup loads via LOAD_CACHED_COMPARISON immediately after.
      const { visualDiffs: _dropped, ...slim } = result;
      slim.hasVisualDiffs = (result.visualDiffs instanceof Map)
        ? result.visualDiffs.size > 0
        : Object.keys(result.visualDiffs ?? {}).length > 0;

      send(MessageTypes.COMPARISON_COMPLETE, { result: slim });
      logger.info('Comparison complete via port', { baselineId, compareId });

    } catch (error) {
      const errorMsg = error?.message || String(error) || 'Unknown error';
      logger.error('Comparison failed via port', { error: errorMsg });
      send('comparisonError', { error: errorMsg });
    }
  });
});

async function handleExtractElements(payload, sender) {
  try {
    const { filters } = payload;
    logger.info('Extract elements requested', { filters });
    const report = await extractFromActiveTab(filters);
    return { report };
  } catch (error) {
    const errorMsg = error?.message || String(error) || 'Unknown error';
    logger.error('handleExtractElements failed', { error: errorMsg });
    throw new Error(errorMsg);
  }
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
  try {
    const { report } = payload;
    return await storage.saveReport(report);
  } catch (error) {
    const errorMsg = error?.message || String(error) || 'Unknown error';
    logger.error('handleSaveReport failed', { error: errorMsg });
    throw new Error(errorMsg);
  }
}

async function handleLoadReports() {
  try {
    const reports = await storage.loadReports();
    return { reports };
  } catch (error) {
    const errorMsg = error?.message || String(error) || 'Unknown error';
    logger.error('handleLoadReports failed', { error: errorMsg });
    throw new Error(errorMsg);
  }
}

async function handleDeleteReport(payload) {
  try {
    const { id } = payload;
    return await storage.deleteReport(id);
  } catch (error) {
    const errorMsg = error?.message || String(error) || 'Unknown error';
    logger.error('handleDeleteReport failed', { error: errorMsg });
    throw new Error(errorMsg);
  }
}

async function handleLoadCachedComparison(payload) {
  try {
    const { baselineId, compareId, mode } = payload;
    const cached = await getCachedComparison(baselineId, compareId, mode);
    return { cached };
  } catch (error) {
    const errorMsg = error?.message || String(error) || 'Unknown error';
    logger.error('handleLoadCachedComparison failed', { error: errorMsg });
    throw new Error(errorMsg);
  }
}

logger.info('Background service worker initialized');
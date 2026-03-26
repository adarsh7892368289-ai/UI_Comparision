import { validateConfig } from '../config/validator.js';
import { MessageTypes, onMessage } from '../infrastructure/chrome-messaging.js';
import logger, { StorageTransport } from '../infrastructure/logger.js';
import storage from '../infrastructure/idb-repository.js';
import { compareReports, exportComparisonAsHTML, getCachedComparison } from './compare-workflow.js';
import { extractFromActiveTab } from './extract-workflow.js';

logger.init();
logger.addTransport(new StorageTransport());

try {
  validateConfig({ throwOnError: true });
  logger.info('Config validation passed');
} catch (err) {
  logger.error('STARTUP FAILED: Config validation error', { error: err.message });
  throw err;
}

const handlers = {
  [MessageTypes.EXTRACT_ELEMENTS]:       handleExtractElements,
  [MessageTypes.LOAD_CACHED_COMPARISON]: handleLoadCachedComparison,
  [MessageTypes.EXPORT_COMPARISON_HTML]: handleExportComparisonHTML,
  [MessageTypes.SAVE_REPORT]:            handleSaveReport,
  [MessageTypes.LOAD_REPORTS]:           handleLoadReports,
  [MessageTypes.DELETE_REPORT]:          handleDeleteReport,
  [MessageTypes.GET_VISUAL_BLOB]:        handleGetVisualBlob
};

onMessage(async (msgType, payload, sender) => {
  const handler = handlers[msgType];
  if (!handler) {
    logger.warn('Unknown message type', { msgType });
    throw new Error(`Unknown message type: ${msgType}`);
  }
  return handler(payload, sender);
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith('/blob/')) { return; }
  const blobId = url.pathname.slice(6);
  event.respondWith(
    storage.loadVisualBlob(blobId).then(blob => {
      if (!blob) { return new Response('Not found', { status: 404 }); }
      return new Response(blob, {
        headers: {
          'Content-Type':  blob.type || 'image/webp',
          'Cache-Control': 'private, max-age=3600'
        }
      });
    }).catch(() => new Response('Internal error', { status: 500 }))
  );
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

    const send = (msgType, data = {}) => {
      if (aborted) {
        return;
      }
      try {
        port.postMessage({ type: msgType, ...data });
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
      try {
        await chrome.storage.session.set({ pendingComparison: { baselineId, compareId, mode, timestamp: Date.now() } });
        await chrome.action.openPopup();
      } catch {}
      logger.info('Comparison complete via port', { baselineId, compareId });

    } catch (error) {
      const errorMsg = error?.message || String(error) || 'Unknown error';
      logger.error('Comparison failed via port', { error: errorMsg });
      send(MessageTypes.COMPARISON_ERROR, { error: errorMsg });
      try { await chrome.action.openPopup(); } catch {}
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
  if (!cached) { return { cached: null }; }
  const results = await storage.loadComparisonDiffs(cached.id);
  return { cached: { ...cached, results } };
}

async function handleGetVisualBlob(payload) {
  const { blobId } = payload;
  const blob = await storage.loadVisualBlob(blobId);
  if (!blob) { return { dataUri: null }; }
  const buf     = await blob.arrayBuffer();
  const bytes   = new Uint8Array(buf);
  const chunk   = 0x8000;
  let binary    = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return { dataUri: `data:${blob.type || 'image/webp'};base64,${btoa(binary)}` };
}

logger.info('Background service worker initialized');


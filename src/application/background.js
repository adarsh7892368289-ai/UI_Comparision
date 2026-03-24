/**
 * MV3 service worker entry point. Owns message dispatch, port-based comparison
 * streaming, and the SW fetch handler that serves visual blobs from IDB.
 * Failure mode contained here: a broken config reaching handler registration —
 * prevented by the top-level validateConfig() throw that halts SW startup.
 * Callers: Chrome runtime (message, connect, fetch events). Not imported by any module.
 */
import { validateConfig } from '../config/validator.js';
import { MessageTypes, onMessage } from '../infrastructure/chrome-messaging.js';
import logger, { StorageTransport } from '../infrastructure/logger.js';
import storage from '../infrastructure/idb-repository.js';
import { compareReports, exportComparisonAsHTML, getCachedComparison } from './compare-workflow.js';
import { extractFromActiveTab } from './extract-workflow.js';

logger.init();
logger.addTransport(new StorageTransport());

// Intentional top-level throw — a bad config must halt the SW before any handler
// is registered. Silent continuation would cause cryptic per-request failures later.
try {
  validateConfig({ throwOnError: true });
  logger.info('Config validation passed');
} catch (err) {
  logger.error('STARTUP FAILED: Config validation error', { error: err.message });
  throw err;
}

// Dispatch table for sendMessage-based requests. START_COMPARISON is intentionally
// absent — it streams N progress frames over time and uses the onConnect port instead.
const handlers = {
  [MessageTypes.EXTRACT_ELEMENTS]:       handleExtractElements,
  [MessageTypes.LOAD_CACHED_COMPARISON]: handleLoadCachedComparison,
  [MessageTypes.EXPORT_COMPARISON_HTML]: handleExportComparisonHTML,
  [MessageTypes.SAVE_REPORT]:            handleSaveReport,
  [MessageTypes.LOAD_REPORTS]:           handleLoadReports,
  [MessageTypes.DELETE_REPORT]:          handleDeleteReport,
  [MessageTypes.GET_VISUAL_BLOB]:        handleGetVisualBlob
};

// Unknown message types throw — the error propagates back as {success:false} via
// chrome-messaging.js's onMessage wrapper, not as an unhandled SW rejection.
onMessage(async (msgType, payload, sender) => {
  const handler = handlers[msgType];
  if (!handler) {
    logger.warn('Unknown message type', { msgType });
    throw new Error(`Unknown message type: ${msgType}`);
  }
  return handler(payload, sender);
});

// SW fetch interceptor: serves visual blobs stored in IDB under the virtual
// /blob/{id} path. This avoids a server round-trip — the SW is its own blob server.
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

// Port-based comparison channel. sendMessage is single-shot and cannot stream
// progress across the N frames a comparison takes — a persistent port is required.
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

    // send() is a no-op once aborted. postMessage throws synchronously when Chrome
    // has already closed the port on the other side — catching it here prevents an
    // unhandled rejection if onDisconnect fires slightly after a send is attempted.
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

      // visualDiffs is a Map of large blob data — not serialisable over the message
      // channel. Strip it and send a boolean flag instead; the popup fetches blobs
      // individually via handleGetVisualBlob when it needs them.
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

/** Triggers a DOM extraction on the active tab and returns the report. */
async function handleExtractElements(payload) {
  const { filters } = payload;
  logger.info('Extract elements requested', { filters });
  const report = await extractFromActiveTab(filters);
  return { report };
}

/**
 * Normalises both thrown errors and {success:false} returns from exportComparisonAsHTML
 * into thrown errors — the function can surface failures either way, and the message
 * boundary expects a single error contract.
 */
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

/** Persists a report to IDB via the serialised write queue. */
async function handleSaveReport(payload) {
  const { report } = payload;
  return storage.saveReport(report);
}

/** Returns all saved reports newest-first, wrapped in an object for the message envelope. */
async function handleLoadReports() {
  const reports = await storage.loadReports();
  return { reports };
}

/** Deletes a report and all comparisons referencing it atomically. */
async function handleDeleteReport(payload) {
  const { id } = payload;
  return storage.deleteReport(id);
}

/**
 * Loads a cached comparison and its diff results in two separate reads.
 * Diffs are stored in a separate IDB store from the comparison metadata,
 * so both must be fetched and merged before returning.
 */
async function handleLoadCachedComparison(payload) {
  const { baselineId, compareId, mode } = payload;
  const cached = await getCachedComparison(baselineId, compareId, mode);
  if (!cached) { return { cached: null }; }
  const results = await storage.loadComparisonDiffs(cached.id);
  return { cached: { ...cached, results } };
}

/**
 * Converts a stored blob to a base64 data URI for transfer over the message channel.
 * Blobs cannot be sent directly across Chrome message boundaries — they must be
 * serialised. The array is chunked at 0x8000 bytes before String.fromCharCode to
 * avoid a call stack overflow when spreading large Uint8Arrays as function arguments.
 */
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
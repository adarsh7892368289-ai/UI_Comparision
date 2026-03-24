/**
 * Messaging bridge between the extension's three contexts: popup, content script,
 * and background service worker. Imported by all three.
 * Failure mode contained here: the Chrome message channel staying open indefinitely
 * when a response is never sent — prevented by the timeout in sendToBackground and
 * the `return true` contract in onMessage.
 * Callers: background.js (onMessage), popup.js, content.js (sendToBackground),
 *          compare-workflow.js (sendToTab).
 */
import logger from './logger.js';
import { TabAdapter } from './chrome-tabs.js';

/** Frozen enum of every message type string used across the extension. */
export const MessageTypes = Object.freeze({
  EXTRACT_ELEMENTS:       'extractElements',
  EXTRACTION_PROGRESS:    'extractionProgress',
  EXTRACTION_COMPLETE:    'extractionComplete',

  START_COMPARISON:       'startComparison',
  COMPARISON_PROGRESS:    'comparisonProgress',
  COMPARISON_COMPLETE:    'comparisonComplete',
  COMPARISON_ERROR:       'comparisonError',

  SAVE_REPORT:            'saveReport',
  LOAD_REPORTS:           'loadReports',
  LOAD_REPORT_ELEMENTS:   'loadReportElements',
  DELETE_REPORT:          'deleteReport',
  DELETE_ALL_REPORTS:     'deleteAllReports',
  LOAD_CACHED_COMPARISON: 'loadCachedComparison',
  EXPORT_COMPARISON_HTML: 'exportComparisonHtml',

  GET_STATE:              'getState',
  WRITE_PROGRESS:         'writeProgress',
  WRITE_COMPLETE:         'writeComplete',
  WRITE_ERROR:            'writeError',

  GET_VISUAL_BLOB:        'getVisualBlob',

  VISUAL_PREPARE:         'VISUAL_PREPARE',
  VISUAL_REVERT:          'VISUAL_REVERT'
});

/**
 * Sends a message to the background service worker and waits for a response.
 * Rejects on three distinct failure paths: a Chrome-level error (`lastError`),
 * a timeout, or a `{success: false}` response from the SW — callers must handle all three.
 *
 * @param {string} type - A MessageTypes constant.
 * @param {Object} [payload]
 * @param {number} [timeoutMs=30000] - 30 s is too short for comparison workflows;
 *   callers that stream progress over time should pass a higher value.
 * @returns {Promise<*>}
 */
export function sendToBackground(type, payload = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Background message timeout: ${type}`));
    }, timeoutMs);

    const message = { type, ...payload };

    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timer);

      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }

      if (response && response.success === false) {
        const errorMsg = typeof response.error === 'string'
          ? response.error
          : (response.error?.message ?? 'Operation failed');
        return reject(new Error(errorMsg));
      }

      resolve(response);
    });
  });
}

/**
 * Sends a message to a content script running in a specific tab and waits for a reply.
 *
 * @param {number} tabId
 * @param {string} type - A MessageTypes constant.
 * @param {Object} [payload]
 * @param {number} [timeoutMs=60000] - Higher default than sendToBackground because
 *   content script operations like DOM traversal and CDP calls take longer.
 * @returns {Promise<*>}
 */
export function sendToTab(tabId, type, payload = {}, timeoutMs = 60000) {
  const message = { type, ...payload };
  return TabAdapter.sendMessage(tabId, message, timeoutMs);
}

/**
 * Registers a handler for incoming messages in the current context.
 * Errors thrown by the handler are caught and sent back as `{success: false}` —
 * the handler must not suppress errors it wants the caller to receive.
 *
 * @param {(type: string, payload: Object, sender: chrome.runtime.MessageSender) => * | Promise<*>} handler
 *   Return value becomes `response.data` on the sending side.
 * @returns {() => void} Call this to unregister the listener and avoid memory leaks.
 */
export function onMessage(handler) {
  const listener = (message, sender, sendResponse) => {
    const { type, ...payload } = message;

    if (!type) {
      logger.warn('Message received without type', { message });
      sendResponse({ success: false, error: 'Missing message type' });
      return false;
    }

    Promise.resolve(handler(type, payload, sender))
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => {
        const errorMsg = error.message || String(error);
        logger.error('Message handler error', { type, error: errorMsg, stack: error.stack });
        sendResponse({ success: false, error: errorMsg });
      });

    // Must return true to keep the channel open until sendResponse is called
    // asynchronously — returning false or undefined closes it immediately.
    return true;
  };

  chrome.runtime.onMessage.addListener(listener);

  return () => {
    chrome.runtime.onMessage.removeListener(listener);
  };
}

/**
 * Sends a message to every open tab without waiting for confirmation.
 * Individual tab failures are swallowed — this never rejects. Use sendToTab
 * directly when delivery confirmation is required.
 *
 * @param {string} type - A MessageTypes constant.
 * @param {Object} [payload]
 * @returns {Promise<PromiseSettledResult[]>}
 */
export function broadcastToAllTabs(type, payload = {}) {
  return TabAdapter.query({})
    .then(tabs => {
      const messages = tabs.map(tab =>
        sendToTab(tab.id, type, payload).catch(() => null)
      );
      return Promise.allSettled(messages);
    });
}
import logger from './logger.js';
import { TabAdapter } from './chrome-tabs.js';

export const MessageTypes = Object.freeze({
  EXTRACT_ELEMENTS:      'extractElements',
  EXTRACTION_PROGRESS:   'extractionProgress',
  EXTRACTION_COMPLETE:   'extractionComplete',
  
  START_COMPARISON:      'startComparison',
  COMPARISON_PROGRESS:   'comparisonProgress',
  COMPARISON_COMPLETE:   'comparisonComplete',
  
  SAVE_REPORT:           'saveReport',
  LOAD_REPORTS:          'loadReports',
  LOAD_REPORT_ELEMENTS:  'loadReportElements',
  DELETE_REPORT:         'deleteReport',
  DELETE_ALL_REPORTS:    'deleteAllReports',
  
  GET_STATE:             'getState',
  WRITE_PROGRESS:        'writeProgress',
  WRITE_COMPLETE:        'writeComplete',
  WRITE_ERROR:           'writeError',
});

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
          : response.error?.message || 'Operation failed';
        return reject(new Error(errorMsg));
      }

      resolve(response);
    });
  });
}

export function sendToTab(tabId, type, payload = {}, timeoutMs = 60000) {
  const message = { type, ...payload };
  return TabAdapter.sendMessage(tabId, message, timeoutMs);
}

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

    return true;
  };

  chrome.runtime.onMessage.addListener(listener);

  return () => {
    chrome.runtime.onMessage.removeListener(listener);
  };
}

export function broadcastToAllTabs(type, payload = {}) {
  return TabAdapter.query({})
    .then(tabs => {
      const messages = tabs.map(tab => 
        sendToTab(tab.id, type, payload).catch(err => null)
      );
      return Promise.allSettled(messages);
    });
}
/**
 * Content script — injected into every page the user visits.
 * Owns the EXTRACT_ELEMENTS message handler: receives filter config from the SW,
 * calls the extractor, and returns the report via sendResponse.
 * Runs in the content-script execution context (isolated world, page DOM access).
 * Failure mode: async sendResponse requires `return true` from the listener;
 * dropping that return closes the channel before the promise resolves.
 * Called by: background.js via chrome.tabs.sendMessage.
 */
import { extract } from '../core/extraction/extractor.js';
import { MessageTypes } from '../infrastructure/chrome-messaging.js';
import { ERROR_CODES, errorTracker } from '../infrastructure/error-tracker.js';
import logger from '../infrastructure/logger.js';

logger.init();
errorTracker.init();

logger.setContext({ 
  script: 'content',
  url: window.location.href 
});

logger.info('Content script initialized', { 
  url: window.location.href,
  title: document.title 
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, ...payload } = message;
  
  logger.debug('Content script received message', { type });

  if (type === MessageTypes.EXTRACT_ELEMENTS) {
    handleExtraction(payload.filters)
      .then(report => {
        sendResponse({ success: true, data: report });
      })
      .catch(error => {
        logger.error('Extraction failed', { 
          error: error.message,
          stack: error.stack 
        });
        
        errorTracker.track({
          code: ERROR_CODES.EXTRACTION_TIMEOUT,
          message: 'Failed to extract elements',
          context: { url: window.location.href, error: error.message }
        });
        
        sendResponse({ 
          success: false, 
          error: error.message || String(error)
        });
      });
    
    return true; // Keeps the message channel open until the async sendResponse fires.
  }

  logger.debug('Unknown message type — deferring to other listeners', { type });
  return false;
});

/**
 * Guards against restricted protocols then delegates to `extract`.
 * Throws if called on a chrome:// or chrome-extension:// page — caller is
 * expected to surface the error to the user via sendResponse.
 *
 * @param {object|null} filters - Optional DOM filter (class/id/tag). Passed through to extractor.
 * @returns {Promise<object>} Extraction report produced by `extract`.
 * @throws {Error} If the page protocol is not extractable.
 */
async function handleExtraction(filters) {
  if (window.location.protocol === 'chrome:' || 
      window.location.protocol === 'chrome-extension:') {
    throw new Error('Cannot extract from chrome:// pages');
  }

  try {
    const report = await extract(filters);
    return report;
  } catch (error) {
    logger.error('Extract function failed', { error: error.message });
    throw error;
  }
}

logger.debug('Content script message listener registered');
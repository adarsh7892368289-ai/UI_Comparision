import logger from '../infrastructure/logger.js';
import { errorTracker, ERROR_CODES } from '../infrastructure/error-tracker.js';
import { extract } from '../core/extraction/extractor.js';

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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  logger.debug('Content script received message', { action: request.action });

  if (request.action === 'extractElements') {
    handleExtraction(request.filters)
      .then(report => {
        logger.info('Extraction completed', { 
          totalElements: report.totalElements,
          duration: report.duration 
        });
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
          error: error.message 
        });
      });
    
    return true;
  }

  sendResponse({ success: false, error: 'Unknown action' });
  return false;
});

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
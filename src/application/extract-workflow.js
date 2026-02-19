import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/storage.js';
import { TabAdapter } from '../infrastructure/chrome-tabs.js';
import { MessageTypes, sendToTab } from '../infrastructure/chrome-messaging.js';

async function extractFromActiveTab(filters = null) {
  logger.info('Starting extraction from active tab', { filters });

  try {
    const tab = await TabAdapter.getActiveTab();
    
    if (!tab) {
      throw new Error('No active tab found');
    }

    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      throw new Error('Cannot extract from chrome:// pages');
    }

    const response = await sendToTab(tab.id, MessageTypes.EXTRACT_ELEMENTS, { filters });

    if (!response) {
      throw new Error('No response from content script - script may not be injected');
    }

    if (!response.success) {
      const errorMsg = typeof response.error === 'string' 
        ? response.error 
        : response.error?.message || 'Extraction failed';
      throw new Error(errorMsg);
    }

    if (!response.data) {
      throw new Error('Response missing data field');
    }

    const report = createReport(response.data);
    
    const saveResult = await storage.saveReport(report);
    if (!saveResult.success) {
      logger.warn('Failed to save report', { error: saveResult.error });
    }

    return report;
  } catch (error) {
    const errorMsg = error.message || String(error);
    logger.error('Extract workflow failed', { error: errorMsg, stack: error.stack });
    throw new Error(errorMsg);
  }
}

function createReport(extractionData) {
  const reportId = crypto.randomUUID();
  
  return {
    id: reportId,
    version: '1.0',
    url: extractionData.url,
    title: extractionData.title,
    timestamp: extractionData.timestamp,
    totalElements: extractionData.totalElements,
    duration: extractionData.duration,
    filters: extractionData.filters,
    elements: extractionData.elements
  };
}

export { extractFromActiveTab };
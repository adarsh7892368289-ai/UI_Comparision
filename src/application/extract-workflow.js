import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/storage.js';

async function extractFromActiveTab(filters = null) {
  logger.info('Starting extraction from active tab', { filters });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab) {
      throw new Error('No active tab found');
    }

    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      throw new Error('Cannot extract from chrome:// pages');
    }

    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'extractElements',
      filters
    });

    if (!response.success) {
      throw new Error(response.error || 'Extraction failed');
    }

    const report = createReport(response.data);
    
    const saveResult = await storage.saveReport(report);
    if (!saveResult.success) {
      logger.warn('Failed to save report', { error: saveResult.error });
    }

    return report;
  } catch (error) {
    logger.error('Extract workflow failed', { error: error.message });
    throw error;
  }
}

function createReport(extractionData) {
  const reportId = Date.now().toString();
  
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
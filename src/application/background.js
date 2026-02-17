import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/storage.js';
import { get } from '../config/defaults.js';
import { validateConfig } from '../config/validator.js';

logger.init();

try {
  validateConfig({ throwOnError: true });
  logger.info('Config validation passed ✓');
} catch (err) {
  logger.error('STARTUP FAILED: Config validation error', { error: err.message });
  throw err;
}

storage.init();

const PROGRESS_STAGES = {
  INITIATED:          { stage: 'initiated',           progress: 0    },
  EXTRACTING_BASE:    { stage: 'extracting-baseline', progress: 0.15 },
  BASE_LOADED:        { stage: 'baseline-tab-loaded', progress: 0.25 },
  BASE_COMPLETE:      { stage: 'baseline-complete',   progress: 0.5  },
  EXTRACTING_COMPARE: { stage: 'extracting-compare',  progress: 0.65 },
  COMPARE_LOADED:     { stage: 'compare-tab-loaded',  progress: 0.75 },
  COMPARE_COMPLETE:   { stage: 'compare-complete',    progress: 1.0  },
};

function operationKey(operationId) {
  return `${get('storage.stateKey')}_${operationId}`;
}

async function writeProgress(operationId, progressStage, extra = {}) {
  await storage.save(operationKey(operationId), {
    status: 'in-progress',
    ...progressStage,
    ...extra,
    operationId,
    updatedAt: Date.now()
  });
}

async function writeComplete(operationId, results) {
  await storage.save(operationKey(operationId), {
    status: 'complete',
    results,
    operationId,
    updatedAt: Date.now()
  });
  scheduleOperationCleanup(operationId);
}

async function writeError(operationId, errorMessage) {
  await storage.save(operationKey(operationId), {
    status: 'error',
    error: errorMessage,
    operationId,
    updatedAt: Date.now()
  });
  scheduleOperationCleanup(operationId);
}

function scheduleOperationCleanup(operationId) {
  setTimeout(async () => {
    await storage.delete(operationKey(operationId));
    logger.debug('Operation state cleaned up', { operationId });
  }, 10000);
}

async function handleStartComparison(message, sender, sendResponse) {
  const { baselineUrl, compareUrl, options } = message;
  const operationId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  logger.info('Starting URL comparison workflow', { operationId, baselineUrl, compareUrl });

  sendResponse({ status: 'started', operationId });

  let baselineTabId = null;
  let compareTabId = null;

  try {
    await writeProgress(operationId, PROGRESS_STAGES.INITIATED);

    await writeProgress(operationId, PROGRESS_STAGES.EXTRACTING_BASE);
    baselineTabId = await createTabForExtraction(baselineUrl);

    await writeProgress(operationId, PROGRESS_STAGES.BASE_LOADED);
    const baselineData = await extractFromTab(baselineTabId, options?.filters);
    await closeTab(baselineTabId);
    baselineTabId = null;

    await writeProgress(operationId, PROGRESS_STAGES.BASE_COMPLETE);

    await writeProgress(operationId, PROGRESS_STAGES.EXTRACTING_COMPARE);
    compareTabId = await createTabForExtraction(compareUrl);

    await writeProgress(operationId, PROGRESS_STAGES.COMPARE_LOADED);
    const compareData = await extractFromTab(compareTabId, options?.filters);
    await closeTab(compareTabId);
    compareTabId = null;

    await writeProgress(operationId, PROGRESS_STAGES.COMPARE_COMPLETE);
    await writeComplete(operationId, { baseline: baselineData, compare: compareData });

    logger.info('URL comparison workflow completed', { operationId });
  } catch (error) {
    logger.error('URL comparison workflow failed', { operationId, error: error.message });
    await closeTab(baselineTabId);
    await closeTab(compareTabId);
    await writeError(operationId, error.message);
  }
}

async function closeTab(tabId) {
  if (tabId === null) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (err) {
    logger.warn('Failed to close tab during cleanup', { tabId, error: err.message });
  }
}

function createTabForExtraction(url) {
  return new Promise((resolve, reject) => {
    const timeoutMs = get('infrastructure.timeout.tabLoad');
    const timer = setTimeout(
      () => reject(new Error(`Tab load timeout after ${timeoutMs}ms: ${url}`)),
      timeoutMs
    );

    chrome.tabs.create({ url, active: false }, (tab) => {
      const tabId = tab.id;

      const onUpdated = (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(tabId);
      };

      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

async function extractFromTab(tabId, filters) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  } catch (error) {
    if (!error.message.toLowerCase().includes('already')) {
      throw error;
    }
  }

  return new Promise((resolve, reject) => {
    const timeoutMs = get('infrastructure.timeout.contentScript');
    const timer = setTimeout(
      () => reject(new Error(`Content script extraction timeout after ${timeoutMs}ms`)),
      timeoutMs
    );

    chrome.tabs.sendMessage(tabId, { action: 'extractElements', filters }, (response) => {
      clearTimeout(timer);

      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response) {
        reject(new Error('No response from content script'));
        return;
      }

      if (response.success) {
        resolve(response.data);
      } else {
        reject(new Error(response.error || 'Extraction failed'));
      }
    });
  });
}

async function handleExtractFromTab(message, sender, sendResponse) {
  const { tabId, filters } = message;
  try {
    const report = await extractFromTab(tabId, filters);
    sendResponse({ success: true, data: report });
  } catch (error) {
    logger.error('Extract from tab failed', { tabId, error: error.message });
    sendResponse({ success: false, error: error.message });
  }
  return true;
}

async function handleSaveReport(message, sender, sendResponse) {
  try {
    const result = await storage.saveReport(message.report);
    sendResponse(result);
  } catch (error) {
    logger.error('Save report failed', { error: error.message });
    sendResponse({ success: false, error: error.message });
  }
  return true;
}

async function handleLoadReports(message, sender, sendResponse) {
  try {
    const reports = await storage.loadReports();
    sendResponse({ success: true, data: reports });
  } catch (error) {
    logger.error('Load reports failed', { error: error.message });
    sendResponse({ success: false, error: error.message });
  }
  return true;
}

async function handleDeleteReport(message, sender, sendResponse) {
  try {
    const result = await storage.deleteReport(message.id);
    sendResponse(result);
  } catch (error) {
    logger.error('Delete report failed', { id: message.id, error: error.message });
    sendResponse({ success: false, error: error.message });
  }
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  logger.debug('Background received message', { action: message.action });

  switch (message.action) {
    case 'startComparison':
      handleStartComparison(message, sender, sendResponse);
      return true;
    case 'extractFromTab':
      return handleExtractFromTab(message, sender, sendResponse);
    case 'saveReport':
      return handleSaveReport(message, sender, sendResponse);
    case 'loadReports':
      return handleLoadReports(message, sender, sendResponse);
    case 'deleteReport':
      return handleDeleteReport(message, sender, sendResponse);
    default:
      sendResponse({ success: false, error: `Unknown action: ${message.action}` });
      return false;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  logger.info('Extension installed/updated');
});

logger.info('Background service worker initialized');
import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/storage.js';
import { get } from '../config/defaults.js';
import { validateConfig } from '../config/validator.js';

// ─── STARTUP SEQUENCE ────────────────────────────────────────────────────────
// Order matters: logger first (init uses config), then config validation,
// then storage. Fail loudly on config errors so regressions surface immediately.

logger.init();

try {
  validateConfig({ throwOnError: true });
  logger.info('Config validation passed ✓');
} catch (err) {
  // Log the full error — this is a developer-facing failure
  logger.error('STARTUP FAILED: Config validation error', { error: err.message });
  // Re-throw so the service worker crashes visibly (better than silent bad state)
  throw err;
}

storage.init();

const activeOperations = new Map();

async function saveOperationState(operationId, state) {
  const stateKey = get('storage.stateKey', 'page_comparator_state');
  await storage.save(`${stateKey}_${operationId}`, state);
}

async function loadOperationState(operationId) {
  const stateKey = get('storage.stateKey', 'page_comparator_state');
  return await storage.load(`${stateKey}_${operationId}`);
}

async function clearOperationState(operationId) {
  const stateKey = get('storage.stateKey', 'page_comparator_state');
  await storage.delete(`${stateKey}_${operationId}`);
}

async function handleStartComparison(message, sender, sendResponse) {
  const { baselineUrl, compareUrl, options } = message;
  const operationId = Date.now().toString();

  logger.info('Starting comparison workflow', { 
    operationId, 
    baselineUrl, 
    compareUrl 
  });

  try {
    await saveOperationState(operationId, {
      stage: 'initiated',
      baselineUrl,
      compareUrl,
      options,
      timestamp: new Date().toISOString()
    });

    sendResponse({ status: 'progress', stage: 'extracting-baseline', progress: 0 });

    const baselineTab = await createTabForExtraction(baselineUrl);
    await saveOperationState(operationId, { stage: 'baseline-tab-created', baselineTabId: baselineTab.id });

    const baselineReport = await extractFromTab(baselineTab.id, options?.filters);
    await chrome.tabs.remove(baselineTab.id);

    await saveOperationState(operationId, { 
      stage: 'baseline-complete', 
      baselineReport: baselineReport.id 
    });

    sendResponse({ status: 'progress', stage: 'extracting-compare', progress: 0.5 });

    const compareTab = await createTabForExtraction(compareUrl);
    await saveOperationState(operationId, { stage: 'compare-tab-created', compareTabId: compareTab.id });

    const compareReport = await extractFromTab(compareTab.id, options?.filters);
    await chrome.tabs.remove(compareTab.id);

    await clearOperationState(operationId);

    sendResponse({ 
      status: 'complete', 
      results: {
        baseline: baselineReport,
        compare: compareReport
      }
    });

    logger.info('Comparison workflow completed', { operationId });

  } catch (error) {
    logger.error('Comparison workflow failed', { 
      operationId, 
      error: error.message 
    });

    await clearOperationState(operationId);

    sendResponse({ 
      status: 'error', 
      error: error.message 
    });
  }

  return true;
}

async function createTabForExtraction(url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Tab creation timeout'));
    }, get('infrastructure.timeout.tabLoad'));

    chrome.tabs.create({ url, active: false }, (tab) => {
      const tabId = tab.id;

      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(tab);
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
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
    if (!error.message.includes('already')) {
      throw error;
    }
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Extraction timeout'));
    }, get('infrastructure.timeout.contentScript'));

    chrome.tabs.sendMessage(
      tabId,
      { action: 'extractElements', filters },
      (response) => {
        clearTimeout(timeout);

        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (response.success) {
          resolve(response.data);
        } else {
          reject(new Error(response.error || 'Extraction failed'));
        }
      }
    );
  });
}

async function handleExtractFromTab(message, sender, sendResponse) {
  const { tabId, filters } = message;

  try {
    const report = await extractFromTab(tabId, filters);
    sendResponse({ success: true, data: report });
  } catch (error) {
    logger.error('Extract from tab failed', { 
      tabId, 
      error: error.message 
    });
    sendResponse({ success: false, error: error.message });
  }

  return true;
}

async function handleSaveReport(message, sender, sendResponse) {
  const { report } = message;

  try {
    const result = await storage.saveReport(report);
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
  const { id } = message;

  try {
    const result = await storage.deleteReport(id);
    sendResponse(result);
  } catch (error) {
    logger.error('Delete report failed', { id, error: error.message });
    sendResponse({ success: false, error: error.message });
  }

  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  logger.debug('Background received message', { action: message.action });

  switch (message.action) {
    case 'startComparison':
      return handleStartComparison(message, sender, sendResponse);
    case 'extractFromTab':
      return handleExtractFromTab(message, sender, sendResponse);
    case 'saveReport':
      return handleSaveReport(message, sender, sendResponse);
    case 'loadReports':
      return handleLoadReports(message, sender, sendResponse);
    case 'deleteReport':
      return handleDeleteReport(message, sender, sendResponse);
    default:
      sendResponse({ success: false, error: 'Unknown action' });
      return false;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  logger.info('Extension installed/updated');
});

logger.info('Background service worker initialized');
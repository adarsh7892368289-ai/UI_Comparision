import logger from '../infrastructure/logger.js';
import { StorageTransport } from '../infrastructure/storage-transport.js';
import storage from '../infrastructure/storage.js';
import { get } from '../config/defaults.js';
import { validateConfig } from '../config/validator.js';
import { MessageTypes, onMessage } from '../infrastructure/chrome-messaging.js';
import { TabAdapter } from '../infrastructure/chrome-tabs.js';
import { extractFromActiveTab } from './extract-workflow.js';
import { compareReports } from './compare-workflow.js';

logger.init();

if (get('logging.persistLogs', true)) {
  logger.addTransport(new StorageTransport());
}

try {
  validateConfig({ throwOnError: true });
  logger.info('Config validation passed ✓');
} catch (err) {
  logger.error('STARTUP FAILED: Config validation error', { error: err.message });
  throw err;
}

storage.init();

const handlers = {
  [MessageTypes.EXTRACT_ELEMENTS]: handleExtractElements,
  [MessageTypes.START_COMPARISON]: handleStartComparison,
  [MessageTypes.SAVE_REPORT]: handleSaveReport,
  [MessageTypes.LOAD_REPORTS]: handleLoadReports,
  [MessageTypes.DELETE_REPORT]: handleDeleteReport,
};

onMessage(async (type, payload, sender) => {
  const handler = handlers[type];
  
  if (!handler) {
    logger.warn('Unknown message type', { type });
    throw new Error(`Unknown message type: ${type}`);
  }
  
  return handler(payload, sender);
});

async function handleExtractElements(payload, sender) {
  try {
    const { filters } = payload;
    logger.info('Extract elements requested', { filters });
    
    const report = await extractFromActiveTab(filters);
    return { report };
  } catch (error) {
    const errorMsg = error.message || String(error);
    logger.error('handleExtractElements failed', { error: errorMsg });
    throw new Error(errorMsg);
  }
}

async function handleStartComparison(payload, sender) {
  try {
    const { baselineId, compareId, mode } = payload;
    logger.info('Comparison requested', { baselineId, compareId, mode });
    
    const result = await compareReports(baselineId, compareId, mode);
    return { result };
  } catch (error) {
    const errorMsg = error.message || String(error);
    logger.error('handleStartComparison failed', { error: errorMsg });
    throw new Error(errorMsg);
  }
}

async function handleSaveReport(payload, sender) {
  try {
    const { report } = payload;
    const result = await storage.saveReport(report);
    return result;
  } catch (error) {
    const errorMsg = error.message || String(error);
    logger.error('handleSaveReport failed', { error: errorMsg });
    throw new Error(errorMsg);
  }
}

async function handleLoadReports(payload, sender) {
  try {
    const reports = await storage.loadReports();
    return { reports };
  } catch (error) {
    const errorMsg = error.message || String(error);
    logger.error('handleLoadReports failed', { error: errorMsg });
    throw new Error(errorMsg);
  }
}

async function handleDeleteReport(payload, sender) {
  try {
    const { id } = payload;
    const result = await storage.deleteReport(id);
    return result;
  } catch (error) {
    const errorMsg = error.message || String(error);
    logger.error('handleDeleteReport failed', { error: errorMsg });
    throw new Error(errorMsg);
  }
}

logger.info('Background service worker initialized');
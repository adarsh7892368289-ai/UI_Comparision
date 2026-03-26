import { TabAdapter } from '../infrastructure/chrome-tabs.js';
import { MessageTypes, sendToTab } from '../infrastructure/chrome-messaging.js';
import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/idb-repository.js';
import { performanceMonitor } from '../infrastructure/performance-monitor.js';
import { get } from '../config/defaults.js';

const BLOCKED_PROTOCOLS = new Set(['chrome:', 'chrome-extension:', 'about:', 'data:']);
const IPC_SIZE_WARN_THRESHOLD = 2_000_000;
const REPORT_VERSION = '3.0';

class ProtocolError extends Error {
  constructor(expected, actual) {
    super(
      `Report version contract violated: expected=${expected}, actual=${actual}. ` +
      `Recapture the page to generate a v${expected} report.`
    );
    this.name            = 'ProtocolError';
    this.expectedVersion = expected;
    this.actualVersion   = actual;
  }
}

function assertReportVersion(version) {
  if (version !== REPORT_VERSION) {
    throw new ProtocolError(REPORT_VERSION, version);
  }
}

function validateTab(tab) {
  if (!tab) {
    throw new Error('No active tab found');
  }
  let protocol;
  try {
    ({ protocol } = new URL(tab.url ?? ''));
  } catch {
    throw new Error(`Invalid tab URL: ${tab.url ?? 'undefined'}`);
  }
  if (BLOCKED_PROTOCOLS.has(protocol)) {
    throw new Error(`Cannot extract from ${protocol} pages`);
  }
}

function validateExtractionResponse(response) {
  if (!response) {
    throw new Error('No response from content script — script may not be injected');
  }
  if (!response.success) {
    const msg = typeof response.error === 'string'
      ? response.error
      : (response.error?.message ?? 'Extraction failed');
    throw new Error(msg);
  }
  const { data } = response;
  if (!data || typeof data !== 'object' || !Array.isArray(data.elements)) {
    throw new Error('Invalid extraction payload shape');
  }
  return data;
}

function estimatePayloadBytes(data) {
  return (data.elements?.length ?? 0) * 56 * 30;
}

function buildReport(data) {
  return {
    id:              crypto.randomUUID(),
    version:         REPORT_VERSION,
    url:             data.url,
    title:           data.title,
    timestamp:       data.timestamp,
    captureQuality:  data.captureQuality,
    totalElements:   data.totalElements,
    duration:        data.duration,
    filters:         data.filters         ?? null,
    extractOptions:  data.extractOptions  ?? null,
    styleCategories: data.styleCategories ?? [],
    elements:        data.elements
  };
}

function toReportMeta({ elements, ...meta }) {
  return meta;
}

function isSameOrigin(tabUrl, frameUrl) {
  try {
    return new URL(tabUrl).origin === new URL(frameUrl).origin;
  } catch {
    return false;
  }
}

function tagFrameElements(elements, frameId, frameUrl) {
  return elements.map(el => ({ ...el, frameId, frameUrl }));
}

async function extractFromFrame(tabId, frame, filters, timeout) {
  try {
    const response = await sendToTab(
      tabId,
      MessageTypes.EXTRACT_ELEMENTS,
      { filters, frameId: frame.frameId },
      timeout
    );
    const frameData = validateExtractionResponse(response);
    return tagFrameElements(frameData.elements, frame.frameId, frame.url);
  } catch (err) {
    logger.warn('Frame extraction skipped', { frameId: frame.frameId, url: frame.url, error: err.message });
    return [];
  }
}

async function discoverAndExtractFrames(tabId, tabUrl, filters, timeout) {
  const allFrames = await TabAdapter.getFrames(tabId);
  const sameOriginFrames = allFrames.filter(
    f => f.frameId !== 0 && isSameOrigin(tabUrl, f.url)
  );

  if (!sameOriginFrames.length) {
    return [];
  }

  logger.debug('Same-origin frames discovered', { count: sameOriginFrames.length });

  const settled = await Promise.allSettled(
    sameOriginFrames.map(frame => extractFromFrame(tabId, frame, filters, timeout))
  );

  return settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}

async function extractFromActiveTab(filters = null) {
  const perfHandle = performanceMonitor.start('extract-workflow');

  try {
    const tab = await TabAdapter.getActiveTab();
    validateTab(tab);

    logger.info('Extraction requested', { tabId: tab.id, url: tab.url, filters });

    const timeout  = get('infrastructure.timeout.contentScript');
    const response = await sendToTab(tab.id, MessageTypes.EXTRACT_ELEMENTS, { filters }, timeout);
    const data     = validateExtractionResponse(response);

    const estimatedBytes = estimatePayloadBytes(data);
    if (estimatedBytes > IPC_SIZE_WARN_THRESHOLD) {
      logger.warn('Large extraction payload received', {
        estimatedBytes,
        elementCount: data.elements.length,
        tabId: tab.id
      });
    }

    const frameElements = await discoverAndExtractFrames(tab.id, tab.url, filters, timeout);
    if (frameElements.length > 0) {
      data.elements.push(...frameElements);
      data.totalElements = data.elements.length;
      logger.debug('Frame elements merged', { frameElementCount: frameElements.length });
    }

    const report = buildReport(data);

    assertReportVersion(report.version);

    await storage.saveReport(report);

    logger.info('Report persisted', {
      reportId:       report.id,
      version:        report.version,
      totalElements:  report.totalElements,
      captureQuality: report.captureQuality,
      duration:       report.duration
    });

    performanceMonitor.end(perfHandle);
    return toReportMeta(report);

  } catch (err) {
    performanceMonitor.end(perfHandle);

    if (err instanceof ProtocolError) {
      logger.error('Protocol contract violation — report NOT persisted', {
        error:           err.message,
        expectedVersion: err.expectedVersion,
        actualVersion:   err.actualVersion
      });
    } else {
      logger.error('Extract workflow failed', { error: err.message });
    }

    throw err;
  }
}

export { extractFromActiveTab, ProtocolError };


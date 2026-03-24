/**
 * Orchestrates DOM extraction from the active tab: validates the tab, sends the
 * extract message to the content script, merges same-origin iframe elements,
 * assembles the report, and persists it to IDB. Runs in the MV3 service worker.
 * Failure mode contained here: ProtocolError is re-thrown as-is so the caller can
 * distinguish a version contract violation from a generic extraction failure.
 * Callers: background.js (handleExtractElements via extractFromActiveTab).
 */
import { TabAdapter } from '../infrastructure/chrome-tabs.js';
import { MessageTypes, sendToTab } from '../infrastructure/chrome-messaging.js';
import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/idb-repository.js';
import { performanceMonitor } from '../infrastructure/performance-monitor.js';
import { get } from '../config/defaults.js';

const BLOCKED_PROTOCOLS = new Set(['chrome:', 'chrome-extension:', 'about:', 'data:']);
const IPC_SIZE_WARN_THRESHOLD = 2_000_000;
const REPORT_VERSION = '3.0';

/**
 * Thrown when the content script returns a report whose version does not match
 * REPORT_VERSION. The message is user-facing and instructs the user to recapture.
 */
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

/**
 * Guards against a version mismatch between what the SW stamps on the report and
 * what the content script returned. Called after buildReport so REPORT_VERSION
 * is already in the assembled report — this is a contract assertion, not user input validation.
 */
function assertReportVersion(version) {
  if (version !== REPORT_VERSION) {
    throw new ProtocolError(REPORT_VERSION, version);
  }
}

/**
 * Throws if the tab is missing or its URL uses a protocol the content script
 * cannot be injected into (chrome:, about:, data:, etc.).
 */
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

/**
 * Validates the message response from the content script, covering three distinct
 * failure modes: null response (script not yet injected), explicit {success:false}
 * error returned by the script, and an invalid payload shape.
 * @returns {Object} The validated data payload.
 */
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

/**
 * Rough IPC payload size estimate: ~56 bytes per property × ~30 properties per element.
 * Used only to trigger a log warning — not an accurate byte count.
 */
function estimatePayloadBytes(data) {
  return (data.elements?.length ?? 0) * 56 * 30;
}

/** Assembles the full report object, stamping a new UUID and the current REPORT_VERSION. */
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

/**
 * Returns the report without its elements array. Mirrors the IDB split-store pattern —
 * elements are persisted separately by saveReport and must not be returned to the caller.
 */
function toReportMeta({ elements, ...meta }) {
  return meta;
}

/**
 * Returns false on any URL parse error — cross-origin or unparseable frame URLs
 * are treated as non-same-origin and skipped silently.
 */
function isSameOrigin(tabUrl, frameUrl) {
  try {
    return new URL(tabUrl).origin === new URL(frameUrl).origin;
  } catch {
    return false;
  }
}

/** Annotates each element with its source frame ID and URL before merging into the main list. */
function tagFrameElements(elements, frameId, frameUrl) {
  return elements.map(el => ({ ...el, frameId, frameUrl }));
}

/**
 * Sends an extraction request to a single iframe and tags the returned elements
 * with the frame's ID and URL. Failures are logged and return [] so one broken
 * iframe does not abort the entire extraction.
 */
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

/**
 * Finds all same-origin iframes in the tab and extracts their elements in parallel.
 * frameId 0 is the main frame (already extracted by the caller) and is excluded.
 * Cross-origin frames are skipped — Chrome message isolation prevents injection into them.
 */
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

/**
 * Top-level extraction entry point. Validates the tab, runs the main-frame extraction,
 * merges same-origin iframe elements, persists the report, and returns the report
 * metadata (without elements).
 *
 * performanceMonitor.end() is called in both success and catch paths — there is no
 * finally block here intentionally, as the catch must also re-throw after cleanup.
 *
 * @param {Object|null} [filters] - Extraction filter options forwarded to the content script.
 * @returns {Promise<Object>} Report metadata without elements.
 * @throws {ProtocolError} If the content script returns a mismatched report version.
 * @throws {Error} For all other tab, injection, or IDB failures.
 */
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
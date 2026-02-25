import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';
import { performanceMonitor } from '../../infrastructure/performance-monitor.js';
import { safeExecute } from '../../infrastructure/safe-execute.js';
import { collectAttributes } from './attribute-collector.js';
import { buildShadowHostId, traverseDocument } from './dom-traversal.js';
import { classifyTier, isTierZero, isVisible } from './element-classifier.js';
import { buildFingerprint } from './fingerprint.js';
import { waitForReadiness } from './readiness-gate.js';
import { buildContextSnapshot, collectStylesFromComputed } from './style-collector.js';
import { generateSelectorsForElements } from '../selectors/selector-engine.js';

const yieldChannel = new MessageChannel();
yieldChannel.port1.start();

function yieldToEventLoop() {
  return new Promise(resolve => {
    yieldChannel.port1.onmessage = resolve;
    yieldChannel.port2.postMessage(null);
  });
}

function executePass1(visits) {
  performance.mark('pass1-start');

  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const rootFontSize = window.getComputedStyle(document.documentElement).fontSize;
  const readings = new Array(visits.length);

  for (let i = 0; i < visits.length; i++) {
    const { element } = visits[i];
    try {
      const parentEl = element.parentElement;
      readings[i] = {
        rect:                element.getBoundingClientRect(),
        computedStyle:       window.getComputedStyle(element),
        parentComputedStyle: parentEl ? window.getComputedStyle(parentEl) : null,
        rootFontSize,
        isConnected:         element.isConnected,
        scrollX,
        scrollY
      };
    } catch {
      readings[i] = {
        rect:                { x: 0, y: 0, width: 0, height: 0 },
        computedStyle:       null,
        parentComputedStyle: null,
        rootFontSize,
        isConnected:         false,
        scrollX,
        scrollY
      };
    }
  }

  performance.mark('pass1-end');
  performance.measure('extraction-pass1', 'pass1-start', 'pass1-end');

  return readings;
}

function applyVisibilityFilter(visits, readings) {
  if (!get('extraction.skipInvisible')) {
    return { filteredVisits: visits, filteredReadings: readings };
  }

  const filteredVisits   = [];
  const filteredReadings = [];

  for (let i = 0; i < visits.length; i++) {
    if (!readings[i].isConnected) {
      continue;
    }
    if (isTierZero(visits[i].element)) {
      continue;
    }
    if (isVisible(readings[i].computedStyle, readings[i].rect)) {
      filteredVisits.push(visits[i]);
      filteredReadings.push(readings[i]);
    }
  }

  return { filteredVisits, filteredReadings };
}

function buildBoundingRect(rect, scrollX, scrollY) {
  if (!rect) {
    return null;
  }
  return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
}

function buildElementRecord(visit, captureIndex, reading) {
  const { element, depth, sameTagSiblingIndex, shadowContext } = visit;
  const { rect, computedStyle, parentComputedStyle, rootFontSize, scrollX, scrollY } = reading;

  return {
    captureIndex,
    tagName:         element.tagName,
    elementId:       element.id || null,
    className:       element.getAttribute('class') || '',
    textContent:     (element.textContent ?? '').trim().substring(0, 500),
    tier:            classifyTier(element),
    depth,
    fingerprint:     buildFingerprint(element, depth, sameTagSiblingIndex),
    selectors:       null,
    styles:          collectStylesFromComputed(computedStyle),
    attributes:      collectAttributes(element),
    contextSnapshot: buildContextSnapshot(
      computedStyle, rect, scrollX, scrollY, parentComputedStyle, rootFontSize
    ),
    shadowContext:   shadowContext ?? null,
    shadowId:        buildShadowHostId(visit, captureIndex),
    boundingRect:    buildBoundingRect(rect, scrollX, scrollY)
  };
}

async function processElement(visit, captureIndex, reading, timeout) {
  const result = await safeExecute(
    () => buildElementRecord(visit, captureIndex, reading),
    { timeout, operation: 'element-extraction' }
  );
  return result.success ? result.data : null;
}

function buildBatchPromises(visits, readings, batchStart, batchEnd, timeout) {
  const promises = [];
  for (let j = batchStart; j < batchEnd; j++) {
    promises.push(processElement(visits[j], j, readings[j], timeout));
  }
  return promises;
}

async function executePass2Batched(visits, readings) {
  performance.mark('pass2-start');

  const batchSize        = get('extraction.batchSize');
  const perElementTimeout = get('extraction.perElementTimeout');
  const results          = [];

  for (let i = 0; i < visits.length; i += batchSize) {
    const batchEnd = Math.min(i + batchSize, visits.length);
    const settled = await Promise.allSettled(
      buildBatchPromises(visits, readings, i, batchEnd, perElementTimeout)
    );

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled' && outcome.value !== null) {
        results.push(outcome.value);
      }
    }

    if (batchEnd < visits.length) {
      await yieldToEventLoop();
    }
  }

  performance.mark('pass2-end');
  performance.measure('extraction-pass2', 'pass2-start', 'pass2-end');

  return results;
}

function buildVisitIndex(visits) {
  const index = new Map();
  for (let i = 0; i < visits.length; i++) {
    index.set(i, visits[i].element);
  }
  return index;
}

async function executePass3SelectorEnrichment(elements, visits) {
  performance.mark('pass3-start');

  const visitIndex = buildVisitIndex(visits);
  const liveElements = elements.map(record => visitIndex.get(record.captureIndex) ?? null);

  const selectorResults = await generateSelectorsForElements(liveElements.filter(Boolean));

  let selectorIdx = 0;
  for (let i = 0; i < elements.length; i++) {
    if (liveElements[i] !== null) {
      elements[i].selectors = selectorResults[selectorIdx] ?? null;
      selectorIdx++;
    }
  }

  performance.mark('pass3-end');
  performance.measure('extraction-pass3', 'pass3-start', 'pass3-end');

  logger.debug('Pass 3 selector enrichment complete', {
    enriched: selectorIdx,
    total:    elements.length
  });
}

async function extract(filters = null) {
  const perfHandle = performanceMonitor.start('extraction-total');
  const startTime  = performance.now();

  logger.info('Extraction started', { url: window.location.href, hasFilters: Boolean(filters) });

  try {
    const captureQuality = await waitForReadiness();

    performance.mark('traversal-start');
    const visits = traverseDocument(filters);
    performance.mark('traversal-end');
    performance.measure('extraction-traversal', 'traversal-start', 'traversal-end');

    logger.debug('Traversal complete', { rawCount: visits.length });

    const readings = executePass1(visits);
    const { filteredVisits, filteredReadings } = applyVisibilityFilter(visits, readings);

    const maxElements    = get('extraction.maxElements');
    const overflow       = filteredVisits.length > maxElements;
    const clampedVisits  = overflow ? filteredVisits.slice(0, maxElements) : filteredVisits;
    const clampedReadings = overflow ? filteredReadings.slice(0, maxElements) : filteredReadings;

    if (overflow) {
      logger.warn('Element count truncated', { original: filteredVisits.length, limit: maxElements });
    }

    const elements = await executePass2Batched(clampedVisits, clampedReadings);

    await executePass3SelectorEnrichment(elements, clampedVisits);

    const duration = Math.round(performance.now() - startTime);
    performanceMonitor.end(perfHandle);

    logger.info('Extraction complete', { elementCount: elements.length, duration, captureQuality });

    return {
      url:           window.location.href,
      title:         document.title,
      timestamp:     new Date().toISOString(),
      captureQuality,
      totalElements: elements.length,
      duration,
      filters:       filters ?? null,
      elements
    };
  } catch (err) {
    performanceMonitor.end(perfHandle);
    logger.error('Extraction failed', { error: err.message, url: window.location.href });
    throw err;
  }
}

export { extract };
import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';
import { safeExecute } from '../../infrastructure/safe-execute.js';
import { performanceMonitor } from '../../infrastructure/performance-monitor.js';
import { generateSelectors } from '../selectors/selector-engine.js';
import { collectAttributes, getPriorityAttributes } from './attribute-collector.js';
import { classifyTier, isVisible, shouldSkipTag } from './element-classifier.js';
import { collectStylesFromComputed, buildContextSnapshot } from './style-collector.js';
import { traverseDocument, traverseFilteredScoped, buildShadowHostId } from './dom-traversal.js';
import { buildFingerprint } from './fingerprint.js';
import { waitForReadiness } from './readiness-gate.js';

const MC = new MessageChannel();
MC.port1.start();

function yieldToEventLoop() {
  return new Promise(resolve => {
    MC.port1.onmessage = resolve;
    MC.port2.postMessage(null);
  });
}

function collectFilteredRoots(filters) {
  const matched = new Set();

  const addWithDescendants = el => {
    matched.add(el);
    for (const desc of el.querySelectorAll('*')) {
      matched.add(desc);
    }
  };

  if (filters.class) {
    for (const cls of filters.class.split(',').map(c => c.trim()).filter(Boolean)) {
      const selector = cls.startsWith('.') ? cls : `.${cls}`;
      try {
        for (const el of document.querySelectorAll(selector)) {
          addWithDescendants(el);
        }
      } catch (error) {
        logger.warn('Invalid class filter', { cls, error: error.message });
      }
    }
  }

  if (filters.id) {
    for (const id of filters.id.split(',').map(i => i.trim()).filter(Boolean)) {
      const selector = id.startsWith('#') ? id : `#${id}`;
      try {
        const el = document.querySelector(selector);
        if (el) {
          addWithDescendants(el);
        }
      } catch (error) {
        logger.warn('Invalid id filter', { id, error: error.message });
      }
    }
  }

  if (filters.tag) {
    for (const tag of filters.tag.split(',').map(t => t.trim()).filter(Boolean)) {
      try {
        for (const el of document.querySelectorAll(tag)) {
          addWithDescendants(el);
        }
      } catch (error) {
        logger.warn('Invalid tag filter', { tag, error: error.message });
      }
    }
  }

  return Array.from(matched);
}

function executePass1(visits) {
  performance.mark('pass1-start');

  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const readings = new Array(visits.length);

  for (let i = 0; i < visits.length; i++) {
    const { element } = visits[i];
    try {
      const rect = element.getBoundingClientRect();
      const computedStyle = window.getComputedStyle(element);
      readings[i] = { rect, computedStyle, scrollX, scrollY, isConnected: element.isConnected };
    } catch {
      readings[i] = {
        rect: { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 },
        computedStyle: null,
        scrollX,
        scrollY,
        isConnected: false
      };
    }
  }

  performance.mark('pass1-end');
  performance.measure('extraction-pass1', 'pass1-start', 'pass1-end');

  return readings;
}

function applyVisibilityFilter(visits, readings) {
  const skipInvisible = get('extraction.skipInvisible');
  if (!skipInvisible) {
    return { filteredVisits: visits, filteredReadings: readings };
  }

  const filteredVisits = [];
  const filteredReadings = [];

  for (let i = 0; i < visits.length; i++) {
    if (!readings[i].isConnected) {
      continue;
    }
    if (shouldSkipTag(visits[i].element)) {
      continue;
    }
    if (isVisible(readings[i].computedStyle, readings[i].rect)) {
      filteredVisits.push(visits[i]);
      filteredReadings.push(readings[i]);
    }
  }

  return { filteredVisits, filteredReadings };
}

async function executePass2Batched(visits, readings) {
  performance.mark('pass2-start');

  const batchSize = get('extraction.batchSize');
  const perElementTimeout = get('extraction.perElementTimeout');
  const results = [];

  for (let i = 0; i < visits.length; i += batchSize) {
    const batchEnd = Math.min(i + batchSize, visits.length);
    const settled = await Promise.allSettled(
      visits.slice(i, batchEnd).map((visit, j) =>
        _processElement(visit, i + j, readings[i + j], perElementTimeout)
      )
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

async function _processElement(visit, captureIndex, reading, timeout) {
  const result = await safeExecute(
    () => _buildElementRecord(visit, captureIndex, reading),
    { timeout, operation: 'element-extraction' }
  );
  return result.success ? result.data : null;
}

async function _buildElementRecord(visit, captureIndex, reading) {
  const { element, depth, shadowContext } = visit;
  const { rect, computedStyle, scrollX, scrollY } = reading;

  const tier = classifyTier(element);
  const fingerprint = buildFingerprint(element, depth);
  const styles = collectStylesFromComputed(computedStyle);
  const attributes = collectAttributes(element);
  const contextSnapshot = buildContextSnapshot(computedStyle, rect, scrollX, scrollY);
  const selectors = await generateSelectors(element);
  const shadowId = buildShadowHostId(visit, captureIndex);

  return {
    captureIndex,
    tagName: element.tagName,
    elementId: element.id || null,
    className: element.getAttribute('class') || '',
    textContent: (element.textContent ?? '').trim().substring(0, 500),
    tier,
    depth,
    fingerprint,
    selectors,
    styles,
    attributes,
    contextSnapshot,
    shadowContext: shadowContext ?? null,
    shadowId: shadowId ?? null,
    boundingRect: contextSnapshot.boundingRect
  };
}

async function extract(filters = null) {
  const perfHandle = performanceMonitor.start('extraction-total');
  const startTime = performance.now();

  logger.info('Extraction requested', { url: window.location.href, hasFilters: filters !== null });

  try {
    const captureQuality = await waitForReadiness();

    performance.mark('extraction-traversal-start');

    const visits = _collectVisits(filters);

    performance.mark('extraction-traversal-end');
    performance.measure('extraction-traversal', 'extraction-traversal-start', 'extraction-traversal-end');

    logger.debug('Traversal complete', { rawCount: visits.length });

    const readings = executePass1(visits);
    const { filteredVisits, filteredReadings } = applyVisibilityFilter(visits, readings);

    const maxElements = get('extraction.maxElements');
    const clampedVisits = filteredVisits.length > maxElements
      ? filteredVisits.slice(0, maxElements)
      : filteredVisits;
    const clampedReadings = filteredVisits.length > maxElements
      ? filteredReadings.slice(0, maxElements)
      : filteredReadings;

    if (filteredVisits.length > maxElements) {
      logger.warn(`Element count truncated`, { original: filteredVisits.length, limit: maxElements });
    }

    logger.debug('Starting Pass 2 (async)', { elementCount: clampedVisits.length });

    const elements = await executePass2Batched(clampedVisits, clampedReadings);
    const duration = Math.round(performance.now() - startTime);

    performanceMonitor.end(perfHandle);

    logger.info('Extraction complete', {
      elementCount: elements.length,
      duration,
      msPerElement: elements.length > 0
        ? Math.round((duration / elements.length) * 100) / 100
        : 0,
      captureQuality
    });

    if (elements.length >= 100) {
      performanceMonitor.logImprovement();
    }

    return {
      url: window.location.href,
      title: document.title,
      timestamp: new Date().toISOString(),
      captureQuality,
      totalElements: elements.length,
      duration,
      filters: filters ?? null,
      elements
    };
  } catch (error) {
    performanceMonitor.end(perfHandle);
    logger.error('Extraction failed', { error: error.message, url: window.location.href });
    throw error;
  }
}

function _collectVisits(filters) {
  const hasExplicitFilter = filters && (filters.class || filters.id || filters.tag);
  if (!hasExplicitFilter) {
    return traverseDocument(filters);
  }

  const rootElements = collectFilteredRoots(filters);
  return traverseFilteredScoped(rootElements, filters);
}

export { extract };
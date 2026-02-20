import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';
import { safeExecute } from '../../infrastructure/safe-execute.js';
import { performanceMonitor } from '../../infrastructure/performance-monitor.js';
import { generateSelectors } from '../selectors/selector-engine.js';
import { collectAttributes } from './attribute-collector.js';
import { shouldSkipElement } from './element-filters.js';
import { 
  calculatePositionFromRect,
  getVisibilityDataFromRect 
} from './position-calculator.js';
import { collectStylesFromComputed } from './style-collector.js';

// Max chars stored for textContent per element — prevents bloated reports on text-heavy pages
const TEXT_CONTENT_MAX_CHARS = 500;

async function extract(filters = null) {
  const perfHandle = performanceMonitor.start('extraction-total');
  const startTime = performance.now();
  logger.info('Starting extraction', { url: window.location.href, filters });

  try {
    let elements = filters && (filters.class || filters.id || filters.tag)
      ? _findFilteredElements(filters)
      : Array.from(document.querySelectorAll('*'));

    logger.debug(`${elements.length} raw elements`);

    elements = elements.filter(el => !shouldSkipElement(el));

    if (get('extraction.skipInvisible')) {
      // Batch ALL getComputedStyle reads in one synchronous pass to avoid
      // N individual forced-layout reflows before the main batchDOMReads.
      // Reading all at once lets the browser resolve layout a single time.
      const computedStyles = elements.map(el => {
        try { return window.getComputedStyle(el); }
        catch (_) { return null; }
      });
      elements = elements.filter((_, i) => {
        const cs = computedStyles[i];
        return cs && cs.display !== 'none' && cs.visibility !== 'hidden';
      });
    }

    const max = get('extraction.maxElements');
    if (elements.length > max) {
      logger.warn(`Truncating to ${max} elements`);
      elements = elements.slice(0, max);
    }

    logger.debug(`${elements.length} elements queued for extraction`);

    const extracted = await _extractBatched(elements);
    const duration  = Math.round(performance.now() - startTime);

    performanceMonitor.end(perfHandle);
    logger.info('Extraction complete', { 
      totalElements: extracted.length, 
      duration,
      msPerElement: Math.round(duration / extracted.length * 100) / 100
    });
    
    if (extracted.length >= 100) {
      performanceMonitor.logImprovement();
    }

    return {
      url:           window.location.href,
      title:         document.title,
      timestamp:     new Date().toISOString(),
      totalElements: extracted.length,
      duration,
      filters:       filters || null,
      elements:      extracted
    };
  } catch (error) {
    logger.error('Extraction failed', { error: error.message });
    throw error;
  }
}

function _findFilteredElements(filters) {
  const matched = new Set();

  const addWithDescendants = el => {
    matched.add(el);
    for (const desc of el.querySelectorAll('*')) matched.add(desc);
  };

  if (filters.class) {
    for (const cls of filters.class.split(',').map(c => c.trim()).filter(Boolean)) {
      const sel = cls.startsWith('.') ? cls : `.${cls}`;
      try { for (const el of document.querySelectorAll(sel)) addWithDescendants(el); }
      catch (e) { logger.warn('Invalid class selector', { cls, error: e.message }); }
    }
  }

  if (filters.id) {
    for (const id of filters.id.split(',').map(i => i.trim()).filter(Boolean)) {
      const sel = id.startsWith('#') ? id : `#${id}`;
      try { const el = document.querySelector(sel); if (el) addWithDescendants(el); }
      catch (e) { logger.warn('Invalid id selector', { id, error: e.message }); }
    }
  }

  if (filters.tag) {
    for (const tag of filters.tag.split(',').map(t => t.trim()).filter(Boolean)) {
      try { for (const el of document.querySelectorAll(tag)) addWithDescendants(el); }
      catch (e) { logger.warn('Invalid tag selector', { tag, error: e.message }); }
    }
  }

  return Array.from(matched);
}

function batchDOMReads(elements) {
  const perfHandle = performanceMonitor.start('dom-batch-reads');
  
  const readings = elements.map(el => {
    try {
      return {
        rect:          el.getBoundingClientRect(),
        computedStyle: window.getComputedStyle(el),
        isConnected:   el.isConnected,
        offsetParent:  el.offsetParent
      };
    } catch (error) {
      logger.warn('DOM read failed for element', { tagName: el.tagName, error: error.message });
      return {
        rect:          { left: 0, top: 0, width: 0, height: 0 },
        computedStyle: null,
        isConnected:   false,
        offsetParent:  null
      };
    }
  });
  
  const result = performanceMonitor.end(perfHandle);
  logger.debug('Batched DOM reads complete', { 
    count: elements.length, 
    duration: result?.duration || 0,
    msPerElement: Math.round((result?.duration || 0) / elements.length * 100) / 100
  });
  
  return readings;
}

function yieldToMain() {
  if (typeof scheduler !== 'undefined' && scheduler.yield) {
    return scheduler.yield();
  }
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function _extractBatched(elements) {
  const batchSize         = get('extraction.batchSize');
  const perElementTimeout = get('extraction.perElementTimeout');
  const results        = [];

  logger.debug('Starting batched DOM reads...');
  const domReadings = batchDOMReads(elements);
  logger.debug('DOM reads complete, starting element processing...');

  for (let i = 0; i < elements.length; i += batchSize) {
    const batch = elements.slice(i, i + batchSize);
    const batchReadings = domReadings.slice(i, i + batchSize);

    const settled = await Promise.allSettled(
      batch.map((el, j) => _extractOne(el, i + j, batchReadings[j], perElementTimeout))
    );

    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) results.push(s.value);
    }

    if (i + batchSize < elements.length) {
      await yieldToMain();
    }
  }

  return results;
}

async function _extractOne(element, index, domReading, timeout) {
  const result = await safeExecute(
    () => _extractData(element, index, domReading),
    { timeout, operation: 'element-extraction' }
  );
  return result.success ? result.data : null;
}

async function _extractData(element, index, domReading) {
  const { rect, computedStyle } = domReading;

  const selectors  = await generateSelectors(element);
  const styles     = collectStylesFromComputed(computedStyle);
  const attributes = collectAttributes(element);
  const position   = calculatePositionFromRect(rect);
  const visibility = getVisibilityDataFromRect(element, rect, computedStyle);

  return {
    id:          `el-${index}`,
    index,
    tagName:     element.tagName,
    elementId:   element.id || null,
    className:   element.className || '',
    textContent: (element.textContent || '').trim().substring(0, TEXT_CONTENT_MAX_CHARS),
    selectors,
    styles,
    attributes,
    position,
    visibility
  };
}

export { extract };
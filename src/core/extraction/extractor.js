import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';
import { safeExecute } from '../../infrastructure/safe-execute.js';
import { generateSelectors } from '../selectors/selector-engine.js';
import { collectAttributes } from './attribute-collector.js';
import { shouldSkipElement } from './element-filters.js';
import { calculatePosition, getVisibilityData } from './position-calculator.js';
import { collectStyles } from './style-collector.js';

async function extract(filters = null) {
  const startTime = performance.now();
  logger.info('Starting extraction', { url: window.location.href, filters });

  try {
    let elements = filters && (filters.class || filters.id || filters.tag)
      ? _findFilteredElements(filters)
      : Array.from(document.querySelectorAll('*'));

    logger.debug(`${elements.length} raw elements`);

    elements = elements.filter(el => !shouldSkipElement(el));

    if (get('extraction.skipInvisible')) {
      elements = elements.filter(el => getVisibilityData(el).isVisible);
    }

    const max = get('extraction.maxElements');
    if (elements.length > max) {
      logger.warn(`Truncating to ${max} elements`);
      elements = elements.slice(0, max);
    }

    logger.debug(`${elements.length} elements queued for extraction`);

    const extracted = await _extractBatched(elements);
    const duration  = Math.round(performance.now() - startTime);

    logger.info('Extraction complete', { totalElements: extracted.length, duration });

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

async function _extractBatched(elements) {
  const batchSize      = get('extraction.batchSize');
  const perElementTimeout = get('extraction.perElementTimeout');
  const results        = [];

  for (let i = 0; i < elements.length; i += batchSize) {
    const batch = elements.slice(i, i + batchSize);

    const settled = await Promise.allSettled(
      batch.map((el, j) => _extractOne(el, i + j, perElementTimeout))
    );

    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) results.push(s.value);
    }

    if (i > 0 && i % 100 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  return results;
}

async function _extractOne(element, index, timeout) {
  const result = await safeExecute(
    () => _extractData(element, index),
    { timeout, operation: 'element-extraction' }
  );
  return result.success ? result.data : null;
}

async function _extractData(element, index) {
  const selectors  = await generateSelectors(element);
  const styles     = collectStyles(element);
  const attributes = collectAttributes(element);
  const position   = calculatePosition(element);
  const visibility = getVisibilityData(element);

  return {
    id:          `el-${index}`,
    index,
    tagName:     element.tagName,
    elementId:   element.id || null,
    className:   element.className || '',
    textContent: (element.textContent || '').trim().substring(0, 500),
    selectors,
    styles,
    attributes,
    position,
    visibility
  };
}

export { extract };
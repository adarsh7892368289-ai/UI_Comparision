import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';
import { safeExecute } from '../../infrastructure/safe-execute.js';
import { generateSelectors } from '../selectors/selector-engine.js';
import { collectAttributes } from './attribute-collector.js';
import { shouldSkipElement } from './filters/filter-engine.js';
import { calculatePosition, getVisibilityData } from './position-calculator.js';
import { collectStyles } from './style-collector.js';

async function extract(filters = null) {
  const startTime = performance.now();
  
  logger.info('Starting extraction', { 
    url: window.location.href,
    filters 
  });

  try {
    let processElements;

    if (filters && (filters.class || filters.id || filters.tag)) {
      processElements = findFilteredElements(filters);
      logger.debug(`${processElements.length} elements matched filters (including descendants)`);
    } else {
      const allElements = Array.from(document.querySelectorAll('*'));
      logger.debug(`Found ${allElements.length} total DOM elements`);
      processElements = allElements;
    }

    processElements = processElements.filter(el => !shouldSkipElement(el));
    logger.debug(`${processElements.length} elements after filtering irrelevant tags`);

    const skipInvisible = get('extraction.skipInvisible', true);
    if (skipInvisible) {
      processElements = processElements.filter(el => {
        const visibility = getVisibilityData(el);
        return visibility.isVisible;
      });
      logger.debug(`${processElements.length} visible elements`);
    }

    const maxElements = get('extraction.maxElements', 10000);
    if (processElements.length > maxElements) {
      logger.warn(`Truncating to ${maxElements} elements`);
      processElements = processElements.slice(0, maxElements);
    }

    const elements = await extractElementsData(processElements);

    const duration = performance.now() - startTime;
    logger.info('Extraction complete', { 
      totalElements: elements.length,
      duration: Math.round(duration)
    });

    return {
      url: window.location.href,
      title: document.title,
      timestamp: new Date().toISOString(),
      totalElements: elements.length,
      duration: Math.round(duration),
      filters: filters || null,
      elements
    };

  } catch (error) {
    logger.error('Extraction failed', { error: error.message });
    throw error;
  }
}

function findFilteredElements(filters) {
  const matchedElements = new Set();
  const { class: classFilter, id: idFilter, tag: tagFilter } = filters;

  if (classFilter) {
    const classes = classFilter.split(',').map(c => c.trim()).filter(c => c);
    for (const className of classes) {
      const selector = className.startsWith('.') ? className : `.${className}`;
      try {
        const matches = document.querySelectorAll(selector);
        for (const match of matches) {
          matchedElements.add(match);
          const descendants = match.querySelectorAll('*');
          for (const desc of descendants) {
            matchedElements.add(desc);
          }
        }
      } catch (error) {
        logger.warn('Invalid class selector', { className, error: error.message });
      }
    }
  }

  if (idFilter) {
    const ids = idFilter.split(',').map(i => i.trim()).filter(i => i);
    for (const id of ids) {
      const selector = id.startsWith('#') ? id : `#${id}`;
      try {
        const match = document.querySelector(selector);
        if (match) {
          matchedElements.add(match);
          const descendants = match.querySelectorAll('*');
          for (const desc of descendants) {
            matchedElements.add(desc);
          }
        }
      } catch (error) {
        logger.warn('Invalid ID selector', { id, error: error.message });
      }
    }
  }

  if (tagFilter) {
    const tags = tagFilter.split(',').map(t => t.trim()).filter(t => t);
    for (const tag of tags) {
      try {
        const matches = document.querySelectorAll(tag);
        for (const match of matches) {
          matchedElements.add(match);
          const descendants = match.querySelectorAll('*');
          for (const desc of descendants) {
            matchedElements.add(desc);
          }
        }
      } catch (error) {
        logger.warn('Invalid tag selector', { tag, error: error.message });
      }
    }
  }

  return Array.from(matchedElements);
}

async function extractElementsData(elements) {
  const batchSize = get('extraction.batchSize', 10);
  const perElementTimeout = get('extraction.perElementTimeout', 150);
  const results = [];

  for (let i = 0; i < elements.length; i += batchSize) {
    const batch = elements.slice(i, i + batchSize);
    
    const batchPromises = batch.map((element, batchIndex) => 
      extractElementData(element, i + batchIndex, perElementTimeout)
    );

    const batchResults = await Promise.allSettled(batchPromises);
    
    for (const result of batchResults) {
      if (result.status === 'fulfilled' && result.value) {
        results.push(result.value);
      }
    }

    if ((i + batchSize) % 100 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return results;
}

async function extractElementData(element, index, timeout) {
  const result = await safeExecute(
    () => extractElementDataUnsafe(element, index),
    { timeout, operation: 'element-extraction' }
  );

  if (result.success) {
    return result.data;
  }

  return null;
}

async function extractElementDataUnsafe(element, index) {
  const tagName = element.tagName;
  const elementId = element.id || null;
  const className = element.className || '';
  
  let textContent = '';
  if (element.textContent) {
    textContent = element.textContent.trim().substring(0, 500);
  }

  const styles = collectStyles(element);
  const attributes = collectAttributes(element);
  const position = calculatePosition(element);
  const visibility = getVisibilityData(element);
  const selectors = await generateSelectors(element);

  return {
    id: `el-${index}`,
    index,
    tagName,
    elementId,
    className,
    textContent,
    selectors,
    styles,
    attributes,
    position,
    visibility
  };
}

export { extract };

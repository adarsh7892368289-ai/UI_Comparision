import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';
import { generateCSS } from './css/generator.js';
import { generateXPath } from './xpath/generator.js';

class BoundedQueue {
  #concurrency;
  #queue;
  #active;

  constructor(concurrency) {
    this.#concurrency = concurrency;
    this.#queue = [];
    this.#active = 0;
  }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.#queue.push({ task, resolve, reject });
      this.#drain();
    });
  }

  #drain() {
    while (this.#active < this.#concurrency && this.#queue.length > 0) {
      const entry = this.#queue.shift();
      this.#active++;
      Promise.resolve()
        .then(() => entry.task())
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.#active--;
          this.#drain();
        });
    }
  }

  get size() {
    return this.#queue.length;
  }

  get activeCount() {
    return this.#active;
  }

  get pendingCount() {
    return this.#queue.length + this.#active;
  }
}

const NULL_SELECTORS = {
  xpath:          null,
  css:            null,
  xpathConfidence: 0,
  cssConfidence:   0,
  xpathStrategy:  null,
  cssStrategy:    null
};

function buildSelectors(xpathResult, cssResult) {
  return {
    xpath:           xpathResult?.xpath || null,
    css:             cssResult?.css || null,
    xpathConfidence: xpathResult?.confidence || 0,
    cssConfidence:   cssResult?.confidence || 0,
    xpathStrategy:   xpathResult?.strategy || null,
    cssStrategy:     cssResult?.strategy || null
  };
}

async function generateSelectors(element) {
  if (!element || !element.tagName) {
    logger.debug('Invalid element for selector generation');
    return { ...NULL_SELECTORS };
  }

  const parallel = get('selectors.xpath.parallelExecution', true) &&
                   get('selectors.css.parallelExecution', true);

  if (parallel) {
    const [xpathOutcome, cssOutcome] = await Promise.allSettled([
      generateXPath(element),
      generateCSS(element)
    ]);

    return buildSelectors(
      xpathOutcome.status === 'fulfilled' ? xpathOutcome.value : null,
      cssOutcome.status === 'fulfilled' ? cssOutcome.value : null
    );
  }

  const xpathResult = await generateXPath(element);
  const cssResult = await generateCSS(element);
  return buildSelectors(xpathResult, cssResult);
}

async function generateSelectorsForElements(elements) {
  const results = [];

  for (const element of elements) {
    try {
      const selectors = await generateSelectors(element);
      results.push(selectors);
    } catch (error) {
      logger.error('Selector generation failed for element', {
        tagName: element.tagName,
        error:   error.message
      });
      results.push({ ...NULL_SELECTORS });
    }
  }

  return results;
}

export { generateSelectors, generateSelectorsForElements, BoundedQueue };
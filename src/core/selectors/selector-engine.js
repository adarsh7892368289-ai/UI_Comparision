import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';
import { generateCSS } from './css/generator.js';
import { generateXPath } from './xpath/generator.js';

async function generateSelectors(element) {
  if (!element || !element.tagName) {
    logger.debug('Invalid element for selector generation');
    return {
      xpath: null,
      css: null,
      xpathConfidence: 0,
      cssConfidence: 0,
      xpathStrategy: null,
      cssStrategy: null
    };
  }

  const parallel = get('selectors.xpath.parallelExecution', true) && 
                   get('selectors.css.parallelExecution', true);

  let xpathResult, cssResult;

  if (parallel) {
    [xpathResult, cssResult] = await Promise.allSettled([
      generateXPath(element),
      generateCSS(element)
    ]);

    xpathResult = xpathResult.status === 'fulfilled' ? xpathResult.value : null;
    cssResult = cssResult.status === 'fulfilled' ? cssResult.value : null;
  } else {
    xpathResult = await generateXPath(element);
    cssResult = await generateCSS(element);
  }

  return {
    xpath: xpathResult?.xpath || null,
    css: cssResult?.css || null,
    xpathConfidence: xpathResult?.confidence || 0,
    cssConfidence: cssResult?.confidence || 0,
    xpathStrategy: xpathResult?.strategy || null,
    cssStrategy: cssResult?.strategy || null
  };
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
        error: error.message
      });
      results.push({
        xpath: null,
        css: null,
        xpathConfidence: 0,
        cssConfidence: 0,
        xpathStrategy: null,
        cssStrategy: null
      });
    }
  }

  return results;
}

export { generateSelectors, generateSelectorsForElements };

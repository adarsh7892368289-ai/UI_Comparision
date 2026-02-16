import { get } from '../../../config/defaults.js';
import { ERROR_CODES, errorTracker } from '../../../infrastructure/error-tracker.js';
import logger from '../../../infrastructure/logger.js';
import { safeExecute } from '../../../infrastructure/safe-execute.js';
import { getAllStrategies, TIER_ROBUSTNESS } from './strategies.js';
import { isUniqueCssSelector } from './validator.js';

async function generateCSS(element) {
  if (!element || !element.tagName) {
    logger.debug('Invalid element for CSS generation');
    return null;
  }

  const timeout = get('selectors.css.timeout', 300);
  const parallelExecution = get('selectors.css.parallelExecution', true);

  const result = await safeExecute(
    () => parallelExecution 
      ? generateCSSParallel(element) 
      : generateCSSSequential(element),
    { timeout, operation: 'css-generation' }
  );

  if (result.success && result.data) {
    return {
      css: result.data.selector,
      confidence: result.data.robustness,
      strategy: result.data.strategy
    };
  }

  return null;
}

async function generateCSSParallel(element) {
  const startTime = performance.now();
  const tag = element.tagName.toLowerCase();
  const strategies = getAllStrategies();
  const perStrategyTimeout = get('selectors.css.perStrategyTimeout', 30);

  const strategyPromises = strategies.map(({ tier, fn, name }) => 
    executeStrategy(element, tag, tier, fn, name, perStrategyTimeout)
  );

  try {
    const result = await Promise.race(
      strategyPromises.filter(p => p !== null)
    );

    if (result) {
      const duration = performance.now() - startTime;
      logger.debug('CSS selector generated (parallel)', { 
        selector: result.selector, 
        strategy: result.strategy, 
        tier: result.tier,
        robustness: result.robustness,
        duration: Math.round(duration)
      });
      return result;
    }
  } catch (error) {
    logger.warn('Parallel CSS generation failed', { error: error.message });
  }

  const fallback = generateFallbackCSS(element, tag);
  if (fallback) return fallback;

  errorTracker.track({
    code: ERROR_CODES.CSS_GENERATION_FAILED,
    message: 'No valid CSS selector found',
    context: { tagName: element.tagName, id: element.id }
  });

  return null;
}

async function executeStrategy(element, tag, tier, strategyFn, strategyName, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);

    try {
      const candidates = strategyFn(element, tag);
      
      if (!candidates || candidates.length === 0) {
        clearTimeout(timer);
        resolve(null);
        return;
      }

      for (const candidate of candidates) {
        if (!candidate?.selector) continue;

        if (isUniqueCssSelector(candidate.selector, element)) {
          clearTimeout(timer);
          resolve({
            selector: candidate.selector,
            strategy: strategyName,
            tier,
            robustness: TIER_ROBUSTNESS[tier] || 50
          });
          return;
        }
      }

      clearTimeout(timer);
      resolve(null);
    } catch (error) {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

function generateCSSSequential(element) {
  const startTime = performance.now();
  const tag = element.tagName.toLowerCase();
  const strategies = getAllStrategies();
  const totalTimeout = get('selectors.css.timeout', 300);

  for (const { tier, fn, name } of strategies) {
    if (performance.now() - startTime > totalTimeout) {
      logger.debug('CSS timeout reached');
      break;
    }

    try {
      const candidates = fn(element, tag);
      if (!candidates || candidates.length === 0) continue;

      for (const candidate of candidates) {
        if (!candidate?.selector) continue;

        if (isUniqueCssSelector(candidate.selector, element)) {
          const duration = performance.now() - startTime;
          logger.debug('CSS selector generated (sequential)', {
            selector: candidate.selector,
            strategy: name,
            tier,
            robustness: TIER_ROBUSTNESS[tier] || 50,
            duration: Math.round(duration)
          });

          return {
            selector: candidate.selector,
            strategy: name,
            tier,
            robustness: TIER_ROBUSTNESS[tier] || 50
          };
        }
      }
    } catch (error) {
      continue;
    }
  }

  const fallback = generateFallbackCSS(element, tag);
  if (fallback) return fallback;

  return null;
}

function generateFallbackCSS(element, tag) {
  const allElements = Array.from(document.querySelectorAll(tag));
  const index = allElements.indexOf(element);

  if (index !== -1) {
    const selector = `${tag}:nth-of-type(${index + 1})`;
    
    if (isUniqueCssSelector(selector, element)) {
      logger.debug('CSS via fallback', { selector });
      return {
        selector,
        strategy: 'fallback-nth',
        tier: 10,
        robustness: TIER_ROBUSTNESS[10] || 19
      };
    }
  }

  return null;
}

export { generateCSS };

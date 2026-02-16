import { get } from '../../../config/defaults.js';
import { ERROR_CODES, errorTracker } from '../../../infrastructure/error-tracker.js';
import logger from '../../../infrastructure/logger.js';
import { safeExecute } from '../../../infrastructure/safe-execute.js';
import { getUniversalTag } from '../../../shared/dom-utils.js';
import { getAllStrategies, TIER_ROBUSTNESS } from './strategies.js';
import {
    countXPathMatches,
    ensureUniqueness,
    isUniqueXPath,
    xpathPointsToElement
} from './validator.js';

async function generateXPath(element) {
  if (!element || !element.tagName) {
    logger.debug('Invalid element for XPath generation');
    return null;
  }

  const timeout = get('selectors.xpath.timeout', 500);
  const parallelExecution = get('selectors.xpath.parallelExecution', true);

  const result = await safeExecute(
    () => parallelExecution 
      ? generateXPathParallel(element) 
      : generateXPathSequential(element),
    { timeout, operation: 'xpath-generation' }
  );

  if (result.success && result.data) {
    return {
      xpath: result.data.xpath,
      confidence: result.data.robustness,
      strategy: result.data.strategy
    };
  }

  return null;
}

async function generateXPathParallel(element) {
  const startTime = performance.now();
  const tag = getUniversalTag(element);
  const strategies = getAllStrategies();
  const perStrategyTimeout = get('selectors.xpath.perStrategyTimeout', 50);

  const strategyPromises = strategies.map(({ tier, fn, name }) => 
    executeStrategy(element, tag, tier, fn, name, perStrategyTimeout)
  );

  try {
    const result = await Promise.race(
      strategyPromises.filter(p => p !== null)
    );

    if (result) {
      const duration = performance.now() - startTime;
      logger.debug('XPath generated (parallel)', { 
        xpath: result.xpath, 
        strategy: result.strategy, 
        tier: result.tier,
        robustness: result.robustness,
        duration: Math.round(duration)
      });
      return result;
    }
  } catch (error) {
    logger.warn('Parallel XPath generation failed', { error: error.message });
  }

  const fallback = generateFallbackXPath(element, tag);
  if (fallback) return fallback;

  errorTracker.track({
    code: ERROR_CODES.XPATH_GENERATION_FAILED,
    message: 'No valid XPath found',
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
        if (!candidate?.xpath) continue;

        const pointsToTarget = xpathPointsToElement(candidate.xpath, element);
        if (!pointsToTarget) continue;

        const matchCount = countXPathMatches(candidate.xpath);
        if (matchCount === 0) continue;

        let finalXPath = candidate.xpath;

        if (matchCount > 1) {
          finalXPath = ensureUniqueness(candidate.xpath, element);
          
          if (!isUniqueXPath(finalXPath, element)) continue;
        }

        clearTimeout(timer);
        resolve({
          xpath: finalXPath,
          strategy: strategyName,
          tier,
          robustness: TIER_ROBUSTNESS[tier] || 50
        });
        return;
      }

      clearTimeout(timer);
      resolve(null);
    } catch (error) {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

function generateXPathSequential(element) {
  const startTime = performance.now();
  const tag = getUniversalTag(element);
  const strategies = getAllStrategies();
  const totalTimeout = get('selectors.xpath.timeout', 500);

  for (const { tier, fn, name } of strategies) {
    if (performance.now() - startTime > totalTimeout) {
      logger.debug('XPath timeout reached');
      break;
    }

    try {
      const candidates = fn(element, tag);
      if (!candidates || candidates.length === 0) continue;

      for (const candidate of candidates) {
        if (!candidate?.xpath) continue;

        if (!xpathPointsToElement(candidate.xpath, element)) continue;

        const matchCount = countXPathMatches(candidate.xpath);
        if (matchCount === 0) continue;

        let finalXPath = candidate.xpath;

        if (matchCount > 1) {
          finalXPath = ensureUniqueness(candidate.xpath, element);
          if (!isUniqueXPath(finalXPath, element)) continue;
        }

        const duration = performance.now() - startTime;
        logger.debug('XPath generated (sequential)', {
          xpath: finalXPath,
          strategy: name,
          tier,
          robustness: TIER_ROBUSTNESS[tier] || 50,
          duration: Math.round(duration)
        });

        return {
          xpath: finalXPath,
          strategy: name,
          tier,
          robustness: TIER_ROBUSTNESS[tier] || 50
        };
      }
    } catch (error) {
      continue;
    }
  }

  const fallback = generateFallbackXPath(element, tag);
  if (fallback) return fallback;

  return null;
}

function generateFallbackXPath(element, tag) {
  const allElements = Array.from(document.querySelectorAll('*'));
  const index = allElements.indexOf(element);

  if (index !== -1) {
    const xpath = `(//*)[${index + 1}]`;
    
    if (isUniqueXPath(xpath, element)) {
      logger.debug('XPath via fallback', { xpath });
      return {
        xpath,
        strategy: 'fallback-index',
        tier: 22,
        robustness: TIER_ROBUSTNESS[22] || 30
      };
    }
  }

  return null;
}

export { generateXPath };

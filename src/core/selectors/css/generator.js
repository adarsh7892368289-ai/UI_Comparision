import { get } from '../../../config/defaults.js';
import logger from '../../../infrastructure/logger.js';
import { getAllStrategies, TIER_ROBUSTNESS } from './strategies.js';
import { isUniqueCssSelector, isValidCssSelector } from './validator.js';

/**
 * Generate the best CSS selector for an element.
 *
 * Same tiered sequential approach as XPath generator.
 * Uses Promise.allSettled (not race) within each tier group.
 */
async function generateCSS(element) {
  if (!element || !element.tagName) {
    return _buildFallback(element);
  }

  const tag = element.tagName.toLowerCase();
  const perStrategyTimeout = get('selectors.css.perStrategyTimeout', 50);
  const strategies = getAllStrategies();

  const tierGroups = [
    strategies.filter(s => s.tier <= 4),
    strategies.filter(s => s.tier >= 5 && s.tier <= 7),
    strategies.filter(s => s.tier >= 8 && s.tier <= 10),
  ];

  for (const group of tierGroups) {
    const result = await _tryGroup(element, tag, group, perStrategyTimeout);
    if (result) {
      logger.debug('CSS generated', {
        css: result.selector,
        strategy: result.strategy,
        tier: result.tier
      });
      return {
        css:        result.selector,
        confidence: TIER_ROBUSTNESS[result.tier] || 50,
        strategy:   result.strategy
      };
    }
  }

  logger.debug('CSS: semantic strategies exhausted, using positional fallback', {
    tag: element.tagName
  });
  return _buildFallback(element);
}

async function _tryGroup(element, tag, strategies, timeout) {
  const settled = await Promise.allSettled(
    strategies.map(({ tier, fn, name }) =>
      _runStrategy(element, tag, tier, fn, name, timeout)
    )
  );

  const successes = settled
    .filter(s => s.status === 'fulfilled' && s.value !== null)
    .map(s => s.value);

  if (successes.length === 0) return null;
  successes.sort((a, b) => a.tier - b.tier);
  return successes[0];
}

function _runStrategy(element, tag, tier, fn, name, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);

    try {
      const candidates = fn(element, tag);

      if (!candidates || candidates.length === 0) {
        clearTimeout(timer);
        resolve(null);
        return;
      }

      for (const candidate of candidates) {
        if (!candidate || !candidate.selector) continue;
        if (!isValidCssSelector(candidate.selector)) continue;

        if (isUniqueCssSelector(candidate.selector, element)) {
          clearTimeout(timer);
          resolve({
            selector:   candidate.selector,
            strategy:   name,
            tier,
            robustness: TIER_ROBUSTNESS[tier] || 50
          });
          return;
        }
      }

      clearTimeout(timer);
      resolve(null);
    } catch (err) {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

function _buildFallback(element) {
  return {
    css:        _buildPositionPath(element),
    confidence: 30,
    strategy:   'fallback-position'
  };
}

function _buildPositionPath(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return 'html';

  const path = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const parent = current.parentElement;
    const tag = current.tagName.toLowerCase();

    if (!parent) {
      path.unshift(tag);
      break;
    }

    // Stop at stable ID anchor
    if (current.id) {
      const id = current.id;
      const isStable = !/(-\d{2,}$|^\d+$|[a-f0-9]{8}-[a-f0-9]{4})/.test(id);
      if (isStable) {
        const escaped = CSS.escape ? CSS.escape(id) : id.replace(/([#.[\]:()])/g, '\\$1');
        path.unshift(`${tag}#${escaped}`);
        break;
      }
    }

    const sameTag = Array.from(parent.children).filter(c => c.tagName === current.tagName);
    if (sameTag.length === 1) {
      path.unshift(tag);
    } else {
      const idx = sameTag.indexOf(current) + 1;
      path.unshift(`${tag}:nth-of-type(${idx})`);
    }

    current = parent;
  }

  return path.join(' > ');
}

export { generateCSS };

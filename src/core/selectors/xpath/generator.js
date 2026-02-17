import { get } from '../../../config/defaults.js';
import logger from '../../../infrastructure/logger.js';
import { getUniversalTag } from '../../../shared/dom-utils.js';
import { getAllStrategies, TIER_ROBUSTNESS } from './strategies.js';
import {
  countXPathMatches,
  ensureUniqueness,
  isUniqueXPath
} from './validator.js';

/**
 * Generate the best XPath for an element.
 *
 * Architecture: Tiered sequential execution.
 *
 *   Group 1 (tiers 0-5):  Best quality — text, IDs, test attrs, data attrs
 *   Group 2 (tiers 6-10): Context — ancestors, siblings, form inputs
 *   Group 3 (tiers 11-15): Structural — aria, partial text, classes, paths
 *   Group 4 (tiers 16-21): Position — role, href, nth-child, absolute path
 *   Fallback:              Guaranteed position path (never returns null)
 *
 * Tier 22 (global index — (//*)[N]) is EXCLUDED from all groups.
 * It is replaced by _buildPositionPath which gives /tag[N]/tag[N] style paths
 * that survive DOM shuffles better.
 *
 * Validation order fix:
 *   OLD (BROKEN): xpathPointsToElement FIRST → skips non-first matches of non-unique selectors
 *   NEW (FIXED):  countMatches FIRST → if count > 1 call ensureUniqueness → then validate
 */
async function generateXPath(element) {
  if (!element || !element.tagName) {
    return _buildFallback(element);
  }

  const tag = getUniversalTag(element);
  const perStrategyTimeout = get('selectors.xpath.perStrategyTimeout', 80);
  const strategies = getAllStrategies();

  // Tier groups — processed sequentially, strategies within a group run in parallel
  const tierGroups = [
    strategies.filter(s => s.tier <= 5),
    strategies.filter(s => s.tier >= 6  && s.tier <= 10),
    strategies.filter(s => s.tier >= 11 && s.tier <= 15),
    strategies.filter(s => s.tier >= 16 && s.tier <= 21),
  ];

  for (const group of tierGroups) {
    const result = await _tryGroup(element, tag, group, perStrategyTimeout);
    if (result) {
      logger.debug('XPath generated', {
        xpath: result.xpath,
        strategy: result.strategy,
        tier: result.tier,
        confidence: TIER_ROBUSTNESS[result.tier] || 50
      });
      return {
        xpath:      result.xpath,
        confidence: TIER_ROBUSTNESS[result.tier] || 50,
        strategy:   result.strategy
      };
    }
  }

  logger.debug('XPath: semantic strategies exhausted, using positional fallback', {
    tag: element.tagName
  });
  return _buildFallback(element);
}

/**
 * Run all strategies in a group concurrently.
 * Collect every successful candidate, then return the one with lowest tier number.
 *
 * Using Promise.allSettled (NOT Promise.race) so we see all results and pick
 * the best-quality one, not whichever resolved first.
 */
async function _tryGroup(element, tag, strategies, perStrategyTimeout) {
  const settled = await Promise.allSettled(
    strategies.map(({ tier, fn, name }) =>
      _runStrategy(element, tag, tier, fn, name, perStrategyTimeout)
    )
  );

  const successes = settled
    .filter(s => s.status === 'fulfilled' && s.value !== null)
    .map(s => s.value);

  if (successes.length === 0) return null;

  // Return best quality (lowest tier = highest priority)
  successes.sort((a, b) => a.tier - b.tier);
  return successes[0];
}

/**
 * Execute one strategy, validate its candidates, return first valid unique xpath or null.
 *
 * Validation order (FIXED):
 *   1. Get candidates from strategy
 *   2. Count document matches for each candidate
 *   3a. If count === 1 → verify it IS our element, done
 *   3b. If count  >  1 → call ensureUniqueness to add [N] predicate → verify unique
 *   4. If count === 0 → xpath is broken, skip
 */
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
        if (!candidate || !candidate.xpath) continue;

        const matchCount = countXPathMatches(candidate.xpath);

        // XPath is syntactically broken or matches nothing
        if (matchCount === 0) continue;

        let finalXPath = candidate.xpath;

        if (matchCount === 1) {
          // Unique — just confirm it is our element
          // Use countXPathMatches + snapshot check via isUniqueXPath
          if (!isUniqueXPath(finalXPath, element)) continue;
        } else {
          // Multiple matches — disambiguate by adding [N] positional predicate
          finalXPath = ensureUniqueness(candidate.xpath, element);
          // Verify the result is now unique and points to the right element
          if (!isUniqueXPath(finalXPath, element)) continue;
        }

        clearTimeout(timer);
        resolve({
          xpath:     finalXPath,
          strategy:  name,
          tier,
          robustness: TIER_ROBUSTNESS[tier] || 50
        });
        return;
      }

      clearTimeout(timer);
      resolve(null);
    } catch (err) {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/**
 * Guaranteed positional fallback — builds /html/body/div[2]/span[1] paths.
 * Uses same-tag sibling count so the XPath semantics are correct.
 * NEVER returns null.
 */
function _buildFallback(element) {
  return {
    xpath:      _buildPositionPath(element),
    confidence: 30,
    strategy:   'fallback-position'
  };
}

function _buildPositionPath(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return '/html';

  const path = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const parent = current.parentElement;
    const currTag = getUniversalTag(current);

    if (!parent) {
      path.unshift(currTag);
      break;
    }

    // XPath position() predicates count only same-tag siblings
    const sameTag = Array.from(parent.children).filter(c => c.tagName === current.tagName);

    if (sameTag.length === 1) {
      path.unshift(currTag);
    } else {
      const idx = sameTag.indexOf(current) + 1;
      path.unshift(`${currTag}[${idx}]`);
    }

    current = parent;
  }

  return path.length > 0 ? `/${path.join('/')}` : '/html';
}

export { generateXPath };

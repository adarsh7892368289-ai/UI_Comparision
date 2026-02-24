import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';

const CaptureQuality = Object.freeze({
  STABLE:   'STABLE',
  DEGRADED: 'DEGRADED'
});

// CSS selector delegated to the browser's C++ selector engine.
// querySelector short-circuits on first match — O(k) where k is the
// position of the first match.  No JS object allocation per element.
// Replaces the previous querySelectorAll('*') + JS regex loop.
const SKELETON_CSS =
  '[class*="skeleton"],[class*="shimmer"],[class*="placeholder"],[class*="loading"],[class*="spinner"]';

function hasUnloadedImages() {
  const images = document.querySelectorAll('img');
  for (const img of images) {
    if (!img.complete) {
      return true;
    }
  }
  return false;
}

function hasSkeletonElements() {
  return document.querySelector(SKELETON_CSS) !== null;
}

function isDocumentReady() {
  return !hasUnloadedImages() && !hasSkeletonElements();
}

function waitForReadiness() {
  return new Promise(resolve => {
    const stabilityWindowMs = get('extraction.stabilityWindowMs');
    const hardTimeoutMs     = get('extraction.hardTimeoutMs');

    let stabilityTimer = null;
    let hardTimer      = null;
    let observer       = null;

    function cleanup() {
      clearTimeout(hardTimer);
      clearTimeout(stabilityTimer);
      if (observer) {
        observer.disconnect();
      }
    }

    function settle(quality) {
      cleanup();
      resolve(quality);
    }

    function checkAndSettle() {
      if (!isDocumentReady()) {
        return;
      }
      logger.debug('Readiness gate cleared', { quality: CaptureQuality.STABLE });
      settle(CaptureQuality.STABLE);
    }

    function scheduleCheck() {
      clearTimeout(stabilityTimer);
      stabilityTimer = setTimeout(checkAndSettle, stabilityWindowMs);
    }

    observer = new MutationObserver(scheduleCheck);

    hardTimer = setTimeout(() => {
      logger.warn('Readiness gate hard timeout', { quality: CaptureQuality.DEGRADED });
      settle(CaptureQuality.DEGRADED);
    }, hardTimeoutMs);

    observer.observe(document.documentElement, {
      childList:      true,
      subtree:        true,
      attributes:     false,
      characterData:  false
    });

    scheduleCheck();
  });
}

export { waitForReadiness, CaptureQuality };
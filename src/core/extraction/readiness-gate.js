import logger from '../../infrastructure/logger.js';
import { hasSkeleton } from './element-classifier.js';

const STABILITY_WINDOW_MS = 500;
const HARD_TIMEOUT_MS = 5000;

const CaptureQuality = Object.freeze({
  STABLE: 'STABLE',
  DEGRADED: 'DEGRADED'
});

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
  const allElements = document.querySelectorAll('*');
  for (const el of allElements) {
    if (hasSkeleton(el)) {
      return true;
    }
  }
  return false;
}

function isDocumentReady() {
  return !hasUnloadedImages() && !hasSkeletonElements();
}

function waitForReadiness() {
  return new Promise(resolve => {
    performance.mark('readiness-gate-start');

    const hardDeadline = setTimeout(() => {
      teardown();
      performance.mark('readiness-gate-end');
      performance.measure('readiness-gate', 'readiness-gate-start', 'readiness-gate-end');
      logger.warn('Readiness gate hard timeout — proceeding with DEGRADED quality', {
        url: window.location.href
      });
      resolve(CaptureQuality.DEGRADED);
    }, HARD_TIMEOUT_MS);

    let stabilityTimer = null;

    const onStable = () => {
      if (!isDocumentReady()) {
        return;
      }
      teardown();
      performance.mark('readiness-gate-end');
      performance.measure('readiness-gate', 'readiness-gate-start', 'readiness-gate-end');
      logger.debug('Readiness gate cleared', { url: window.location.href });
      resolve(CaptureQuality.STABLE);
    };

    const resetStabilityTimer = () => {
      clearTimeout(stabilityTimer);
      stabilityTimer = setTimeout(onStable, STABILITY_WINDOW_MS);
    };

    const observer = new MutationObserver(resetStabilityTimer);

    const teardown = () => {
      clearTimeout(hardDeadline);
      clearTimeout(stabilityTimer);
      observer.disconnect();
    };

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });

    resetStabilityTimer();
  });
}

export { waitForReadiness, CaptureQuality };
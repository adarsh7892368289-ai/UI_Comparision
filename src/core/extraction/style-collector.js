import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';

const INITIAL_SENTINEL = '__initial__';

const CONTEXT_SNAPSHOT_PROPERTIES = Object.freeze([
  'font-size',
  'line-height',
  'width',
  'height'
]);

function collectStylesFromComputed(computedStyle) {
  if (!computedStyle) {
    return {};
  }

  try {
    const properties = get('extraction.cssProperties', []);
    const styles = {};

    for (const prop of properties) {
      const value = computedStyle.getPropertyValue(prop);
      styles[prop] = value === '' ? INITIAL_SENTINEL : value.trim();
    }

    return styles;
  } catch (error) {
    logger.error('Style collection from computed failed', { error: error.message });
    return {};
  }
}

function buildContextSnapshot(computedStyle, rect, scrollX, scrollY) {
  if (!computedStyle) {
    return null;
  }

  const snapshot = {
    fontSize: computedStyle.getPropertyValue('font-size'),
    lineHeight: computedStyle.getPropertyValue('line-height'),
    parentFontSize: null,
    parentWidth: null,
    parentHeight: null,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollX,
    scrollY,
    boundingRect: {
      x: rect.x + scrollX,
      y: rect.y + scrollY,
      width: rect.width,
      height: rect.height
    }
  };

  return snapshot;
}

function enrichContextSnapshotWithParent(snapshot, parentComputedStyle) {
  if (!snapshot || !parentComputedStyle) {
    return snapshot;
  }
  return {
    ...snapshot,
    parentFontSize: parentComputedStyle.getPropertyValue('font-size'),
    parentWidth: parentComputedStyle.getPropertyValue('width'),
    parentHeight: parentComputedStyle.getPropertyValue('height')
  };
}

export { collectStylesFromComputed, buildContextSnapshot, enrichContextSnapshotWithParent, INITIAL_SENTINEL };
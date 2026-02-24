import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';

function collectStylesFromComputed(computedStyle) {
  if (!computedStyle) {
    return {};
  }

  const properties = get('extraction.cssProperties', []);
  const sentinel = get('extraction.initialValueSentinel');

  try {
    const styles = {};
    for (const prop of properties) {
      const value = computedStyle.getPropertyValue(prop);
      styles[prop] = value === '' ? sentinel : value.trim();
    }
    return styles;
  } catch (err) {
    logger.error('Style collection failed', { error: err.message });
    return {};
  }
}

function buildContextSnapshot(computedStyle, rect, scrollX, scrollY, parentComputedStyle, rootFontSize) {
  const safeRead = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };

  return {
    fontSize:       safeRead(() => computedStyle?.getPropertyValue('font-size')) ?? null,
    lineHeight:     safeRead(() => computedStyle?.getPropertyValue('line-height')) ?? null,
    parentFontSize: safeRead(() => parentComputedStyle?.fontSize) ?? '16px',
    parentWidth:    safeRead(() => parentComputedStyle?.width) ?? '0px',
    parentHeight:   safeRead(() => parentComputedStyle?.height) ?? '0px',
    rootFontSize:   rootFontSize ?? '16px',
    viewportWidth:  window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollX,
    scrollY,
    boundingRect: rect
      ? {
        x:      rect.x + scrollX,
        y:      rect.y + scrollY,
        width:  rect.width,
        height: rect.height
      }
      : null
  };
}

export { collectStylesFromComputed, buildContextSnapshot };
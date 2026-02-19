import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';

function collectStyles(element) {
  try {
    const computed = window.getComputedStyle(element);
    return collectStylesFromComputed(computed);
  } catch (error) {
    logger.error('Style collection failed', { 
      tagName: element.tagName,
      error: error.message 
    });
    return {};
  }
}

function collectStylesFromComputed(computedStyle) {
  try {
    if (!computedStyle) return {};
    
    const properties = get('extraction.cssProperties', []);
    const styles = {};

    for (const prop of properties) {
      const value = computedStyle.getPropertyValue(prop);
      if (value) {
        styles[prop] = value;
      }
    }

    return styles;
  } catch (error) {
    logger.error('Style collection from computed failed', { error: error.message });
    return {};
  }
}

function isElementVisible(element) {
  try {
    const computed = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      computed.display !== 'none' &&
      computed.visibility !== 'hidden' &&
      parseFloat(computed.opacity) > 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  } catch (error) {
    return false;
  }
}

export { collectStyles, collectStylesFromComputed, isElementVisible };
import logger from '../../infrastructure/logger.js';

function calculatePosition(element) {
  try {
    const rect = element.getBoundingClientRect();
    return calculatePositionFromRect(rect);
  } catch (error) {
    logger.error('Position calculation failed', { 
      tagName: element.tagName,
      error: error.message 
    });
    return { x: 0, y: 0, width: 0, height: 0 };
  }
}

function calculatePositionFromRect(rect) {
  const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
  const scrollY = window.pageYOffset || document.documentElement.scrollTop;

  return {
    x:      Math.round(rect.left + scrollX),
    y:      Math.round(rect.top + scrollY),
    width:  Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function getVisibilityData(element) {
  try {
    const computed = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return getVisibilityDataFromRect(element, rect, computed);
  } catch (error) {
    return {
      isVisible:  false,
      display:    'none',
      visibility: 'hidden',
      opacity:    '0'
    };
  }
}

function getVisibilityDataFromRect(element, rect, computedStyle) {
  try {
    const isVisible = (
      computedStyle.display !== 'none' &&
      computedStyle.visibility !== 'hidden' &&
      parseFloat(computedStyle.opacity) > 0 &&
      rect.width > 0 &&
      rect.height > 0
    );

    return {
      isVisible,
      display:    computedStyle.display,
      visibility: computedStyle.visibility,
      opacity:    computedStyle.opacity
    };
  } catch (error) {
    return {
      isVisible:  false,
      display:    'none',
      visibility: 'hidden',
      opacity:    '0'
    };
  }
}

function isInViewport(element) {
  const rect = element.getBoundingClientRect();
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
  );
}

export { 
  calculatePosition, 
  calculatePositionFromRect,
  getVisibilityData,
  getVisibilityDataFromRect,
  isInViewport 
};
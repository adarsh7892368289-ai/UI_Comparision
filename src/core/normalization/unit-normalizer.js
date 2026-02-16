import logger from '../../infrastructure/logger.js';

const CONTEXT_DEPENDENT_UNITS = ['em', 'rem', '%', 'vw', 'vh', 'vmin', 'vmax'];

function isContextDependent(value) {
  if (!value || typeof value !== 'string') return false;
  
  const trimmed = value.trim().toLowerCase();
  return CONTEXT_DEPENDENT_UNITS.some(unit => trimmed.includes(unit));
}

function normalizeUnit(value, property, element) {
  if (!value || typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim().toLowerCase();

  if (trimmed === 'auto' || trimmed === 'none' || trimmed === 'initial' || 
      trimmed === 'inherit' || trimmed === 'unset') {
    return trimmed;
  }

  if (trimmed === '0' || trimmed === '0px') {
    return '0px';
  }

  const match = trimmed.match(/^([-+]?\d*\.?\d+)([a-z%]+)?$/);
  if (!match) {
    return value;
  }

  const numValue = parseFloat(match[1]);
  const unit = match[2] || '';

  if (!unit) {
    return `${numValue.toFixed(2)}px`;
  }

  switch (unit) {
    case 'px':
      return `${numValue.toFixed(2)}px`;

    case 'em':
      return emToPx(numValue, element);

    case 'rem':
      return remToPx(numValue);

    case '%':
      return percentToPx(numValue, property, element);

    case 'vw':
      return vwToPx(numValue);

    case 'vh':
      return vhToPx(numValue);

    case 'vmin':
      return vminToPx(numValue);

    case 'vmax':
      return vmaxToPx(numValue);

    case 'pt':
      return `${(numValue * 1.333333).toFixed(2)}px`;

    case 'pc':
      return `${(numValue * 16).toFixed(2)}px`;

    case 'in':
      return `${(numValue * 96).toFixed(2)}px`;

    case 'cm':
      return `${(numValue * 37.7952755906).toFixed(2)}px`;

    case 'mm':
      return `${(numValue * 3.77952755906).toFixed(2)}px`;

    case 'q':
      return `${(numValue * 0.94488188976).toFixed(2)}px`;

    default:
      return value;
  }
}

function emToPx(value, element) {
  if (!element) {
    return `${(value * 16).toFixed(2)}px`;
  }

  try {
    const parent = element.parentElement;
    if (!parent) {
      return `${(value * 16).toFixed(2)}px`;
    }

    const parentFontSize = window.getComputedStyle(parent).fontSize;
    const parentPx = parseFloat(parentFontSize);
    
    return `${(value * parentPx).toFixed(2)}px`;
  } catch (error) {
    logger.warn('Failed to convert em to px', { error: error.message });
    return `${(value * 16).toFixed(2)}px`;
  }
}

function remToPx(value) {
  try {
    const rootFontSize = window.getComputedStyle(document.documentElement).fontSize;
    const rootPx = parseFloat(rootFontSize);
    
    return `${(value * rootPx).toFixed(2)}px`;
  } catch (error) {
    logger.warn('Failed to convert rem to px', { error: error.message });
    return `${(value * 16).toFixed(2)}px`;
  }
}

function percentToPx(value, property, element) {
  if (!element) {
    return `${value.toFixed(2)}%`;
  }

  try {
    const parent = element.parentElement;
    if (!parent) {
      return `${value.toFixed(2)}%`;
    }

    const computed = window.getComputedStyle(parent);
    let referenceValue;

    if (property.includes('width') || property.includes('left') || property.includes('right')) {
      referenceValue = parseFloat(computed.width);
    } else if (property.includes('height') || property.includes('top') || property.includes('bottom')) {
      referenceValue = parseFloat(computed.height);
    } else if (property.includes('font')) {
      referenceValue = parseFloat(computed.fontSize);
    } else {
      return `${value.toFixed(2)}%`;
    }

    return `${((value / 100) * referenceValue).toFixed(2)}px`;
  } catch (error) {
    logger.warn('Failed to convert % to px', { error: error.message });
    return `${value.toFixed(2)}%`;
  }
}

function vwToPx(value) {
  const vw = window.innerWidth / 100;
  return `${(value * vw).toFixed(2)}px`;
}

function vhToPx(value) {
  const vh = window.innerHeight / 100;
  return `${(value * vh).toFixed(2)}px`;
}

function vminToPx(value) {
  const vmin = Math.min(window.innerWidth, window.innerHeight) / 100;
  return `${(value * vmin).toFixed(2)}px`;
}

function vmaxToPx(value) {
  const vmax = Math.max(window.innerWidth, window.innerHeight) / 100;
  return `${(value * vmax).toFixed(2)}px`;
}

export { normalizeUnit, isContextDependent };
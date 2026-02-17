import { get } from '../../config/defaults.js';
import  logger  from '../../infrastructure/logger.js';

// Read rounding precision from config — was hardcoded as 2 everywhere
const DECIMALS = get('normalization.rounding.decimals', 2);

// Helper — all numeric→px conversions go through here
function px(value) {
  return `${value.toFixed(DECIMALS)}px`;
}

function pct(value) {
  return `${value.toFixed(DECIMALS)}%`;
}

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
    return px(numValue);
  }

  switch (unit) {
    case 'px':
      return px(numValue);

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
      return px((numValue * 1.333333));

    case 'pc':
      return px((numValue * 16));

    case 'in':
      return px((numValue * 96));

    case 'cm':
      return px((numValue * 37.7952755906));

    case 'mm':
      return px((numValue * 3.77952755906));

    case 'q':
      return px((numValue * 0.94488188976));

    default:
      return value;
  }
}

function emToPx(value, element) {
  if (!element) {
    return px((value * 16));
  }

  try {
    const parent = element.parentElement;
    if (!parent) {
      return px((value * 16));
    }

    const parentFontSize = window.getComputedStyle(parent).fontSize;
    const parentPx = parseFloat(parentFontSize);
    
    return px((value * parentPx));
  } catch (error) {
    logger.warn('Failed to convert em to px', { error: error.message });
    return px((value * 16));
  }
}

function remToPx(value) {
  try {
    const rootFontSize = window.getComputedStyle(document.documentElement).fontSize;
    const rootPx = parseFloat(rootFontSize);
    
    return px((value * rootPx));
  } catch (error) {
    logger.warn('Failed to convert rem to px', { error: error.message });
    return px((value * 16));
  }
}

function percentToPx(value, property, element) {
  if (!element) {
    return pct(value);
  }

  try {
    const parent = element.parentElement;
    if (!parent) {
      return pct(value);
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
      return pct(value);
    }

    return px(((value / 100) * referenceValue));
  } catch (error) {
    logger.warn('Failed to convert % to px', { error: error.message });
    return pct(value);
  }
}

function vwToPx(value) {
  const vw = window.innerWidth / 100;
  return px((value * vw));
}

function vhToPx(value) {
  const vh = window.innerHeight / 100;
  return px((value * vh));
}

function vminToPx(value) {
  const vmin = Math.min(window.innerWidth, window.innerHeight) / 100;
  return px((value * vmin));
}

function vmaxToPx(value) {
  const vmax = Math.max(window.innerWidth, window.innerHeight) / 100;
  return px((value * vmax));
}

export { normalizeUnit, isContextDependent };
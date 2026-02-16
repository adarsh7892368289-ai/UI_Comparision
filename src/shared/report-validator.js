import logger from '../infrastructure/logger.js';

function isValidReport(report) {
  if (!report || typeof report !== 'object') {
    return { valid: false, errors: ['Report must be an object'] };
  }

  const errors = [];

  if (!report.id || typeof report.id !== 'string') {
    errors.push('Missing or invalid report ID');
  }

  if (!report.version || typeof report.version !== 'string') {
    errors.push('Missing or invalid version');
  }

  if (!report.url || typeof report.url !== 'string') {
    errors.push('Missing or invalid URL');
  }

  if (!report.timestamp || !isValidTimestamp(report.timestamp)) {
    errors.push('Missing or invalid timestamp');
  }

  if (typeof report.totalElements !== 'number' || report.totalElements < 0) {
    errors.push('Invalid totalElements count');
  }

  if (!Array.isArray(report.elements)) {
    errors.push('Elements must be an array');
  }

  if (report.elements && report.elements.length !== report.totalElements) {
    errors.push(`Element count mismatch: expected ${report.totalElements}, got ${report.elements.length}`);
  }

  if (errors.length > 0) {
    logger.warn('Report validation failed', { errors, reportId: report.id });
    return { valid: false, errors };
  }

  return { valid: true, errors: [] };
}

function isValidElement(element, index) {
  const errors = [];

  if (!element || typeof element !== 'object') {
    errors.push(`Element ${index}: must be an object`);
    return { valid: false, errors };
  }

  if (!element.id || typeof element.id !== 'string') {
    errors.push(`Element ${index}: missing or invalid id`);
  }

  if (typeof element.index !== 'number') {
    errors.push(`Element ${index}: missing or invalid index`);
  }

  if (!element.tagName || typeof element.tagName !== 'string') {
    errors.push(`Element ${index}: missing or invalid tagName`);
  }

  if (!element.selectors || typeof element.selectors !== 'object') {
    errors.push(`Element ${index}: missing or invalid selectors`);
  }

  if (!element.styles || typeof element.styles !== 'object') {
    errors.push(`Element ${index}: missing or invalid styles`);
  }

  if (!element.position || typeof element.position !== 'object') {
    errors.push(`Element ${index}: missing or invalid position`);
  }

  if (!element.visibility || typeof element.visibility !== 'object') {
    errors.push(`Element ${index}: missing or invalid visibility`);
  }

  return { valid: errors.length === 0, errors };
}

function validateAllElements(report) {
  if (!report.elements || !Array.isArray(report.elements)) {
    return { valid: false, errors: ['Elements array is missing'] };
  }

  const errors = [];
  let validCount = 0;
  let invalidCount = 0;

  for (let i = 0; i < report.elements.length; i++) {
    const result = isValidElement(report.elements[i], i);
    if (result.valid) {
      validCount++;
    } else {
      invalidCount++;
      errors.push(...result.errors);
    }

    if (errors.length > 50) {
      errors.push('... (more than 50 validation errors, truncating)');
      break;
    }
  }

  logger.debug('Element validation complete', { 
    valid: validCount, 
    invalid: invalidCount,
    total: report.elements.length 
  });

  return { 
    valid: invalidCount === 0, 
    errors,
    validCount,
    invalidCount
  };
}

function isValidTimestamp(timestamp) {
  if (typeof timestamp !== 'string') return false;
  
  const date = new Date(timestamp);
  return !isNaN(date.getTime());
}

function sanitizeReport(report) {
  return {
    id: String(report.id || Date.now()),
    version: String(report.version || '1.0'),
    url: String(report.url || ''),
    title: String(report.title || 'Untitled'),
    timestamp: report.timestamp || new Date().toISOString(),
    totalElements: Number(report.totalElements || 0),
    duration: Number(report.duration || 0),
    filters: report.filters || null,
    elements: Array.isArray(report.elements) ? report.elements : []
  };
}

export { 
  isValidReport, 
  isValidElement, 
  validateAllElements, 
  sanitizeReport 
};
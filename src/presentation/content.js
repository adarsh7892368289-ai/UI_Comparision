// Content script to extract web elements from the page

import { generateBestCSS } from '../domain/selectors/css-generator.js';
import { generateBestXPath } from '../domain/selectors/xpath-generator.js';
import config from '../infrastructure/config.js';
import errorTracker, { ErrorCodes } from '../infrastructure/error-tracker.js';
import logger from '../infrastructure/logger.js';
import { safeExecute } from '../infrastructure/safe-execute.js';


// Initialize infrastructure
config.init();
logger.init();
errorTracker.init();

// Set context for all logs from this script
logger.setContext({ 
  script: 'content',
  url: window.location.href 
});

logger.info('Content script initialized', { 
  url: window.location.href,
  title: document.title 
});

//Message listener - handles requests from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  logger.debug('Received message', { action: request.action });

  if (request.action === 'extractElements') {
    extractAllElements()
      .then(data => {
        logger.info('Extraction completed', { 
          totalElements: data.totalElements,
          duration: data.duration 
        });
        sendResponse({ success: true, data });
      })
      .catch(error => {
        logger.error('Extraction failed', { 
          error: error.message,
          stack: error.stack 
        });
        
        errorTracker.logError(
          ErrorCodes.EXTRACTION_TIMEOUT,
          'Failed to extract elements',
          { url: window.location.href, error: error.message }
        );
        
        sendResponse({ 
          success: false, 
          error: error.message 
        });
      });
    
    return true;
  }
});

//Extract element data without timeout protection 
async function extractAllElements() {
  const startTime = performance.now();
  
  logger.info('Starting element extraction');

  const elements = [];
  const allElements = document.querySelectorAll('*');
  const excludeTags = ['SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT', 'BR', 'HR'];
  
  let index = 0;
  
  for (const element of allElements) {
    if (excludeTags.includes(element.tagName)) {
      continue;
    }
    
    try {
      const elementData = await extractElementData(element, index);
      if (elementData) {
        elements.push(elementData);
        index++;
      }
    } catch (error) {
      logger.warn('Failed to extract element', { 
        index,
        tagName: element.tagName,
        error: error.message 
      });
    }
  }
  
  const duration = performance.now() - startTime;
  
  logger.info('Extraction complete', { 
    totalElements: elements.length,
    duration: Math.round(duration) 
  });

  return {
    url: window.location.href,
    title: document.title,
    timestamp: new Date().toISOString(),
    totalElements: elements.length,
    duration: Math.round(duration),
    elements
  };
}

//Extract data from a single element
async function extractElementData(element, index) {
  const timeout = config.get('extraction.timeout', 150);
  
  const data = await safeExecute(
    () => extractElementDataUnsafe(element, index),
    { 
      timeout,
      fallback: null,
      operation: 'extractElement' 
    }
  );
  
  return data;
}

//Extract element data without timeout protection 
function extractElementDataUnsafe(element, index) {
  const xpath = generateBestXPath(element);
  const cssSelector = generateBestCSS(element);
  
  if (!xpath && !cssSelector) {
    logger.debug('Skipping element without selectors', { 
      index,
      tagName: element.tagName 
    });
    return null;
  }

  const rect = element.getBoundingClientRect();
  const isVisible = isElementVisible(element);
  
  const skipInvisible = config.get('extraction.skipInvisible', true);
  if (skipInvisible && !isVisible) {
    logger.debug('Skipping invisible element', { 
      index,
      tagName: element.tagName 
    });
    return null;
  }

  return {
    index,
    tagName: element.tagName,
    id: element.id || '',
    className: element.className || '',
    type: element.type || '',
    name: element.name || '',
    textContent: element.textContent?.substring(0, 200) || '',
    href: element.href || '',
    src: element.src || '',
    alt: element.alt || '',
    title: element.title || '',
    value: element.value || '',
    placeholder: element.placeholder || '',
    xpath: xpath || '',
    cssSelector: cssSelector || '',
    attributes: getAttributesString(element),
    visible: isVisible,
    position: `${Math.round(rect.top)},${Math.round(rect.left)}`,
    dimensions: `${Math.round(rect.width)}x${Math.round(rect.height)}`
  };
}


//Check if element is visible
function isElementVisible(element) {
  if (!element) return false;
  
  const style = window.getComputedStyle(element);
  
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (style.opacity === '0') return false;
  
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

//Get element attributes as string
function getAttributesString(element) {
  const attrs = [];
  
  for (const attr of element.attributes) {
    if (attr.name && attr.value) {
      attrs.push(`${attr.name}="${attr.value}"`);
    }
  }
  
  return attrs.join(' ');
}
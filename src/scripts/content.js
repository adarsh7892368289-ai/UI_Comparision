// Content script to extract web elements from the page

(function() {
  // Listen for messages from the popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Handle ping to check if content script is loaded
    if (request.action === 'ping') {
      sendResponse({ success: true });
      return true;
    }
    
    if (request.action === 'extractElements') {
      try {
        const elements = extractAllElements();
        sendResponse({ success: true, data: elements });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    }
    return true; // Keep the message channel open for async response
  });

  function extractAllElements() {
    const elementData = [];
    const allElements = document.querySelectorAll('*');
    
    allElements.forEach((element, index) => {
      try {
        // Skip script, style, and meta tags
        if (['SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT'].includes(element.tagName)) {
          return;
        }

        const elementInfo = {
          index: index + 1,
          tagName: element.tagName,
          id: element.id || '',
          className: element.className || '',
          type: element.type || '',
          name: element.name || '',
          href: element.href || '',
          src: element.src || '',
          alt: element.alt || '',
          title: element.title || '',
          value: element.value || '',
          placeholder: element.placeholder || '',
          textContent: getTextContent(element),
          xpath: getXPath(element),
          cssSelector: getCssSelector(element),
          attributes: getAttributes(element),
          visible: isVisible(element),
          position: getPosition(element),
          dimensions: getDimensions(element)
        };

        elementData.push(elementInfo);
      } catch (error) {
        console.error('Error extracting element:', error);
      }
    });

    return {
      url: window.location.href,
      title: document.title,
      timestamp: new Date().toISOString(),
      totalElements: elementData.length,
      elements: elementData
    };
  }

  function getTextContent(element) {
    // Get direct text content, not including children
    let text = '';
    for (let node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      }
    }
    return text.trim().substring(0, 100); // Limit to 100 chars
  }

  function getXPath(element) {
    if (element.id !== '') {
      return `//*[@id="${element.id}"]`;
    }
    
    if (element === document.body) {
      return '/html/body';
    }
    
    let ix = 0;
    const siblings = element.parentNode ? element.parentNode.childNodes : [];
    
    for (let i = 0; i < siblings.length; i++) {
      const sibling = siblings[i];
      if (sibling === element) {
        return getXPath(element.parentNode) + '/' + element.tagName.toLowerCase() + '[' + (ix + 1) + ']';
      }
      if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
        ix++;
      }
    }
  }

  function getCssSelector(element) {
    if (element.id) {
      return '#' + element.id;
    }
    
    if (element.className) {
      const classes = element.className.split(' ').filter(c => c.trim()).join('.');
      if (classes) {
        return element.tagName.toLowerCase() + '.' + classes;
      }
    }
    
    return element.tagName.toLowerCase();
  }

  function getAttributes(element) {
    const attrs = [];
    for (let attr of element.attributes) {
      attrs.push(`${attr.name}="${attr.value}"`);
    }
    return attrs.join(', ').substring(0, 200); // Limit length
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && 
           style.visibility !== 'hidden' && 
           style.opacity !== '0';
  }

  function getPosition(element) {
    const rect = element.getBoundingClientRect();
    return `x:${Math.round(rect.left)}, y:${Math.round(rect.top)}`;
  }

  function getDimensions(element) {
    const rect = element.getBoundingClientRect();
    return `${Math.round(rect.width)}x${Math.round(rect.height)}`;
  }
})();

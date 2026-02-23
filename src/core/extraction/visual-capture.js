(function () {
  if (window.__uiCmpVisualCapture) {return;}
  window.__uiCmpVisualCapture = true;

  const MSG_PREPARE = 'VISUAL_PREPARE';
  const MSG_REVERT  = 'VISUAL_REVERT';

  let _suppressionStack = [];

  function _suppressFixedSticky() {
    _suppressionStack = [];

    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      let pos;
      try {
        pos = window.getComputedStyle(el).position;
      } catch (_) {
        continue;
      }
      if (pos !== 'fixed' && pos !== 'sticky') {continue;}

      _suppressionStack.push({
        el,
        originalCssText: el.style.cssText
      });

      if (pos === 'fixed') {
        el.style.setProperty('position', 'absolute', 'important');
      } else {
        el.style.setProperty('position', 'relative', 'important');
      }
      el.style.setProperty('top',    'unset', 'important');
      el.style.setProperty('bottom', 'unset', 'important');
      el.style.setProperty('left',   'unset', 'important');
      el.style.setProperty('right',  'unset', 'important');
    }
  }

  function _restoreFixedSticky() {
    for (let i = _suppressionStack.length - 1; i >= 0; i--) {
      const { el, originalCssText } = _suppressionStack[i];
      el.style.cssText = originalCssText;
    }
    _suppressionStack = [];
  }

  function _resolveElement(selector) {
    if (!selector) {return null;}
    try {
      const isXPath = selector.startsWith('/') || selector.startsWith('(');
      if (isXPath) {
        const r = document.evaluate(
          selector,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        return r.singleNodeValue || null;
      }
      return document.querySelector(selector);
    } catch (_) {
      return null;
    }
  }

  function _measureHiDpiRect(el) {
    const dpr     = window.devicePixelRatio || 1;
    const vvScale = window.visualViewport?.scale ?? 1;
    const scale   = dpr * vvScale;

    const r = el.getBoundingClientRect();

    const x = Math.round(r.left * scale);
    const y = Math.round(r.top  * scale);
    const w = Math.round(r.width  * scale);
    const h = Math.round(r.height * scale);

    return { x, y, width: w, height: h };
  }

  function _isRectUsable(rect) {
    return rect.width > 0 && rect.height > 0 &&
           rect.x >= 0 && rect.y >= 0;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === MSG_PREPARE) {
      const { selector } = message;

      const el = _resolveElement(selector);
      if (!el) {
        sendResponse({ success: true, data: { found: false, selector } });
        return false;
      }

      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      _suppressFixedSticky();

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try {
            const rect = _measureHiDpiRect(el);
            const usable = _isRectUsable(rect);
            sendResponse({
              success: true,
              data:    { found: true, usable, rect, selector }
            });
          } catch (err) {
            _restoreFixedSticky();
            sendResponse({ success: false, error: err.message });
          }
        });
      });

      return true;
    }

    if (message.type === MSG_REVERT) {
      _restoreFixedSticky();
      sendResponse({ success: true });
      return false;
    }
  });
})();
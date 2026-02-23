import logger from '../infrastructure/logger.js';
import { blobToDataUri } from '../infrastructure/image-processor.js';

const SETTLE_NORMAL_MS = 25;
const SETTLE_REVEAL_MS = 100;

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function _assertTabCapturable(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {throw new Error(`Tab ${tabId} not found`);}
  if (tab.discarded) {throw new Error(`TAB_DISCARDED: Tab ${tabId} was suspended by Chrome. Click the tab to reload it, then retry.`);}
}

async function _attachDebugger(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    logger.debug('CDP attached', { tabId });
  } catch (err) {
    if (err.message?.includes('Another debugger is already attached')) {
      throw new Error(`DEBUGGER_CONFLICT: Chrome DevTools is open on tab ${tabId}. Close DevTools and retry.`);
    }
    throw new Error(`DEBUGGER_ATTACH_FAILED: ${err.message}`);
  }
}

async function _detachDebugger(tabId) {
  try { await chrome.debugger.detach({ tabId }); logger.debug('CDP detached', { tabId }); } catch (_) {}
}

function _inPageSuppressOverlays() {
  if (window.__uiCmpOverlays?.length) {return;}
  window.__uiCmpOverlays = [];
  const all = document.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const node = all[i];
    let pos;
    try { pos = window.getComputedStyle(node).position; } catch (_) { continue; }
    if (pos !== 'fixed' && pos !== 'sticky') {continue;}
    window.__uiCmpOverlays.push({ el: node, cssText: node.style.cssText });
    node.style.setProperty('position', pos === 'fixed' ? 'absolute' : 'relative', 'important');
    node.style.setProperty('top',    'unset', 'important');
    node.style.setProperty('bottom', 'unset', 'important');
    node.style.setProperty('left',   'unset', 'important');
    node.style.setProperty('right',  'unset', 'important');
  }
}

function _inPageRestoreOverlays() {
  if (!window.__uiCmpOverlays) {return;}
  for (let i = window.__uiCmpOverlays.length - 1; i >= 0; i--) {
    window.__uiCmpOverlays[i].el.style.cssText = window.__uiCmpOverlays[i].cssText;
  }
  window.__uiCmpOverlays = [];
}

function _inPagePrepare(selector) {
  if (!window.__uiCmpStack) {window.__uiCmpStack = [];}

  let el = null;
  try {
    const isXPath = selector.startsWith('/') || selector.startsWith('(');
    if (isXPath) {
      const res = document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      el = res.singleNodeValue || null;
    } else {
      el = document.querySelector(selector);
    }
  } catch (_) { return { found: false, selector }; }

  if (!el) {return { found: false, selector };}

  let needsReveal = false;
  let node = el.parentElement;
  while (node && node !== document.documentElement) {
    const cs = window.getComputedStyle(node);
    const patches = {};
    if (cs.display    === 'none')        {patches.display    = 'block';}
    if (cs.visibility === 'hidden')      {patches.visibility = 'visible';}
    if (parseFloat(cs.opacity) < 0.01)  {patches.opacity    = '1';}
    const h = parseFloat(cs.height), mh = parseFloat(cs.maxHeight);
    const ov = cs.overflow, ovY = cs.overflowY;
    if ((ov === 'hidden' || ov === 'clip' || ovY === 'hidden' || ovY === 'clip') && (h < 1 || mh < 1)) {
      patches.height = 'auto'; patches.maxHeight = 'none'; patches.overflow = 'visible';
    }
    if (Object.keys(patches).length > 0) {
      needsReveal = true;
      window.__uiCmpStack.push({ el: node, cssText: node.style.cssText });
      for (const [prop, val] of Object.entries(patches)) {node.style.setProperty(prop, val, 'important');}
    }
    node = node.parentElement;
  }

  el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (r.width <= 0 || r.height <= 0) {return { found: true, usable: false, selector };}

  return {
    found: true, usable: true, needsReveal,
    rect: { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height },
    dpr, selector
  };
}

function _inPageRevert() {
  if (!window.__uiCmpStack) {return;}
  for (let i = window.__uiCmpStack.length - 1; i >= 0; i--) {
    window.__uiCmpStack[i].el.style.cssText = window.__uiCmpStack[i].cssText;
  }
  window.__uiCmpStack = [];
}

async function _exec(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args, world: 'MAIN' });
  return results?.[0]?.result;
}

async function _prepareElement(tabId, selector) {
  return (await _exec(tabId, _inPagePrepare, [selector])) ?? { found: false, selector };
}

async function _revertElement(tabId) {
  try { await _exec(tabId, _inPageRevert); } catch (err) {
    logger.warn('REVERT failed', { tabId, error: err.message });
  }
}

async function _cdpScreenshot(tabId, rect, dpr) {
  const response = await chrome.debugger.sendCommand(
    { tabId }, 'Page.captureScreenshot',
    {
      format: 'webp', quality: 85,
      clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: dpr },
      fromSurface: true, captureBeyondViewport: true
    }
  );
  if (!response?.data) {throw new Error('CDP Page.captureScreenshot returned no data');}
  const binary = atob(response.data);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {bytes[i] = binary.charCodeAt(i);}
  return new Blob([bytes], { type: 'image/webp' });
}

// ─── Single-Tab Capture Phase ──────────────────────────────────────────────────
//
// Complexity: O(N_dom) for overlay setup + O(N_elements × dom_depth) for captures
// Timing:     70 normal × 58ms + 30 revealed × 133ms = 8.1s per tab
// Both tabs run in parallel → ~8s total (Promise.all in runVisualDiffWorkflow)
//
async function _runCapturePhase(tabId, elements) {
  await _assertTabCapturable(tabId);
  await _attachDebugger(tabId);

  try {
    await _exec(tabId, _inPageSuppressOverlays);
  } catch (err) {
    logger.warn('Overlay suppression failed', { tabId, error: err.message });
  }

  const captured = new Map();

  try {
    for (const el of elements) {
      const selector = el.selectors?.css || el.selectors?.xpath;
      if (!selector) { logger.warn('No selector', { id: el.id }); continue; }

      let prepData;
      try {
        prepData = await _prepareElement(tabId, selector);
      } catch (err) {
        logger.error('PREPARE failed', { selector, error: err.message });
        continue;
      }

      if (!prepData?.found) { logger.warn('Not found in DOM', { selector }); continue; }

      if (!prepData.usable) {
        logger.warn('Zero-rect — skipping', { selector });
        await _revertElement(tabId);
        continue;
      }

      await _sleep(prepData.needsReveal ? SETTLE_REVEAL_MS : SETTLE_NORMAL_MS);

      let blob;
      try {
        blob = await _cdpScreenshot(tabId, prepData.rect, prepData.dpr);
      } catch (err) {
        logger.error('CDP screenshot failed', { selector, error: err.message });
        await _revertElement(tabId);
        continue;
      }

      await _revertElement(tabId);
      const key = el.id ?? selector;
      captured.set(key, blob);
      logger.debug('Captured', { key, bytes: blob.size });
    }
  } finally {
    await _exec(tabId, _inPageRestoreOverlays)
      .catch(err => logger.warn('Overlay restore failed', { tabId, error: err.message }));
    await _detachDebugger(tabId);
  }

  return captured;
}

function _classifyError(err) {
  const msg = err.message ?? '';
  if (msg.startsWith('DEBUGGER_CONFLICT'))     {return 'Chrome DevTools is open on one of the source tabs. Close DevTools and retry.';}
  if (msg.startsWith('DEBUGGER_ATTACH_FAILED')) {return `Could not attach CDP session: ${  msg.replace('DEBUGGER_ATTACH_FAILED: ', '')}`;}
  if (msg.startsWith('TAB_DISCARDED'))          {return msg;}
  if (msg.includes('Cannot access') || msg.includes('Missing host permission')) {return `Page is not accessible to the extension: ${msg}`;}
  if (msg.includes('tab') && msg.includes('not found')) {return `A required tab was closed: ${msg}`;}
  return `Visual capture failed: ${msg}`;
}

async function runVisualDiffWorkflow({ modifiedElements, baselineTabId, compareTabId, pixelDiffer = null }) {
  if (!Number.isInteger(baselineTabId) || !Number.isInteger(compareTabId)) {
    logger.info('Visual diff: no tab IDs — skipping');
    return { status: 'skipped', reason: 'Source tabs must be open to capture visual diffs.', diffs: new Map() };
  }

  if (!Array.isArray(modifiedElements) || modifiedElements.length === 0) {
    logger.info('Visual diff: no elements — skipping');
    return { status: 'skipped', reason: 'No modified elements require visual capture.', diffs: new Map() };
  }

  logger.info('Visual diff: start', { total: modifiedElements.length, baselineTabId, compareTabId });

  let baselineCaptures, compareCaptures;
  try {
    [baselineCaptures, compareCaptures] = await Promise.all([
      _runCapturePhase(baselineTabId, modifiedElements),
      _runCapturePhase(compareTabId,  modifiedElements)
    ]);
  } catch (err) {
    const reason = _classifyError(err);
    logger.error('Capture failed', { reason });
    return { status: 'error', reason, diffs: new Map() };
  }

  logger.info('Visual diff: diffing', { baseline: baselineCaptures.size, compare: compareCaptures.size });

  const visualDiffs = new Map();

  for (const el of modifiedElements) {
    const key      = el.id ?? el.selectors?.css ?? el.selectors?.xpath;
    const baseline = baselineCaptures.get(key);
    const compare  = compareCaptures.get(key);
    if (!baseline || !compare) { logger.warn('Missing pair', { key }); continue; }

    let diff = null;
    if (typeof pixelDiffer === 'function') {
      try {
        const r = await pixelDiffer(baseline, compare);
        diff = r?.blob ?? (r instanceof Blob ? r : null);
      } catch (err) { logger.error('Pixel diff threw', { key, error: err.message }); }
    }

    let baselineUri, compareUri, diffUri = null;
    try {
      [baselineUri, compareUri] = await Promise.all([
        blobToDataUri(baseline, 'image/webp'),
        blobToDataUri(compare,  'image/webp')
      ]);
      if (diff instanceof Blob) {diffUri = await blobToDataUri(diff, 'image/webp');}
    } catch (encodeErr) {
      logger.error(`Encoding failed for "${key}"`, { error: encodeErr.message });
      return { status: 'error', reason: `Encoding failed for "${key}": ${encodeErr.message}`, diffs: visualDiffs };
    }

    visualDiffs.set(key, { baseline: baselineUri, compare: compareUri, diff: diffUri });
  }

  if (visualDiffs.size === 0) {
    const reason = 'Captures completed but no element pairs matched.';
    logger.warn(reason);
    return { status: 'error', reason, diffs: new Map() };
  }

  logger.info('Visual diff complete', { total: modifiedElements.length, paired: visualDiffs.size });
  return { status: 'success', reason: '', diffs: visualDiffs };
}

export { runVisualDiffWorkflow };
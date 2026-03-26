import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/idb-repository.js';
import { groupIntoKeyframes } from '../core/comparison/keyframe-grouper.js';

const CAPTURE_SCALE_FACTOR   = 2;
const CAPTURE_QUALITY        = 85;
const FREEZE_STYLE_ID        = 'vdiff-freeze-styles';
const SUPPRESS_ATTR          = 'data-vdiff-suppress';
const CDP_PROTOCOL           = '1.3';
const WEBP_MIME              = 'image/webp';
const CDP_ATTACH_TIMEOUT_MS  = 8_000;
const CDP_CAPTURE_TIMEOUT_MS = 15_000;
const CDP_COMMAND_TIMEOUT_MS = 5_000;
const SCROLL_SETTLE_TIMEOUT_MS   = 800;
const SCROLL_SETTLE_TOLERANCE_PX = 2;
const SCROLL_VERIFY_TOLERANCE_PX = 5;
const SCROLL_VERIFY_RETRY_MAX    = 2;
const SCROLL_VERIFY_RETRY_MS     = 400;
const DEVTOOLS_HEIGHT_THRESHOLD_PX = 200;
const BROWSER_CHROME_HEIGHT_PX = 88;

function ms(start) {
  return `${Date.now() - start}ms`;
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`CDP timeout: ${label} after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

function inPageGetViewport() {
  const width  = Math.floor(window.innerWidth);
  const height = Math.floor(window.innerHeight);
  const documentHeight = document.documentElement.scrollHeight;
  const outerHeight = Math.floor(window.outerHeight);
  const outerWidth  = Math.floor(window.outerWidth);
  return { width, height, documentHeight, outerHeight, outerWidth };
}

function inPageGetDPR() {
  return window.devicePixelRatio;
}

function inPageLockScrollbar() {
  const before = window.innerWidth;
  document.body.style.setProperty('overflow', 'hidden', 'important');
  const after      = window.innerWidth;
  const scrollbarW = after - before;
  if (scrollbarW > 0) {
    document.body.style.setProperty('padding-right', `${scrollbarW}px`, 'important');
  }
  return { scrollbarWidth: scrollbarW };
}

function inPageUnlockScrollbar() {
  document.body.style.removeProperty('overflow');
  document.body.style.removeProperty('padding-right');
}

function inPageFreezeAnimations(styleId) {
  if (document.getElementById(styleId)) { return; }
  const style = document.createElement('style');
  style.id          = styleId;
  style.textContent = [
    'html, body { scroll-behavior: auto !important; }',
    '*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; }'
  ].join(' ');
  document.head.appendChild(style);

  if (!window.__vdiffScrollPatched) {
    window.__vdiffScrollPatched = true;

    (function patchScrollAPIs() {
      function stripSmooth(args) {
        if (args.length === 1 && args[0] !== null && typeof args[0] === 'object') {
          return [Object.assign({}, args[0], { behavior: 'auto' })];
        }
        return args;
      }

      function wrap(obj, method) {
        if (!obj || typeof obj[method] !== 'function') { return; }
        const orig = obj[method];
        obj[method] = function vdiffScrollWrap() {
          return orig.apply(this, stripSmooth(Array.from(arguments)));
        };
      }

      wrap(window,              'scrollTo');
      wrap(window,              'scrollBy');
      wrap(Element.prototype,   'scrollTo');
      wrap(Element.prototype,   'scrollBy');
      wrap(Element.prototype,   'scrollIntoView');
    })();
  }
}

function inPageRestoreAnimations(styleId) {
  document.getElementById(styleId)?.remove();
}

function inPageSuppressFixed(markAttr, diffSelectors) {
  const protectedEls       = new Set();
  const protectedAncestors = new Set();
  const protectedDescendants = new Set();

  for (const sel of (diffSelectors || [])) {
    const el = document.querySelector(sel);
    if (!el) { continue; }
    protectedEls.add(el);
    let ancestor = el.parentElement;
    while (ancestor && ancestor !== document.documentElement) {
      protectedAncestors.add(ancestor);
      ancestor = ancestor.parentElement;
    }
    el.querySelectorAll('*').forEach(d => protectedDescendants.add(d));
  }

  const all    = document.querySelectorAll('*');
  const toHide = [];
  for (const domEl of all) {
    if (protectedEls.has(domEl) || protectedAncestors.has(domEl) || protectedDescendants.has(domEl)) { continue; }
    const { position } = getComputedStyle(domEl);
    if (position === 'fixed' || position === 'sticky') { toHide.push(domEl); }
  }
  for (const domEl of toHide) {
    domEl.setAttribute(markAttr, '1');
    domEl.style.setProperty('display', 'none', 'important');
  }
  return { suppressed: toHide.length, domSize: all.length };
}

function inPageRestoreFixed(markAttr) {
  for (const domEl of document.querySelectorAll(`[${markAttr}]`)) {
    domEl.style.removeProperty('display');
    domEl.removeAttribute(markAttr);
  }
}

function inPageScrollAndSettle(targetY, fallbackMs) {
  window.scrollTo(0, targetY);

  const tolerance = typeof SCROLL_SETTLE_TOLERANCE_PX !== 'undefined'
    ? SCROLL_SETTLE_TOLERANCE_PX
    : 2;

  return new Promise(function(resolve) {
    const deadline  = Date.now() + fallbackMs;
    let lastY       = -1;
    let stableCount = 0;
    let done        = false;

    function finish(y) {
      if (done) { return; }
      done = true;
      clearTimeout(hardTimer);
      resolve(y);
    }

    const hardTimer = setTimeout(
      function() { finish(Math.round(window.scrollY)); },
      fallbackMs
    );

    function tick() {
      if (done) { return; }
      const y = Math.round(window.scrollY);
      if (y === lastY && Math.abs(y - targetY) <= tolerance) {
        stableCount++;
        if (stableCount >= 2) { finish(y); return; }
      } else {
        stableCount = 0;
      }
      lastY = y;
      if (Date.now() >= deadline) { finish(y); return; }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

function inPageGetRects(selectorPairs) {
  const { scrollY } = window;
  return selectorPairs.map(({ id, selector }) => {
    const domEl = selector ? document.querySelector(selector) : null;
    if (!domEl) { return { id, found: false, usable: false }; }

    const matchCount = selector ? document.querySelectorAll(selector).length : 1;
    const selectorAmbiguous = matchCount > 1;

    const r = domEl.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w === 0 && h === 0) { return { id, found: true, usable: false, selectorAmbiguous }; }
    return {
      id,
      found:              true,
      usable:             true,
      selectorAmbiguous,
      selectorMatchCount: matchCount,
      documentY: Math.round(r.top + scrollY),
      height:    h,
      width:     w,
      left:      Math.round(r.left)
    };
  });
}

function inPageRemeasureRects(selectorPairs) {
  const actualScrollY = Math.round(window.scrollY);
  const vpH           = window.innerHeight;
  const vpW           = window.innerWidth;

  const rects = selectorPairs.map(({ id, selector }) => {
    const el = selector ? document.querySelector(selector) : null;
    if (!el) {
      return { id, found: false, inViewport: false, misalignReason: 'element-not-found' };
    }

    const matchCount        = selector ? document.querySelectorAll(selector).length : 1;
    const selectorAmbiguous = matchCount > 1;

    const r = el.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w === 0 && h === 0) {
      return {
        id, found: true, inViewport: false,
        misalignReason: 'zero-dimension',
        selectorAmbiguous,
        selectorMatchCount: matchCount,
        viewportX: Math.round(r.left), viewportY: Math.round(r.top),
        width: 0, height: 0
      };
    }
    const inViewport = r.bottom > 0 && r.top < vpH && r.right > 0 && r.left < vpW;
    return {
      id,
      found:              true,
      inViewport,
      misalignReason:     inViewport ? null : 'out-of-viewport',
      selectorAmbiguous,
      selectorMatchCount: matchCount,
      viewportX:          Math.round(r.left),
      viewportY:          Math.round(r.top),
      width:              w,
      height:             h
    };
  });

  return { actualScrollY, rects };
}

function inPageGetPseudoStyles(selectorPairs) {
  const PSEUDO_PROPS = [
    'content', 'display', 'width', 'height', 'background-color', 'color',
    'font-size', 'font-family', 'position', 'top', 'left', 'right', 'bottom',
    'transform', 'opacity', 'border', 'padding', 'margin', 'box-shadow',
    'border-radius', 'z-index', 'visibility'
  ];

  function collectPseudo(el, pseudo) {
    const cs      = window.getComputedStyle(el, pseudo);
    const content = cs.getPropertyValue('content');
    if (!content || content === 'none' || content === 'normal' || content === '""' || content === "''") { return null; }
    const styles = Object.create(null);
    for (const p of PSEUDO_PROPS) {
      const val = cs.getPropertyValue(p);
      if (val) { styles[p] = val; }
    }
    return styles;
  }

  return selectorPairs.map(({ id, selector }) => {
    const el = selector ? document.querySelector(selector) : null;
    if (!el) { return { id, before: null, after: null }; }
    return {
      id,
      before: collectPseudo(el, '::before'),
      after:  collectPseudo(el, '::after')
    };
  });
}

function sendCDP(tabId, method, params, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
  return withTimeout(
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}),
    timeoutMs,
    `${method} tabId=${tabId}`
  );
}

function execInPage(tabId, func, args) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func,
    args:   args ?? [],
    world:  'MAIN'
  }).then(results => results?.[0]?.result);
}

async function base64ToBlob(base64Data, mimeType) {
  const response = await fetch(`data:${mimeType};base64,${base64Data}`);
  return response.blob();
}

function buildMetricsOverride(viewport, scrollbarWidth = 0, targetHeight) {
  return {
    width:             Math.round(viewport.width) + Math.round(scrollbarWidth || 0),
    height:            Math.round(targetHeight ?? viewport.height),
    deviceScaleFactor: CAPTURE_SCALE_FACTOR,
    mobile:            false
  };
}

function prefixKeyframes(keyframes, sessionId, role) {
  return keyframes.map(kf => ({
    ...kf,
    id:       `${sessionId}_${role}_${kf.id}`,
    sessionId,
    tabRole:  role
  }));
}

function buildManifestFromRemeasured(keyframes, remeasureResults, documentYById, actualDPR, documentHeight, viewportHeight) {
  const resultByKfId = new Map(remeasureResults.map(r => [r.keyframeId, r]));
  const manifest     = new Map();
  const vpH = viewportHeight > 0 ? viewportHeight : Infinity;

  for (const kf of keyframes) {
    const remeasure = resultByKfId.get(kf.id);
    if (!remeasure) { continue; }

    const { actualScrollY, rects } = remeasure;
    const measuredById = new Map(rects.map(r => [r.id, r]));

    for (const elId of kf.elementIds) {
      const m    = measuredById.get(elId);
      const docY = documentYById.get(elId) ?? null;

      if (!m || !m.found) {
        manifest.set(elId, {
          keyframeId:          kf.id,
          actualDPR,
          dpr:                 CAPTURE_SCALE_FACTOR,
          kfScrollY:           actualScrollY,
          documentY:           docY,
          totalDocumentHeight: documentHeight,
          viewportRect:        null,
          misaligned:          true,
          misalignReason:      (m?.misalignReason) ?? 'element-not-found',
          selectorAmbiguous:   false,
          selectorMatchCount:  null,
          rectClipped:         false
        });
        continue;
      }

      const rawY   = m.viewportY;
      const rawH   = m.height;
      const clippedY      = Math.max(0, rawY);
      const clippedBottom = Math.min(rawY + rawH, vpH);
      const clippedH      = Math.max(1, clippedBottom - clippedY);
      const rectClipped   = clippedH < rawH;

      if (clippedBottom <= 0) {
        manifest.set(elId, {
          keyframeId:          kf.id,
          actualDPR,
          dpr:                 CAPTURE_SCALE_FACTOR,
          kfScrollY:           actualScrollY,
          documentY:           docY,
          totalDocumentHeight: documentHeight,
          viewportRect:        null,
          misaligned:          true,
          misalignReason:      'clipped-below-fold',
          selectorAmbiguous:   m.selectorAmbiguous  ?? false,
          selectorMatchCount:  m.selectorMatchCount ?? null,
          rectClipped:         true
        });
        continue;
      }

      const viewportRect = {
        x:      m.viewportX,
        y:      clippedY,
        width:  m.width,
        height: clippedH
      };
      const rawViewportRect = {
        x:      m.viewportX,
        y:      rawY,
        width:  m.width,
        height: rawH
      };

      const misaligned = !m.inViewport;

      manifest.set(elId, {
        keyframeId:          kf.id,
        actualDPR,
        dpr:                 CAPTURE_SCALE_FACTOR,
        kfScrollY:           actualScrollY,
        documentY:           docY,
        totalDocumentHeight: documentHeight,
        viewportRect,
        rawViewportRect,
        misaligned:          misaligned || undefined,
        misalignReason:      misaligned ? m.misalignReason : undefined,
        selectorAmbiguous:   m.selectorAmbiguous  ?? false,
        selectorMatchCount:  m.selectorMatchCount ?? null,
        rectClipped
      });
    }
  }

  return manifest;
}

function attachPseudoDataToManifest(manifest, pseudoResults) {
  if (!pseudoResults?.length) { return; }
  for (const { id, before, after } of pseudoResults) {
    const entry = manifest.get(id);
    if (!entry) { continue; }
    if (before) { entry.pseudoBefore = { ...before, parentHpid: id, pseudoType: 'before' }; }
    if (after)  { entry.pseudoAfter  = { ...after,  parentHpid: id, pseudoType: 'after'  }; }
  }
}

function buildElementRectRecords(sessionId, role, manifest) {
  const records = [];
  for (const [elementKey, entry] of manifest.entries()) {
    const {
      keyframeId, viewportRect, rawViewportRect, actualDPR, documentY, totalDocumentHeight,
      pseudoBefore, pseudoAfter, misaligned, misalignReason,
      selectorAmbiguous, selectorMatchCount, rectClipped
    } = entry;
    records.push({
      id:                  `${sessionId}_${role}_rect_${elementKey}`,
      sessionId,
      elementKey,
      tabRole:             role,
      keyframeId,
      rect:                viewportRect,
      rawRect:             rawViewportRect ?? null,
      actualDPR,
      documentY,
      totalDocumentHeight,
      pseudoBefore:        pseudoBefore      ?? null,
      pseudoAfter:         pseudoAfter       ?? null,
      misaligned:          misaligned        ?? false,
      misalignReason:      misalignReason    ?? null,
      selectorAmbiguous:   selectorAmbiguous ?? false,
      selectorMatchCount:  selectorMatchCount ?? null,
      rectClipped:         rectClipped       ?? false
    });
  }
  return records;
}

function buildDiffMap(elements, baselineManifest, compareManifest) {
  const diffs = new Map();

  for (const el of elements) {
    const hpid          = el.baselineElement.hpid;
    const baselineEntry = baselineManifest.get(hpid) ?? null;
    const compareEntry  = compareManifest.get(hpid)  ?? null;
    if (!baselineEntry && !compareEntry) { continue; }
    diffs.set(hpid, {
      baseline: baselineEntry,
      compare:  compareEntry,
      diffs:    el.annotatedDifferences ?? []
    });
  }

  return diffs;
}

function extractModifiedElements(comparisonResult) {
  return comparisonResult.comparison.results.filter(r => (r.totalDifferences ?? 0) > 0);
}

function extractSelectorPair(element, role) {
  const roleEl = role === 'baseline' ? element.baselineElement : element.compareElement;
  if (!roleEl) { return null; }
  const { cssSelector } = roleEl;
  if (!cssSelector) { return null; }
  return { id: element.baselineElement.hpid, selector: cssSelector };
}

function buildSelectorPairs(elements, role) {
  return elements.map(el => extractSelectorPair(el, role)).filter(Boolean);
}

async function captureKeyframe(tabId, keyframe, kfSelectorPairs, sessionId, index, total, roleStart, actualDPR, documentHeight) {
  const { id, scrollY, viewportWidth, viewportHeight, tabRole } = keyframe;
  const kfTag = `[kf ${index + 1}/${total} scrollY=${scrollY}]`;

  await sendCDP(tabId, 'Page.bringToFront');
  logger.info(`VDIFF ${kfTag} bringToFront DONE`, { tabId, role: tabRole });

  const t0 = Date.now();
  logger.info(`VDIFF ${kfTag} scroll START`, { tabId, role: tabRole });
  await execInPage(tabId, inPageScrollAndSettle, [scrollY, SCROLL_SETTLE_TIMEOUT_MS]);
  logger.info(`VDIFF ${kfTag} scroll+paint DONE`, { elapsed: ms(t0) });

  let actualScrollY = scrollY;
  for (let attempt = 0; attempt < SCROLL_VERIFY_RETRY_MAX; attempt++) {
    const readY = await execInPage(tabId, () => Math.round(window.scrollY));
    actualScrollY = readY;
    if (Math.abs(readY - scrollY) <= SCROLL_VERIFY_TOLERANCE_PX) { break; }
    logger.warn(`VDIFF ${kfTag} scroll mismatch`, { expected: scrollY, actual: readY, attempt });
    await execInPage(tabId, inPageScrollAndSettle, [scrollY, SCROLL_VERIFY_RETRY_MS]);
  }

  const tRemeasure = Date.now();
  const remeasureRaw = await execInPage(tabId, inPageRemeasureRects, [kfSelectorPairs]);
  const confirmedScrollY = remeasureRaw?.actualScrollY ?? actualScrollY;
  const remeasuredRects  = remeasureRaw?.rects ?? [];

  const misalignedCount = remeasuredRects.filter(r => !r.inViewport || !r.found).length;
  logger.info(`VDIFF ${kfTag} remeasure DONE`, {
    elapsed:        ms(tRemeasure),
    confirmedScrollY,
    planned:        scrollY,
    drift:          Math.abs(confirmedScrollY - scrollY),
    measured:       remeasuredRects.length,
    misaligned:     misalignedCount
  });

  logger.info(`VDIFF ${kfTag} JS freeze START`);
  await sendCDP(tabId, 'Emulation.setScriptExecutionDisabled', { value: true });
  logger.info(`VDIFF ${kfTag} JS freeze DONE`);

  let result;
  try {
    const t1 = Date.now();
    logger.info(`VDIFF ${kfTag} CDP captureScreenshot START`);
    result = await sendCDP(tabId, 'Page.captureScreenshot', {
      format:           'webp',
      quality:          CAPTURE_QUALITY,
      fromSurface:      true,
      optimizeForSpeed: false
    }, CDP_CAPTURE_TIMEOUT_MS);
    logger.info(`VDIFF ${kfTag} CDP captureScreenshot DONE`, {
      elapsed:  ms(t1),
      b64Bytes: result?.data?.length ?? 0
    });
  } finally {
    await sendCDP(tabId, 'Emulation.setScriptExecutionDisabled', { value: false });
    logger.info(`VDIFF ${kfTag} JS unfreeze DONE`);
  }

  const t2 = Date.now();
  const blob = await base64ToBlob(result.data, WEBP_MIME);
  logger.info(`VDIFF ${kfTag} base64→blob DONE`, { elapsed: ms(t2), blobBytes: blob.size });

  const t3 = Date.now();
  logger.info(`VDIFF ${kfTag} IDB saveVisualBlob START`);
  await storage.saveVisualBlob(id, blob, sessionId);
  logger.info(`VDIFF ${kfTag} IDB saveVisualBlob DONE`, { elapsed: ms(t3) });

  const t4 = Date.now();
  await storage.saveVisualKeyframe({
    id,
    sessionId,
    tabRole,
    scrollY:            confirmedScrollY,
    viewportWidth,
    viewportHeight,
    documentHeight,
    captureScaleFactor: CAPTURE_SCALE_FACTOR,
    devicePixelRatio:   actualDPR,
    capturedAt:         Date.now()
  });
  logger.info(`VDIFF ${kfTag} IDB saveVisualKeyframe DONE`, { elapsed: ms(t4) });
  logger.info(`VDIFF ${kfTag} COMPLETE`, { totalElapsed: ms(roleStart) });

  return {
    keyframeId:    id,
    actualScrollY: confirmedScrollY,
    rects:         remeasuredRects
  };
}

async function captureAllKeyframes(tabId, keyframes, selectorById, sessionId, role, actualDPR, documentHeight) {
  const total          = keyframes.length;
  const roleStart      = Date.now();
  const remeasureResults = [];
  logger.info(`VDIFF [${role}] captureAllKeyframes START`, { tabId, keyframeCount: total });

  for (let i = 0; i < total; i++) {
    const kf = keyframes[i];

    const kfSelectorPairs = kf.elementIds
      .map(id => selectorById.get(id))
      .filter(Boolean);

    const result = await captureKeyframe(
      tabId, kf, kfSelectorPairs, sessionId, i, total, roleStart, actualDPR, documentHeight
    );
    remeasureResults.push(result);
  }

  logger.info(`VDIFF [${role}] captureAllKeyframes DONE`, {
    tabId, keyframeCount: total, totalElapsed: ms(roleStart)
  });

  return remeasureResults;
}

async function safeRestorePage(tabId) {
  await execInPage(tabId, inPageUnlockScrollbar).catch(() => undefined);
  await execInPage(tabId, inPageRestoreFixed, [SUPPRESS_ATTR]).catch(() => undefined);
  await execInPage(tabId, inPageRestoreAnimations, [FREEZE_STYLE_ID]).catch(() => undefined);
  await execInPage(tabId, inPageScrollAndSettle, [0, SCROLL_SETTLE_TIMEOUT_MS]).catch(() => undefined);
  await sendCDP(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => undefined);
}

async function safeDetach(tabId) {
  await chrome.debugger.detach({ tabId }).catch(() => undefined);
}

async function tryAttach(tabId) {
  try {
    const targets = await chrome.debugger.getTargets();
    const stale   = targets.find(t => t.tabId === tabId && t.attached);
    if (stale) {
      logger.warn(`VDIFF stale debugger found on tab ${tabId} — force-detaching`, { targetId: stale.id });
      await chrome.debugger.detach({ tabId }).catch(() => undefined);
      await new Promise(r => { setTimeout(r, 200); });
    }
  } catch (e) {
    logger.warn('VDIFF getTargets failed — proceeding with attach', { error: e.message });
  }

  await withTimeout(
    chrome.debugger.attach({ tabId }, CDP_PROTOCOL),
    CDP_ATTACH_TIMEOUT_MS,
    `debugger.attach tabId=${tabId}`
  );
}

async function executeTabCapture(tabId, selectorPairs, sessionId, role) {
  const t0 = Date.now();
  logger.info(`VDIFF [${role}] executeTabCapture START`, { tabId, selectorCount: selectorPairs.length });

  await sendCDP(tabId, 'Page.bringToFront');
  logger.info(`VDIFF [${role}] bringToFront (setup) DONE`, { tabId });

  const t1       = Date.now();
  const viewport = await execInPage(tabId, inPageGetViewport);
  logger.info(`VDIFF [${role}] inPageGetViewport DONE`, { elapsed: ms(t1), viewport });
  if (!viewport) { throw new Error(`Failed to read viewport from tab ${tabId}`); }

  let confirmedHeight  = viewport.height;
  const heightGap      = (viewport.outerHeight || 0) - viewport.height;
  const widthGap       = (viewport.outerWidth  || 0) - viewport.width;
  const devToolsDetected = heightGap > DEVTOOLS_HEIGHT_THRESHOLD_PX || widthGap > DEVTOOLS_HEIGHT_THRESHOLD_PX;
  let devToolsWarning  = null;

  if (devToolsDetected) {
    const targetHeight = Math.max(400, (viewport.outerHeight || viewport.height) - BROWSER_CHROME_HEIGHT_PX);
    logger.warn(`VDIFF [${role}] DevTools detected — bypassing with computed targetHeight`, {
      innerH: viewport.height, outerH: viewport.outerHeight, heightGap, targetHeight
    });
    await sendCDP(tabId, 'Emulation.setDeviceMetricsOverride',
      buildMetricsOverride(viewport, 0, targetHeight));
    logger.info(`VDIFF [${role}] setDeviceMetricsOverride (DevTools bypass, pre-lock) DONE`);
    confirmedHeight = await execInPage(tabId, () => Math.floor(window.innerHeight)) ?? targetHeight;
    logger.info(`VDIFF [${role}] confirmed virtual vpH after bypass`, { confirmedHeight, targetHeight });
  } else {
    logger.info(`VDIFF [${role}] devtools check PASSED`, { heightGap, widthGap, innerH: viewport.height, outerH: viewport.outerHeight });
  }

  if (devToolsDetected) {
    devToolsWarning = {
      role,
      heightGap,
      widthGap,
      originalHeight: viewport.height,
      bypassHeight:   confirmedHeight,
      message: `DevTools bypass on ${role} tab (viewport ${viewport.height}px → ${confirmedHeight}px via virtual override)`
    };
  }

  const t1b       = Date.now();
  const actualDPR = (await execInPage(tabId, inPageGetDPR)) ?? 1;
  logger.info(`VDIFF [${role}] inPageGetDPR DONE`, { elapsed: ms(t1b), actualDPR });

  const t1c        = Date.now();
  const lockResult = await execInPage(tabId, inPageLockScrollbar);
  logger.info(`VDIFF [${role}] inPageLockScrollbar DONE`, {
    elapsed: ms(t1c), scrollbarWidth: lockResult?.scrollbarWidth ?? 0
  });

  const t2 = Date.now();
  await sendCDP(tabId, 'Emulation.setDeviceMetricsOverride',
    buildMetricsOverride(viewport, lockResult?.scrollbarWidth ?? 0, devToolsDetected ? confirmedHeight : undefined));
  logger.info(`VDIFF [${role}] setDeviceMetricsOverride DONE`, { elapsed: ms(t2), devToolsDetected });

  const t3 = Date.now();
  await execInPage(tabId, inPageFreezeAnimations, [FREEZE_STYLE_ID]);
  logger.info(`VDIFF [${role}] inPageFreezeAnimations DONE`, { elapsed: ms(t3) });

  const diffSelectors = selectorPairs.map(p => p.selector).filter(Boolean);

  const t4             = Date.now();
  const suppressResult = await execInPage(tabId, inPageSuppressFixed, [SUPPRESS_ATTR, diffSelectors]);
  logger.info(`VDIFF [${role}] inPageSuppressFixed DONE`, {
    elapsed:    ms(t4),
    suppressed: suppressResult?.suppressed ?? 'unknown',
    domSize:    suppressResult?.domSize    ?? 'unknown'
  });

  const t5 = Date.now();
  await execInPage(tabId, inPageScrollAndSettle, [0, SCROLL_SETTLE_TIMEOUT_MS]);
  logger.info(`VDIFF [${role}] scroll-to-0 DONE`, { elapsed: ms(t5) });

  const t6         = Date.now();
  const raw        = await execInPage(tabId, inPageGetRects, [selectorPairs]);
  const validRects = (raw ?? []).filter(r => r.found && r.usable);
  logger.info(`VDIFF [${role}] inPageGetRects DONE`, {
    elapsed:   ms(t6),
    total:     selectorPairs.length,
    valid:     validRects.length,
    missing:   (raw ?? []).filter(r => !r.found).length,
    invisible: (raw ?? []).filter(r => r.found && !r.usable).length
  });

  if (validRects.length === 0) {
    logger.warn(`VDIFF [${role}] 0 valid rects — aborting`, { tabId });
    return { manifest: new Map(), devToolsWarning };
  }

  const t6b           = Date.now();
  const pseudoResults = await execInPage(tabId, inPageGetPseudoStyles, [selectorPairs]);
  logger.info(`VDIFF [${role}] inPageGetPseudoStyles DONE`, {
    elapsed:    ms(t6b),
    withBefore: (pseudoResults ?? []).filter(p => p.before).length,
    withAfter:  (pseudoResults ?? []).filter(p => p.after).length
  });

  const { width: vpWidth, documentHeight } = viewport;
  const rawFrames = groupIntoKeyframes(validRects, confirmedHeight, vpWidth, documentHeight);
  const keyframes = prefixKeyframes(rawFrames, sessionId, role);

  logger.info(`VDIFF [${role}] keyframes grouped`, {
    validRects:    validRects.length,
    keyframeCount: keyframes.length,
    scrollYValues: keyframes.map(k => k.scrollY),
    confirmedHeight
  });

  const selectorById  = new Map(selectorPairs.map(p => [p.id, p]));
  const documentYById = new Map(validRects.map(r => [r.id, r.documentY]));

  const remeasureResults = await captureAllKeyframes(
    tabId, keyframes, selectorById, sessionId, role, actualDPR, documentHeight
  );

  const manifest = buildManifestFromRemeasured(
    keyframes, remeasureResults, documentYById, actualDPR, documentHeight, confirmedHeight
  );

  attachPseudoDataToManifest(manifest, pseudoResults ?? []);

  const t7          = Date.now();
  const rectRecords = buildElementRectRecords(sessionId, role, manifest);
  await storage.saveVisualElementRects(rectRecords);
  logger.info(`VDIFF [${role}] saveVisualElementRects DONE`, { elapsed: ms(t7), count: rectRecords.length });

  logger.info(`VDIFF [${role}] executeTabCapture COMPLETE`, {
    tabId, totalElapsed: ms(t0), manifestSize: manifest.size
  });

  return { manifest, devToolsWarning };
}

async function runTabCapture(tabId, selectorPairs, sessionId, role) {
  let attached = false;
  const t0 = Date.now();
  logger.info(`VDIFF [${role}] attach START`, { tabId });

  try {
    await tryAttach(tabId);
    attached = true;
    logger.info(`VDIFF [${role}] attach DONE`, { elapsed: ms(t0), tabId });
    const execResult = await executeTabCapture(tabId, selectorPairs, sessionId, role);
    return { manifest: execResult.manifest, devToolsWarning: execResult.devToolsWarning };

  } catch (err) {
    const msg = err?.message ?? String(err);
    logger.error(`VDIFF [${role}] FAILED`, { error: msg, elapsed: ms(t0), tabId });

    if (msg.includes('Another debugger is already attached')) {
      logger.warn(`VDIFF [${role}] debugger conflict on tab — stale session cleanup failed or user DevTools is open`, { tabId });
      return null;
    }
    throw err;

  } finally {
    if (attached) {
      logger.info(`VDIFF [${role}] restoring page + detaching`, { tabId });
      await safeRestorePage(tabId).catch(() => undefined);
      await safeDetach(tabId);
      logger.info(`VDIFF [${role}] detach DONE`, { tabId });
    }
  }
}

async function captureRoleSequential(tabId, selectorPairs, sessionId, role) {
  if (tabId === null || tabId === undefined) {
    logger.warn(`VDIFF [${role}] tabId is null, skipping`);
    return { manifest: new Map(), devToolsWarning: null };
  }
  const result = await runTabCapture(tabId, selectorPairs, sessionId, role);
  if (result === null) { return { manifest: new Map(), devToolsWarning: null }; }
  return { manifest: result.manifest ?? new Map(), devToolsWarning: result.devToolsWarning ?? null };
}

async function captureVisualDiffs(comparisonResult, tabContext) {
  const sessionStart = Date.now();
  logger.info('VDIFF captureVisualDiffs ENTER');

  if (!tabContext) {
    logger.warn('VDIFF no tabContext provided');
    return { status: 'skipped', reason: 'No tab context provided', diffs: new Map(), devToolsWarnings: [] };
  }

  const modified = extractModifiedElements(comparisonResult);
  logger.info('VDIFF modified elements count', {
    count:         modified.length,
    baselineTabId: tabContext.baselineTabId,
    compareTabId:  tabContext.compareTabId
  });

  if (modified.length === 0) {
    logger.warn('VDIFF 0 modified elements — nothing to capture');
    return { status: 'skipped', reason: 'No modified elements to capture', diffs: new Map(), devToolsWarnings: [] };
  }

  const sessionId                       = crypto.randomUUID();
  const { baselineTabId, compareTabId } = tabContext;
  const baselinePairs                   = buildSelectorPairs(modified, 'baseline');
  const comparePairs                    = buildSelectorPairs(modified, 'compare');

  logger.info('VDIFF session init', {
    sessionId,
    sameTab:       baselineTabId === compareTabId,
    baselinePairs: baselinePairs.length,
    comparePairs:  comparePairs.length,
    baselineTabId,
    compareTabId
  });

  try {
    logger.info('VDIFF running SEQUENTIAL (bringToFront requires exclusive focus)');
    const baselineResult  = await captureRoleSequential(baselineTabId, baselinePairs, sessionId, 'baseline');
    const compareResult   = await captureRoleSequential(compareTabId,  comparePairs,  sessionId, 'compare');
    const baselineManifest = baselineResult.manifest ?? new Map();
    const compareManifest  = compareResult.manifest  ?? new Map();
    const devToolsWarnings = [baselineResult.devToolsWarning, compareResult.devToolsWarning].filter(Boolean);

    logger.info('VDIFF both tabs captured', {
      baselineSize:    baselineManifest.size,
      compareSize:     compareManifest.size,
      devToolsBlocked: devToolsWarnings.length,
      elapsed:         ms(sessionStart)
    });

    if (baselineManifest.size === 0 && compareManifest.size === 0) {
      if (devToolsWarnings.length > 0) {
        return {
          status:          'skipped',
          reason:          'DevTools bypass ran but produced no screenshots — close DevTools and retry.',
          diffs:           new Map(),
          devToolsWarnings
        };
      }
      return {
        status:          'skipped',
        reason:          'Could not attach debugger to either tab. Close DevTools on both pages and retry.',
        diffs:           new Map(),
        devToolsWarnings: []
      };
    }

    const diffs = buildDiffMap(modified, baselineManifest, compareManifest);
    logger.info('VDIFF captureVisualDiffs COMPLETE', {
      sessionId, diffCount: diffs.size, totalElapsed: ms(sessionStart)
    });

    return { status: 'completed', reason: null, diffs, sessionId, devToolsWarnings };

  } catch (err) {
    logger.error('VDIFF captureVisualDiffs FAILED', {
      error: err.message, elapsed: ms(sessionStart), sessionId
    });
    return { status: 'failed', reason: err.message, diffs: new Map(), devToolsWarnings: [] };
  }
}

export { captureVisualDiffs };


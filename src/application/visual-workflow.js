import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/storage.js';
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
const SCROLL_VERIFY_TOLERANCE_PX = 5;
const SCROLL_VERIFY_RETRY_MAX    = 2;
const SCROLL_VERIFY_RETRY_MS     = 400;

function ms(start) {
  return `${Date.now() - start}ms`;
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`CDP timeout: ${label} after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

function inPageGetViewport() {
  const width  = Math.floor(window.innerWidth);
  const height = Math.floor(window.innerHeight);
  const documentHeight = document.documentElement.scrollHeight;
  return { width, height, documentHeight };
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
    document.body.style.setProperty('padding-right', scrollbarW + 'px', 'important');
  }
  return { scrollbarWidth: scrollbarW };
}

function inPageUnlockScrollbar() {
  document.body.style.removeProperty('overflow');
  document.body.style.removeProperty('padding-right');
}

function inPageFreezeAnimations(styleId) {
  if (document.getElementById(styleId)) return;
  const style = document.createElement('style');
  style.id          = styleId;
  style.textContent = '*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; }';
  document.head.appendChild(style);
}

function inPageRestoreAnimations(styleId) {
  document.getElementById(styleId)?.remove();
}

function inPageSuppressFixed(markAttr, diffSelectors) {
  const protectedEls       = new Set();
  const protectedAncestors = new Set();

  for (const sel of (diffSelectors || [])) {
    const el = document.querySelector(sel);
    if (!el) continue;
    protectedEls.add(el);
    let ancestor = el.parentElement;
    while (ancestor && ancestor !== document.documentElement) {
      protectedAncestors.add(ancestor);
      ancestor = ancestor.parentElement;
    }
  }

  const all    = document.querySelectorAll('*');
  const toHide = [];
  for (const domEl of all) {
    if (protectedEls.has(domEl) || protectedAncestors.has(domEl)) continue;
    const { position } = getComputedStyle(domEl);
    if (position === 'fixed' || position === 'sticky') toHide.push(domEl);
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
  return new Promise(resolve => {
    const fallback = setTimeout(resolve, fallbackMs);
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(fallback);
      resolve();
    })));
  });
}

function inPageGetRects(selectorPairs) {
  const { scrollY } = window;
  return selectorPairs.map(({ id, selector }) => {
    const domEl = selector ? document.querySelector(selector) : null;
    if (!domEl) return { id, found: false, usable: false };
    const r = domEl.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w === 0 && h === 0) return { id, found: true, usable: false };
    return {
      id,
      found:     true,
      usable:    true,
      documentY: Math.round(r.top + scrollY),
      height:    h,
      width:     w,
      left:      Math.round(r.left)
    };
  });
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
    if (!content || content === 'none' || content === 'normal' || content === '""' || content === "''") return null;
    const styles = Object.create(null);
    for (const p of PSEUDO_PROPS) {
      const val = cs.getPropertyValue(p);
      if (val) styles[p] = val;
    }
    return styles;
  }

  return selectorPairs.map(({ id, selector }) => {
    const el = selector ? document.querySelector(selector) : null;
    if (!el) return { id, before: null, after: null };
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

function buildMetricsOverride(viewport) {
  return {
    width:             Math.round(viewport.width),
    height:            Math.round(viewport.height),
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

function buildViewportRects(keyframes, validRects, actualDPR, documentHeight) {
  const rectById = new Map(validRects.map(r => [r.id, r]));
  const manifest = new Map();

  for (const kf of keyframes) {
    for (const elId of kf.elementIds) {
      const el = rectById.get(elId);
      if (!el) continue;
      manifest.set(elId, {
        keyframeId:          kf.id,
        actualDPR,
        dpr:                 CAPTURE_SCALE_FACTOR,
        kfScrollY:           kf.scrollY,
        documentY:           el.documentY,
        totalDocumentHeight: documentHeight,
        viewportRect: {
          x:      el.left,
          y:      el.documentY - kf.scrollY,
          width:  el.width,
          height: el.height
        }
      });
    }
  }

  return manifest;
}

function attachPseudoDataToManifest(manifest, pseudoResults) {
  if (!pseudoResults?.length) return;
  for (const { id, before, after } of pseudoResults) {
    const entry = manifest.get(id);
    if (!entry) continue;
    if (before) entry.pseudoBefore = { ...before, parentHpid: id, pseudoType: 'before' };
    if (after)  entry.pseudoAfter  = { ...after,  parentHpid: id, pseudoType: 'after'  };
  }
}

function buildElementRectRecords(sessionId, role, manifest) {
  const records = [];
  for (const [elementKey, entry] of manifest.entries()) {
    const { keyframeId, viewportRect, actualDPR, documentY, totalDocumentHeight, pseudoBefore, pseudoAfter } = entry;
    records.push({
      id:                  `${sessionId}_${role}_rect_${elementKey}`,
      sessionId,
      elementKey,
      tabRole:             role,
      keyframeId,
      rect:                viewportRect,
      actualDPR,
      documentY,
      totalDocumentHeight,
      pseudoBefore:        pseudoBefore ?? null,
      pseudoAfter:         pseudoAfter  ?? null
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
    if (!baselineEntry && !compareEntry) continue;
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
  if (!roleEl) return null;
  const { cssSelector } = roleEl;
  if (!cssSelector) return null;
  return { id: element.baselineElement.hpid, selector: cssSelector };
}

function buildSelectorPairs(elements, role) {
  return elements.map(el => extractSelectorPair(el, role)).filter(Boolean);
}

async function captureKeyframe(tabId, keyframe, sessionId, index, total, roleStart, actualDPR, documentHeight) {
  const { id, scrollY, viewportWidth, viewportHeight, tabRole } = keyframe;
  const kfTag = `[kf ${index + 1}/${total} scrollY=${scrollY}]`;

  const t0 = Date.now();
  logger.info(`VDIFF ${kfTag} scroll START`, { tabId, role: tabRole });
  await execInPage(tabId, inPageScrollAndSettle, [scrollY, SCROLL_SETTLE_TIMEOUT_MS]);
  logger.info(`VDIFF ${kfTag} scroll+paint DONE`, { elapsed: ms(t0) });

  for (let attempt = 0; attempt < SCROLL_VERIFY_RETRY_MAX; attempt++) {
    const actualY = await execInPage(tabId, () => window.scrollY);
    if (Math.abs(actualY - scrollY) <= SCROLL_VERIFY_TOLERANCE_PX) break;
    logger.warn(`VDIFF ${kfTag} scroll mismatch`, { expected: scrollY, actual: actualY, attempt });
    await execInPage(tabId, inPageScrollAndSettle, [scrollY, SCROLL_VERIFY_RETRY_MS]);
  }

  const t1 = Date.now();
  await sendCDP(tabId, 'Page.bringToFront');
  logger.info(`VDIFF ${kfTag} CDP captureScreenshot START`);
  const result = await sendCDP(tabId, 'Page.captureScreenshot', {
    format:           'webp',
    quality:          CAPTURE_QUALITY,
    fromSurface:      true,
    optimizeForSpeed: false
  }, CDP_CAPTURE_TIMEOUT_MS);
  logger.info(`VDIFF ${kfTag} CDP captureScreenshot DONE`, {
    elapsed:  ms(t1),
    b64Bytes: result?.data?.length ?? 0
  });

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
    scrollY,
    viewportWidth,
    viewportHeight,
    documentHeight,
    captureScaleFactor: CAPTURE_SCALE_FACTOR,
    devicePixelRatio:   actualDPR,
    capturedAt:         Date.now()
  });
  logger.info(`VDIFF ${kfTag} IDB saveVisualKeyframe DONE`, { elapsed: ms(t4) });
  logger.info(`VDIFF ${kfTag} COMPLETE`, { totalElapsed: ms(roleStart) });
}

async function captureAllKeyframes(tabId, keyframes, sessionId, role, actualDPR, documentHeight) {
  const total     = keyframes.length;
  const roleStart = Date.now();
  logger.info(`VDIFF [${role}] captureAllKeyframes START`, { tabId, keyframeCount: total });

  for (let i = 0; i < total; i++) {
    await captureKeyframe(tabId, keyframes[i], sessionId, i, total, roleStart, actualDPR, documentHeight);
  }

  logger.info(`VDIFF [${role}] captureAllKeyframes DONE`, {
    tabId, keyframeCount: total, totalElapsed: ms(roleStart)
  });
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
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (e) {
    logger.warn(`VDIFF getTargets failed — proceeding with attach`, { error: e.message });
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

  const t1       = Date.now();
  const viewport = await execInPage(tabId, inPageGetViewport);
  logger.info(`VDIFF [${role}] inPageGetViewport DONE`, { elapsed: ms(t1), viewport });
  if (!viewport) throw new Error(`Failed to read viewport from tab ${tabId}`);

  const t1b       = Date.now();
  const actualDPR = (await execInPage(tabId, inPageGetDPR)) ?? 1;
  logger.info(`VDIFF [${role}] inPageGetDPR DONE`, { elapsed: ms(t1b), actualDPR });

  const t1c        = Date.now();
  const lockResult = await execInPage(tabId, inPageLockScrollbar);
  logger.info(`VDIFF [${role}] inPageLockScrollbar DONE`, {
    elapsed: ms(t1c), scrollbarWidth: lockResult?.scrollbarWidth ?? 0
  });

  const t2 = Date.now();
  await sendCDP(tabId, 'Emulation.setDeviceMetricsOverride', buildMetricsOverride(viewport));
  logger.info(`VDIFF [${role}] setDeviceMetricsOverride DONE`, { elapsed: ms(t2) });

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
    return new Map();
  }

  const t6b           = Date.now();
  const pseudoResults = await execInPage(tabId, inPageGetPseudoStyles, [selectorPairs]);
  logger.info(`VDIFF [${role}] inPageGetPseudoStyles DONE`, {
    elapsed:    ms(t6b),
    withBefore: (pseudoResults ?? []).filter(p => p.before).length,
    withAfter:  (pseudoResults ?? []).filter(p => p.after).length
  });

  const { height: vpHeight, width: vpWidth, documentHeight } = viewport;
  const rawFrames = groupIntoKeyframes(validRects, vpHeight, vpWidth, documentHeight);
  const keyframes = prefixKeyframes(rawFrames, sessionId, role);
  const manifest  = buildViewportRects(keyframes, validRects, actualDPR, documentHeight);

  attachPseudoDataToManifest(manifest, pseudoResults ?? []);

  logger.info(`VDIFF [${role}] keyframes grouped`, {
    validRects:    validRects.length,
    keyframeCount: keyframes.length,
    scrollYValues: keyframes.map(k => k.scrollY)
  });

  await captureAllKeyframes(tabId, keyframes, sessionId, role, actualDPR, documentHeight);

  const t7          = Date.now();
  const rectRecords = buildElementRectRecords(sessionId, role, manifest);
  await storage.saveVisualElementRects(rectRecords);
  logger.info(`VDIFF [${role}] saveVisualElementRects DONE`, { elapsed: ms(t7), count: rectRecords.length });

  logger.info(`VDIFF [${role}] executeTabCapture COMPLETE`, {
    tabId, totalElapsed: ms(t0), manifestSize: manifest.size
  });

  return manifest;
}

async function runTabCapture(tabId, selectorPairs, sessionId, role) {
  let attached = false;
  const t0 = Date.now();
  logger.info(`VDIFF [${role}] attach START`, { tabId });

  try {
    await tryAttach(tabId);
    attached = true;
    logger.info(`VDIFF [${role}] attach DONE`, { elapsed: ms(t0), tabId });
    return await executeTabCapture(tabId, selectorPairs, sessionId, role);

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
  if (tabId == null) {
    logger.warn(`VDIFF [${role}] tabId is null, skipping`);
    return new Map();
  }
  const result = await runTabCapture(tabId, selectorPairs, sessionId, role);
  if (result === null) return new Map();
  return result;
}

async function captureVisualDiffs(comparisonResult, tabContext) {
  const sessionStart = Date.now();
  logger.info('VDIFF captureVisualDiffs ENTER');

  if (!tabContext) {
    logger.warn('VDIFF no tabContext provided');
    return { status: 'skipped', reason: 'No tab context provided', diffs: new Map() };
  }

  const modified = extractModifiedElements(comparisonResult);
  logger.info('VDIFF modified elements count', {
    count:         modified.length,
    baselineTabId: tabContext.baselineTabId,
    compareTabId:  tabContext.compareTabId
  });

  if (modified.length === 0) {
    logger.warn('VDIFF 0 modified elements — nothing to capture');
    return { status: 'skipped', reason: 'No modified elements to capture', diffs: new Map() };
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
    const baselineManifest = await captureRoleSequential(baselineTabId, baselinePairs, sessionId, 'baseline');
    const compareManifest  = await captureRoleSequential(compareTabId,  comparePairs,  sessionId, 'compare');

    logger.info('VDIFF both tabs captured', {
      baselineSize: baselineManifest.size,
      compareSize:  compareManifest.size,
      elapsed:      ms(sessionStart)
    });

    if (baselineManifest.size === 0 && compareManifest.size === 0) {
      return {
        status: 'skipped',
        reason: 'Could not attach debugger to either tab. Close DevTools on both pages and retry.',
        diffs:  new Map()
      };
    }

    const diffs = buildDiffMap(modified, baselineManifest, compareManifest);
    logger.info('VDIFF captureVisualDiffs COMPLETE', {
      sessionId, diffCount: diffs.size, totalElapsed: ms(sessionStart)
    });
    return { status: 'completed', reason: null, diffs, sessionId };

  } catch (err) {
    logger.error('VDIFF captureVisualDiffs FAILED', {
      error: err.message, elapsed: ms(sessionStart), sessionId
    });
    return { status: 'failed', reason: err.message, diffs: new Map() };
  }
}

export { captureVisualDiffs };
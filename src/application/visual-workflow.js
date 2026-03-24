/**
 * Visual diff capture workflow: scrolls both comparison tabs through their
 * modified elements, screenshots each keyframe via CDP, and stores blobs and
 * rect manifests in IDB. Runs in the MV3 service worker.
 *
 * Architecture note: CDP (not captureVisibleTab) is used because only CDP exposes
 * Emulation.setScriptExecutionDisabled, which freezes the main thread between
 * inPageRemeasureRects and Page.captureScreenshot to eliminate layout-shift races.
 * Captures run sequentially (baseline → compare) because Page.bringToFront
 * requires exclusive tab focus and cannot be parallelised.
 *
 * inPage* functions are serialised and injected into the page's MAIN JS context
 * via chrome.scripting.executeScript. They cannot close over any SW-scope variables —
 * all inputs must be passed as the args array.
 *
 * Callers: compare-workflow.js (captureVisualDiffs via runVisualPhase).
 */
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
const SCROLL_SETTLE_TOLERANCE_PX = 2;   // max compositor lead (one vsync × residual velocity)
const SCROLL_VERIFY_TOLERANCE_PX = 5;
const SCROLL_VERIFY_RETRY_MAX    = 2;
const SCROLL_VERIFY_RETRY_MS     = 400;
// Gap between window.outerHeight and window.innerHeight when DevTools is docked.
// At 100% zoom without DevTools the gap is ~88px (browser chrome only).
// The minimum DevTools panel is 150px, giving ~238px with DevTools open.
// 200 sits safely between both values; false positives only occur at >~110% zoom
// where capture geometry would already be wrong.
const DEVTOOLS_HEIGHT_THRESHOLD_PX = 200;
// Estimated height of Chrome's browser chrome (tab bar + address bar) on all platforms.
// Used to derive the true content-viewport height from outerHeight when DevTools is open.
const BROWSER_CHROME_HEIGHT_PX = 88;

/** Returns a human-readable elapsed-time string since `start` (Date.now()). */
function ms(start) {
  return `${Date.now() - start}ms`;
}

/**
 * Races a promise against a rejection timeout. Used to bound all CDP commands
 * so a hung debugger session does not block the SW indefinitely.
 */
function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`CDP timeout: ${label} after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

/**
 * IN-PAGE — runs in the tab's MAIN JS context via execInPage.
 * Returns viewport and document dimensions including outerHeight/outerWidth for
 * the DevTools-open detection check in executeTabCapture.
 */
function inPageGetViewport() {
  const width  = Math.floor(window.innerWidth);
  const height = Math.floor(window.innerHeight);
  const documentHeight = document.documentElement.scrollHeight;
  // outerHeight/outerWidth are used by the DevTools-open check in executeTabCapture.
  // They represent the full OS window size; the gap vs innerHeight grows when DevTools
  // is docked because the panel steals height from the content viewport.
  const outerHeight = Math.floor(window.outerHeight);
  const outerWidth  = Math.floor(window.outerWidth);
  return { width, height, documentHeight, outerHeight, outerWidth };
}

/** IN-PAGE — returns the page's devicePixelRatio for DPR-aware rect scaling. */
function inPageGetDPR() {
  return window.devicePixelRatio;
}

/**
 * IN-PAGE — hides the scrollbar by setting overflow:hidden and compensates with
 * equivalent padding-right so page layout does not reflow across a CSS breakpoint.
 * Returns the measured scrollbar width so the SW can pass it to buildMetricsOverride.
 */
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

/** IN-PAGE — reverses inPageLockScrollbar, restoring overflow and padding-right. */
function inPageUnlockScrollbar() {
  document.body.style.removeProperty('overflow');
  document.body.style.removeProperty('padding-right');
}

/**
 * IN-PAGE — kills CSS animations/transitions and patches the scroll APIs to strip
 * behavior:'smooth' from ScrollToOptions. The scroll API wraps are permanent for the
 * tab's JS lifetime (see inPageRestoreAnimations for why they are not unwrapped).
 */
function inPageFreezeAnimations(styleId) {
  if (document.getElementById(styleId)) { return; }
  const style = document.createElement('style');
  style.id          = styleId;
  // scroll-behavior: auto covers the CSS-default case (html { scroll-behavior: smooth }).
  // It does NOT cover window.scrollTo({ behavior: 'smooth' }) — the explicit options dict
  // bypasses the CSS property and goes straight to the Blink compositor's SmoothScroll().
  // The API patch below handles that path.
  style.textContent = [
    'html, body { scroll-behavior: auto !important; }',
    '*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; }'
  ].join(' ');
  document.head.appendChild(style);

  // Scroll API patch — strips explicit behavior:'smooth' from ScrollToOptions so that
  // CSS scroll-behavior:auto actually takes effect.  The {behavior:'smooth'} form is
  // resolved by Blink's ScrollBehavior enum BEFORE the CSS property is consulted, so
  // css-only overrides cannot stop it.  This patch intercepts all scroll entry points.
  //
  // Guard: __vdiffScrollPatched prevents double-wrapping if inPageFreezeAnimations is
  // called more than once in the same document lifetime.
  if (!window.__vdiffScrollPatched) {
    window.__vdiffScrollPatched = true;

    (function patchScrollAPIs() {
      function stripSmooth(args) {
        if (args.length === 1 && args[0] !== null && typeof args[0] === 'object') {
          // Clone and force behavior to 'auto' — never mutate the caller's object.
          return [Object.assign({}, args[0], { behavior: 'auto' })];
        }
        // Two-argument form scrollTo(x, y) — already treated as instant by the browser.
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
      // Element.prototype covers window.scroll* via the prototype chain AND covers
      // document.documentElement.scrollTo / document.body.scrollTo because both
      // HTMLHtmlElement and HTMLBodyElement inherit from Element.
      wrap(Element.prototype,   'scrollTo');
      wrap(Element.prototype,   'scrollBy');
      wrap(Element.prototype,   'scrollIntoView');
    })();
  }
}

/**
 * IN-PAGE — removes the freeze <style> tag, restoring CSS transitions and animations.
 * The scroll API prototype wraps from inPageFreezeAnimations are NOT removed — unwrapping
 * them would require holding a reference to the original function across injections, which
 * is not safe. The wraps are identity-preserving for the two-argument scroll form and only
 * strip behavior:'smooth' from ScrollToOptions, which is harmless to leave in place.
 */
function inPageRestoreAnimations(styleId) {
  document.getElementById(styleId)?.remove();
}

/**
 * IN-PAGE — hides all position:fixed and position:sticky elements except those
 * that are the target of a diff (and their ancestors/descendants). Fixed elements
 * at different scroll positions would otherwise appear in every keyframe screenshot,
 * corrupting the crop coordinates for elements beneath them.
 */
function inPageSuppressFixed(markAttr, diffSelectors) {
  const protectedEls       = new Set();
  const protectedAncestors = new Set();
  // Descendants must also be protected: a position:fixed child (dropdown, toast)
  // of a diffed element is neither in protectedEls nor protectedAncestors and
  // would otherwise be hidden, corrupting the parent element's visual state.
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

/** IN-PAGE — reverses inPageSuppressFixed by removing the display:none and the marker attribute. */
function inPageRestoreFixed(markAttr) {
  for (const domEl of document.querySelectorAll(`[${markAttr}]`)) {
    domEl.style.removeProperty('display');
    domEl.removeAttribute(markAttr);
  }
}

/**
 * IN-PAGE — scrolls to targetY and resolves when scrollY is stable within tolerance
 * for two consecutive animation frames. A hard setTimeout fires unconditionally to
 * guarantee exit even when rAF is throttled in background tabs.
 */
function inPageScrollAndSettle(targetY, fallbackMs) {
  // Stability-poll design — reads window.scrollY each vsync tick and resolves
  // only when the value is stable for two consecutive frames AND within tolerance
  // of targetY.  This catches smooth-scroll animations that 3-rAF cannot.
  //
  // CRITICAL: the deadline check lives INSIDE the rAF callback.  Chrome throttles
  // rAF in background tabs to 1fps — if the rAF budget runs out before the deadline
  // fires, the promise hangs indefinitely.  The hard setTimeout fires unconditionally
  // (even in hidden/background tabs) and is the guaranteed exit hatch.
  //
  // This was the original design; it was accidentally dropped when the stability
  // poll was introduced, causing the compare-tab capture to hang until the user
  // manually clicked on the tab (visible tab → rAF unthrottled → poll resolves).
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

    // Hard deadline — fires even when rAF is throttled/suspended in background tabs.
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

/**
 * IN-PAGE — measures bounding rects for all selector pairs at the current scroll
 * position. Flags ambiguous selectors (more than one DOM match) so the caller can
 * fall back to an XPath selector rather than using potentially the wrong element.
 */
function inPageGetRects(selectorPairs) {
  const { scrollY } = window;
  return selectorPairs.map(({ id, selector }) => {
    const domEl = selector ? document.querySelector(selector) : null;
    if (!domEl) { return { id, found: false, usable: false }; }

    // Uniqueness guard: if more than one element matches this selector,
    // querySelector always returns the FIRST in document order — which may be
    // a completely different element from the one originally detected.  Flag it
    // so the caller can fall back to a positional XPath selector.
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

/**
 * IN-PAGE — re-measures bounding rects after the page has been scrolled to the
 * keyframe position. Returns the actual scrollY alongside rects so the manifest
 * builder can detect drift between planned and actual scroll. Flags ambiguous
 * selectors as inViewport:false to show an amber badge rather than confident
 * but potentially wrong crop coordinates.
 */
function inPageRemeasureRects(selectorPairs) {
  const actualScrollY = Math.round(window.scrollY);
  const vpH           = window.innerHeight;
  const vpW           = window.innerWidth;

  const rects = selectorPairs.map(({ id, selector }) => {
    const el = selector ? document.querySelector(selector) : null;
    if (!el) {
      return { id, found: false, inViewport: false, misalignReason: 'element-not-found' };
    }

    // Selector uniqueness guard — querySelector always returns the first DOM match.
    // On resource grids (e.g. informatica.com/resources.html) every card shares the
    // same generated selector, so we may be re-measuring card 1 while the screenshot
    // keyframe was planned around card 4.  Force inViewport:false so
    // buildManifestFromRemeasured stores misaligned:true and the report shows an amber
    // badge rather than a confidently-wrong highlight drawn at the wrong coordinates.
    const matchCount        = selector ? document.querySelectorAll(selector).length : 1;
    const selectorAmbiguous = matchCount > 1;

    const r = el.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w === 0 && h === 0) {
      return {
        id, found: true, inViewport: false,
        // selectorAmbiguous is an identity annotation — NOT a spatial misalignment.
        // zero-dimension is the spatial reason here regardless of selector uniqueness.
        misalignReason: 'zero-dimension',
        selectorAmbiguous,
        selectorMatchCount: matchCount,
        viewportX: Math.round(r.left), viewportY: Math.round(r.top),
        width: 0, height: 0
      };
    }
    // selectorAmbiguous does NOT affect inViewport: the element IS spatially in the
    // viewport.  The ambiguity is about which element was measured (identity), not
    // where it is (position).  Setting inViewport:false here caused every card-grid
    // element to show "Potentially misaligned" even when perfectly captured.
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

/**
 * IN-PAGE — reads ::before and ::after computed styles for each selector. Returns
 * null for a pseudo-element if its content property is empty or 'none', indicating
 * no visible pseudo content to capture.
 */
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

/**
 * Sends a CDP command to the attached debugger on a tab, bounded by CDP_COMMAND_TIMEOUT_MS.
 * All CDP calls in this module go through here to enforce a consistent timeout.
 */
function sendCDP(tabId, method, params, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
  return withTimeout(
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}),
    timeoutMs,
    `${method} tabId=${tabId}`
  );
}

/**
 * Injects and executes a function in the tab's MAIN JS world, returning the result.
 * MAIN world (not ISOLATED) is required so the function can read page globals like
 * window.scrollY and document.body — the isolated world has a separate JS environment.
 */
function execInPage(tabId, func, args) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func,
    args:   args ?? [],
    world:  'MAIN'
  }).then(results => results?.[0]?.result);
}

/**
 * Converts a base64-encoded string to a Blob via a data URI fetch.
 * CDP's Page.captureScreenshot returns raw base64 — this is the lightest
 * conversion path available in the SW without a TextDecoder loop.
 */
async function base64ToBlob(base64Data, mimeType) {
  const response = await fetch(`data:${mimeType};base64,${base64Data}`);
  return response.blob();
}

/**
 * Builds the params object for Emulation.setDeviceMetricsOverride. scrollbarWidth
 * is added to the width so the content area equals the viewport width after
 * inPageLockScrollbar adds an equivalent padding-right — without this the layout
 * may cross a CSS responsive breakpoint. targetHeight overrides viewport.height
 * only when the DevTools bypass computes a virtual height; undefined falls through
 * to viewport.height so existing call sites without a bypass are unaffected.
 */
function buildMetricsOverride(viewport, scrollbarWidth = 0, targetHeight) {
  return {
    width:             Math.round(viewport.width) + Math.round(scrollbarWidth || 0),
    height:            Math.round(targetHeight ?? viewport.height),
    deviceScaleFactor: CAPTURE_SCALE_FACTOR,
    mobile:            false
  };
}

/**
 * Stamps each keyframe with a session-scoped ID, sessionId, and tabRole before
 * storage. Without prefixing, keyframe IDs from baseline and compare captures
 * for different sessions would collide in the STORE_VISUAL_KEYFRAMES store.
 */
function prefixKeyframes(keyframes, sessionId, role) {
  return keyframes.map(kf => ({
    ...kf,
    id:       `${sessionId}_${role}_${kf.id}`,
    sessionId,
    tabRole:  role
  }));
}

/**
 * Builds the per-element manifest from the remeasured viewport rects that were
 * observed AFTER scrolling to each keyframe position.
 *
 * @param {Array}  keyframes        - prefixed keyframe objects (id + elementIds)
 * @param {Array}  remeasureResults - [{keyframeId, actualScrollY, rects:[…]}]
 * @param {Map}    documentYById    - hpid → documentY at scrollY=0 (for fallback logging)
 * @param {number} actualDPR
 * @param {number} documentHeight
 * @param {number} viewportHeight   - CSS-px height of the viewport at capture time,
 *                                    used to clip element rects to the screenshot boundary
 * @returns {Map<string, object>}   hpid → manifest entry
 */
function buildManifestFromRemeasured(keyframes, remeasureResults, documentYById, actualDPR, documentHeight, viewportHeight) {
  const resultByKfId = new Map(remeasureResults.map(r => [r.keyframeId, r]));
  const manifest     = new Map();
  // Defensive fallback: if viewportHeight is missing (old callers), skip clipping.
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

      // Clip viewportRect to the screenshot boundary.
      //
      //  getBoundingClientRect() can return elements taller than the viewport — e.g.
      //  a full-page wrapper div (height: 5905px) or a hero section (726px in a
      //  632px viewport).  If we store the raw height, computeCropParams receives
      //  rh=5905, hits the 0.25 minimum scale floor, and renders hH = 5905×0.25 =
      //  1476px — a full-width strip with no useful content visible.
      //
      //  We store the VISIBLE SLICE (clamped to the screenshot boundary) in
      //  viewportRect, and the RAW geometry in rawViewportRect so renderers that
      //  need the true size (e.g. future diff-signal displays) can access it.
      const rawY   = m.viewportY;
      const rawH   = m.height;
      const clippedY      = Math.max(0, rawY);
      const clippedBottom = Math.min(rawY + rawH, vpH);
      const clippedH      = Math.max(1, clippedBottom - clippedY);
      const rectClipped   = clippedH < rawH;

      // Defensive: element completely below screenshot fold (shouldn't happen given
      // inViewport check, but guard anyway).
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
      // Raw rect preserved separately — allows renderers to display true element
      // dimensions in tooltips without corrupting crop coordinates.
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
        // misalignReason is spatial only — never set to 'selector-ambiguous' here.
        misalignReason:      misaligned ? m.misalignReason : undefined,
        selectorAmbiguous:   m.selectorAmbiguous  ?? false,
        selectorMatchCount:  m.selectorMatchCount ?? null,
        rectClipped
      });
    }
  }

  return manifest;
}

/**
 * Merges ::before / ::after computed style data from inPageGetPseudoStyles into
 * the manifest entries in place. Entries with no pseudo content are left unchanged.
 */
function attachPseudoDataToManifest(manifest, pseudoResults) {
  if (!pseudoResults?.length) { return; }
  for (const { id, before, after } of pseudoResults) {
    const entry = manifest.get(id);
    if (!entry) { continue; }
    if (before) { entry.pseudoBefore = { ...before, parentHpid: id, pseudoType: 'before' }; }
    if (after)  { entry.pseudoAfter  = { ...after,  parentHpid: id, pseudoType: 'after'  }; }
  }
}

/**
 * Flattens the manifest Map into an array of IDB-ready rect records, one per element
 * per tab role. These are written to STORE_VISUAL_ELEMENT_RECTS and read back by
 * the popup's visual diff renderer to draw highlight overlays.
 */
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

/**
 * Builds the final diff Map keyed by hpid. Only elements with at least one manifest
 * entry (baseline or compare) are included — elements where both manifests returned
 * nothing (e.g. not found in either tab) are dropped silently.
 */
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

/** Filters comparison results to only elements that have at least one CSS difference. */
function extractModifiedElements(comparisonResult) {
  return comparisonResult.comparison.results.filter(r => (r.totalDifferences ?? 0) > 0);
}

/**
 * Extracts the CSS selector for one side of a matched element pair. Returns null
 * if the element for the given role is absent (unmatched) or has no cssSelector.
 * The HPID of the baseline element is always used as the shared identifier regardless
 * of role so baseline and compare entries align in the diff map.
 */
function extractSelectorPair(element, role) {
  const roleEl = role === 'baseline' ? element.baselineElement : element.compareElement;
  if (!roleEl) { return null; }
  const { cssSelector } = roleEl;
  if (!cssSelector) { return null; }
  return { id: element.baselineElement.hpid, selector: cssSelector };
}

/** Maps a list of modified elements to selector pairs for one role, dropping nulls. */
function buildSelectorPairs(elements, role) {
  return elements.map(el => extractSelectorPair(el, role)).filter(Boolean);
}

async function captureKeyframe(tabId, keyframe, kfSelectorPairs, sessionId, index, total, roleStart, actualDPR, documentHeight) {
  const { id, scrollY, viewportWidth, viewportHeight, tabRole } = keyframe;
  const kfTag = `[kf ${index + 1}/${total} scrollY=${scrollY}]`;

  // ── 1. Bring tab to front FIRST ──────────────────────────────────────────
  //
  //  Critical ordering fix: bringToFront must happen BEFORE scrolling.
  //  When a background tab gains focus for the first time, Chrome can fire
  //  visibility/focus events that reset window.scrollY to 0. If we scroll
  //  first and then bring the tab to front, those focus events undo our scroll
  //  and the screenshot captures the wrong position.
  //
  //  This only bites on the FIRST keyframe for any tab that isn't already
  //  in the foreground (i.e., always hits the compare tab's kf_0, explaining
  //  the "always fails on the first compare screenshot" symptom).
  //
  await sendCDP(tabId, 'Page.bringToFront');
  logger.info(`VDIFF ${kfTag} bringToFront DONE`, { tabId, role: tabRole });

  // ── 2. Scroll ────────────────────────────────────────────────────────────
  const t0 = Date.now();
  logger.info(`VDIFF ${kfTag} scroll START`, { tabId, role: tabRole });
  await execInPage(tabId, inPageScrollAndSettle, [scrollY, SCROLL_SETTLE_TIMEOUT_MS]);
  logger.info(`VDIFF ${kfTag} scroll+paint DONE`, { elapsed: ms(t0) });

  // ── 3. Verify scroll landed correctly (retry if needed) ──────────────────
  let actualScrollY = scrollY;
  for (let attempt = 0; attempt < SCROLL_VERIFY_RETRY_MAX; attempt++) {
    const readY = await execInPage(tabId, () => Math.round(window.scrollY));
    actualScrollY = readY;
    if (Math.abs(readY - scrollY) <= SCROLL_VERIFY_TOLERANCE_PX) { break; }
    logger.warn(`VDIFF ${kfTag} scroll mismatch`, { expected: scrollY, actual: readY, attempt });
    await execInPage(tabId, inPageScrollAndSettle, [scrollY, SCROLL_VERIFY_RETRY_MS]);
  }

  // ── 4. Re-measure element rects at the ACTUAL scroll position ────────────
  //
  //  getBoundingClientRect() is called here, with the page in its final
  //  rendered state at this scroll, giving us the exact pixel coordinates
  //  that will match the screenshot we're about to take.
  //
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

  // ── 5. Screenshot ────────────────────────────────────────────────────────
  //
  //  Freeze JS execution on the main thread BEFORE capturing.  inPageFreezeAnimations
  //  kills CSS transitions/animations, but does NOT stop IntersectionObserver callbacks,
  //  MutationObserver callbacks, scroll event listeners, page rAF callbacks, or
  //  setTimeout callbacks — any of which can shift element positions in the IPC
  //  round-trip window between inPageRemeasureRects and Page.captureScreenshot.
  //  setScriptExecutionDisabled blocks the main-thread task queue; the compositor
  //  thread keeps running so fromSurface:true capture still works.
  //
  //  try/finally guarantees re-enable even if captureScreenshot times out or throws —
  //  without it a throw would leave the tab with JS permanently disabled.
  //
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
    // Always re-enable JS — if captureScreenshot threw, the tab must not be left frozen.
    await sendCDP(tabId, 'Emulation.setScriptExecutionDisabled', { value: false });
    logger.info(`VDIFF ${kfTag} JS unfreeze DONE`);
  }

  // ── 6. Persist blob + keyframe metadata ──────────────────────────────────
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

  // ── 7. Return observed data for manifest building ─────────────────────────
  return {
    keyframeId:    id,
    actualScrollY: confirmedScrollY,
    rects:         remeasuredRects
  };
}

/**
 * Iterates all keyframes sequentially for a single tab role. Sequential execution
 * is required — each keyframe calls Page.bringToFront and scrolls the tab, which
 * are stateful operations that must not interleave with another keyframe's scroll.
 */
async function captureAllKeyframes(tabId, keyframes, selectorById, sessionId, role, actualDPR, documentHeight) {
  const total          = keyframes.length;
  const roleStart      = Date.now();
  const remeasureResults = [];
  logger.info(`VDIFF [${role}] captureAllKeyframes START`, { tabId, keyframeCount: total });

  for (let i = 0; i < total; i++) {
    const kf = keyframes[i];

    // Build the selector pairs that belong to THIS keyframe only.
    // We re-measure only the elements expected to be visible at this scroll
    // position — avoids noise from elements on other parts of the page.
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

/**
 * Restores the page to its pre-capture state: unlocks the scrollbar, shows
 * suppressed fixed elements, removes the animation freeze style, scrolls back to 0,
 * and clears the device metrics override. All steps swallow errors — restore must
 * never throw, as it is called from a finally block.
 */
async function safeRestorePage(tabId) {
  await execInPage(tabId, inPageUnlockScrollbar).catch(() => undefined);
  await execInPage(tabId, inPageRestoreFixed, [SUPPRESS_ATTR]).catch(() => undefined);
  await execInPage(tabId, inPageRestoreAnimations, [FREEZE_STYLE_ID]).catch(() => undefined);
  await execInPage(tabId, inPageScrollAndSettle, [0, SCROLL_SETTLE_TIMEOUT_MS]).catch(() => undefined);
  await sendCDP(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => undefined);
}

/**
 * Detaches the CDP debugger from a tab. Swallows errors — called unconditionally
 * in the finally block of runTabCapture regardless of how capture ended.
 */
async function safeDetach(tabId) {
  await chrome.debugger.detach({ tabId }).catch(() => undefined);
}

/**
 * Attaches the CDP debugger to a tab, first force-detaching any stale session.
 * Stale sessions arise when a previous capture was killed mid-flight before its
 * finally block ran. Without cleanup, the subsequent attach fails with "Another
 * debugger is already attached".
 */
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

  // Bring the tab to front before ANY setup steps, not just before each keyframe.
  //
  // The compare tab is in the background when executeTabCapture is called (baseline
  // just finished).  Two problems arise in background tabs:
  //   1. rAF is throttled to 1fps — inPageScrollAndSettle's stability poll resolves
  //      only via the hard setTimeout fallback, adding up to SCROLL_SETTLE_TIMEOUT_MS
  //      latency to every setup step.
  //   2. Some pages (lazy loaders, IntersectionObserver-driven sections) defer layout
  //      until the tab is visible, making getBoundingClientRect() return stale geometry.
  // Bringing the tab to front here resolves both before any measurement happens.
  //
  // The per-keyframe bringToFront inside captureKeyframe is kept for correctness
  // across multi-keyframe captures where Chrome may have shifted focus between steps.
  await sendCDP(tabId, 'Page.bringToFront');
  logger.info(`VDIFF [${role}] bringToFront (setup) DONE`, { tabId });

  const t1       = Date.now();
  const viewport = await execInPage(tabId, inPageGetViewport);
  logger.info(`VDIFF [${role}] inPageGetViewport DONE`, { elapsed: ms(t1), viewport });
  if (!viewport) { throw new Error(`Failed to read viewport from tab ${tabId}`); }

  // ── DevTools bypass ─────────────────────────────────────────────────────
  //
  //  When DevTools is docked, outerHeight - innerHeight > DEVTOOLS_HEIGHT_THRESHOLD_PX.
  //  Rather than aborting, we compute the true content-viewport height as
  //  outerHeight - BROWSER_CHROME_HEIGHT_PX and issue setDeviceMetricsOverride early
  //  with that derived height.  This creates a virtual viewport independent of DevTools
  //  state.  After the override ACKs (synchronous on the browser side), re-reading
  //  window.innerHeight returns the overridden value — no paint cycle needed.
  //
  //  confirmedHeight starts as viewport.height and is overwritten only when DevTools
  //  is detected.  ALL spatial calculations below use confirmedHeight, not viewport.height.
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
    // First override establishes the virtual height immediately so that any
    // subsequent execInPage calls (inPageGetDPR, inPageLockScrollbar) already
    // observe the correct viewport height.  scrollbarWidth is not yet known so
    // width compensation is deferred to the unconditional re-fire below.
    await sendCDP(tabId, 'Emulation.setDeviceMetricsOverride',
      buildMetricsOverride(viewport, 0, targetHeight));
    logger.info(`VDIFF [${role}] setDeviceMetricsOverride (DevTools bypass, pre-lock) DONE`);
    // setDeviceMetricsOverride is synchronous on the browser side — the next JS
    // execution sees the overridden value immediately without needing a paint cycle.
    confirmedHeight = await execInPage(tabId, () => Math.floor(window.innerHeight)) ?? targetHeight;
    logger.info(`VDIFF [${role}] confirmed virtual vpH after bypass`, { confirmedHeight, targetHeight });
  } else {
    logger.info(`VDIFF [${role}] devtools check PASSED`, { heightGap, widthGap, innerH: viewport.height, outerH: viewport.outerHeight });
  }

  // Populate devToolsWarning now that confirmedHeight is finalised.
  // This is set unconditionally after the bypass block so the message always
  // reflects the actual bypassHeight even if confirmedHeight differs from targetHeight.
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

  // Always re-fire after lockScrollbar so scrollbarWidth is included in the width
  // compensation.  In the bypass path, confirmedHeight is passed as targetHeight so
  // the virtual height is preserved; in the normal path targetHeight is undefined
  // and falls back to viewport.height.  Re-firing is idempotent for height — the
  // only new information is the now-known scrollbarWidth.
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

  // Use confirmedHeight for all spatial planning — this is the actual locked viewport
  // height after any DevTools bypass, not the raw innerHeight that may have been
  // shrunk by the docked DevTools panel.
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

/**
 * Attaches the CDP debugger, runs executeTabCapture, then always detaches and
 * restores the page in the finally block — regardless of success or failure.
 * Returns null (not throws) on a debugger conflict so captureRoleSequential can
 * degrade gracefully rather than aborting the entire comparison.
 */
async function runTabCapture(tabId, selectorPairs, sessionId, role) {
  let attached = false;
  const t0 = Date.now();
  logger.info(`VDIFF [${role}] attach START`, { tabId });

  try {
    await tryAttach(tabId);
    attached = true;
    logger.info(`VDIFF [${role}] attach DONE`, { elapsed: ms(t0), tabId });
    // executeTabCapture always returns { manifest, devToolsWarning } now.
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

/**
 * Entry point for capturing one tab role. Guards against a null tabId (same-tab
 * comparison where compare tab is absent) and normalises the null return from
 * runTabCapture on debugger conflict into an empty manifest.
 */
async function captureRoleSequential(tabId, selectorPairs, sessionId, role) {
  if (tabId === null || tabId === undefined) {
    logger.warn(`VDIFF [${role}] tabId is null, skipping`);
    return { manifest: new Map(), devToolsWarning: null };
  }
  const result = await runTabCapture(tabId, selectorPairs, sessionId, role);
  // runTabCapture can return:
  //   null                         — debugger conflict (Another debugger already attached)
  //   { manifest, devToolsWarning } — normal path (devToolsWarning may be null or populated)
  if (result === null) { return { manifest: new Map(), devToolsWarning: null }; }
  return { manifest: result.manifest ?? new Map(), devToolsWarning: result.devToolsWarning ?? null };
}

/**
 * Top-level visual diff entry point. Extracts modified elements, runs sequential
 * CDP captures on both tabs, builds the diff map, and returns a status object.
 * Never throws — all failures are caught and returned as {status:'failed'}.
 * Called by compare-workflow.js via runVisualPhase.
 *
 * @param {Object} comparisonResult - Full comparison result from compareReports.
 * @param {{baselineTabId: number, compareTabId: number}|null} tabContext
 * @returns {Promise<{status: string, reason: string|null, diffs: Map, sessionId?: string, devToolsWarnings: Array}>}
 */
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
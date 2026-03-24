# UI Comparison — Internal Engineering Reference

---

## 1. What This System Does

UI Comparison is a Manifest V3 Chrome Extension that captures a complete structural and visual snapshot of a web page's DOM — every visible element's computed CSS, bounding geometry, attributes, and positional identity — and stores it as a versioned report. A user can capture two such reports (a baseline and a compare) and run a comparison that pairs corresponding elements across both captures, diffs their CSS properties, and identifies which elements changed, how severely, and why.

The output of a comparison is a rich HTML report (plus optional Excel, CSV, and JSON exports) containing a severity-ranked diff table, visual side-by-side screenshots, matched/unmatched element summaries, and pre-flight URL compatibility warnings. The extension is built for QA engineers, design-system maintainers, and A/B test reviewers who need to answer the question "what changed between these two page states?" faster and more precisely than manual visual inspection.

The system is not a screenshot differ. It operates at the DOM level, producing per-element, per-property diffs with configurable tolerances and two comparison modes: **static** (full property set, text content, tight tolerances — for regression testing between prod and staging) and **dynamic** (curated property subset, no text content, looser tolerances — for A/B testing or live-state comparisons where text is expected to differ). Visual screenshots serve as a supplementary layer, not the primary signal.

---

## 2. System Architecture

### The Three Execution Contexts

Chrome extensions run code in three isolated JavaScript contexts that cannot share memory or call each other's functions directly.

**Service Worker (SW)** — `background.js` is the SW entry point, loaded by Chrome as a module. The SW owns all business logic, IDB access, CDP-based visual capture, comparison orchestration, and message dispatch. It is the only context with access to IndexedDB, the Chrome debugger API, and the downloads API. It has no DOM and no `window` object.

**Content Script** — `content.js` is injected into every page at `document_idle`. It owns the DOM extraction pipeline: traversal, style collection, HPID computation, and selector generation. It runs in an isolated world (its own JS scope) but has full read access to the page DOM. It communicates with the SW exclusively through `chrome.runtime.onMessage`.

**Popup** — `popup.js` runs in the popup HTML page that Chrome opens when the user clicks the extension icon. It owns all UI rendering and state management (`popup-state.js`). It communicates with the SW through `chrome.runtime.sendMessage` (for one-shot operations) and `chrome.runtime.connect` (for the streaming comparison workflow). It has no DOM access to the inspected page.

### The Four Architectural Layers

The codebase enforces a strict one-way dependency graph:

```
presentation  →  application  →  core  →  infrastructure
```

`presentation` (background.js, content.js, popup.js) imports from `application` and `infrastructure`. `application` (workflows, report-manager) imports from `core` and `infrastructure`. `core` (extractor, matcher, comparator, normalizer, exporters) imports from `infrastructure`. `infrastructure` (idb-repository, logger, chrome-messaging, chrome-tabs, error-tracker) imports only from `config`.

**What is forbidden:** `core` must never import from `application` or `presentation`. `infrastructure` must never import from anything except `config`. Circular imports between any two layers will cause silent runtime failures in webpack-bundled modules — use `npm run check:circular` to enforce this.

### The Two Communication Models

**One-shot `sendMessage`** (`chrome-messaging.js → sendToBackground`) is used for all operations that complete in a single async step: extracting elements, loading reports, deleting reports, exporting HTML, loading cached comparisons, and fetching visual blobs. The SW handler returns once, the popup receives the response via callback, and the channel closes. The 30-second default timeout in `sendToBackground` is intentionally short — callers that expect longer operations (e.g. `exportComparisonAsHTML` which may read large IDB records) must pass an explicit higher `timeoutMs`.

**Port-based streaming** (`chrome.runtime.connect` / `chrome.runtime.onConnect`) is used exclusively for `START_COMPARISON`. A comparison involves opening new browser tabs, waiting for pages to load, running multi-phase element matching across thousands of element pairs (yielding async generator frames at each chunk), capturing CDP screenshots, and writing to IDB — all of which can collectively take minutes. `sendMessage` is a single-response contract; it cannot deliver the 15–20 progress frames the popup needs to update its progress bar. The port stays open for the duration of the comparison, with the SW calling `port.postMessage` for each `COMPARISON_PROGRESS` frame and a single `COMPARISON_COMPLETE` or `COMPARISON_ERROR` frame at the end. You cannot substitute `sendMessage` here without restructuring the entire progress-reporting contract.

### The MV3 Service Worker Lifecycle Trap

A MV3 SW can be killed by Chrome at any time — after 5 minutes of inactivity, on memory pressure, or on browser close. When it wakes up again it re-runs `background.js` top-to-bottom: class fields re-initialise, the write queue resets to a resolved Promise, and the circuit breaker resets to closed. Any in-flight write that was interrupted mid-transaction leaves no trace in the JS heap, but it may leave a PENDING entry in the IndexedDB `operation_log` store.

Three defences are layered against this:

The **WAL (write-ahead log)** records a `PENDING` entry in `operation_log` before every `saveComparison` call, and marks it `COMPLETE` after the data write finishes. On the next SW wakeup, `storage.applyPendingOperations()` (called fire-and-forget at module load) scans for orphaned `PENDING` entries and reports them to `errorTracker`. Data replay is not implemented because the eviction state may have changed — a PENDING entry means "something interrupted a write; manually verify if this comparison's data is intact."

The **serial write queue** (`#enqueue` in `IDBRepository`) ensures that at most one write runs at a time. This protects against the race where two concurrent `saveComparison` calls both pass the WAL "no PENDING" check before either commits.

The **circuit breaker** opens permanently after 3 consecutive write failures, rejecting all subsequent enqueued writes immediately. This prevents a degraded IDB from accumulating progressively worse partial state across multiple failed writes. Once open, the circuit stays open for the session — the only reset is a SW restart.

---

## 3. Data Flow: End-to-End Walkthrough

This trace follows a single comparison from button click to downloaded HTML report.

**Step 1 — User clicks "Compare" in the popup.** `popup.js → handleStartComparison()` dispatches `COMPARISON_STARTED` to the state machine, opens a port via `chrome.runtime.connect({ name: 'comparison' })`, and posts `{ type: START_COMPARISON, baselineId, compareId, mode, includeScreenshots }` to the port.

**Step 2 — SW receives the port message.** `background.js` `onConnect` listener (file: `background.js`, line starting `chrome.runtime.onConnect.addListener`) picks it up, builds the `send()` helper, and calls `compareReports()` from `compare-workflow.js`.

**Step 3 — `compareReports()` loads both reports from IDB.** `getReportById()` in `report-manager.js` calls `storage.loadReports()` (full report list scan, O(n)) then `storage.loadReportElements(reportId)` for each. If either returns null, the workflow throws immediately.

**Step 4 — Schema version and URL pre-flight checks.** `assertVersionCompatibility()` throws `CompatibilityError` if either report is below schema version 3.0. `assessUrlCompatibility()` in `url-compatibility.js` strips tracking params, normalises paths, and returns `COMPATIBLE`, `CAUTION`, or `INCOMPATIBLE`. An `INCOMPATIBLE` result throws `PreFlightError` and halts the comparison. A `CAUTION` result attaches a warning to the result object but proceeds.

**Step 5 — Element matching.** `new Comparator().compare(baseline, compareReport, mode)` is an async generator. It calls `ElementMatcher.matchElements()` (file: `matcher.js`), which runs the four-phase pipeline described in Section 4 and yields progress frames at every `YIELD_CHUNK_SIZE` (64) element chunk. The SW forwards each `progress` frame to the popup via `port.postMessage`.

**Step 6 — Property diffing.** After matching completes, `Comparator` pipes the matched pairs through `StaticComparisonMode.compare()` or `DynamicComparisonMode.compare()` (file: `comparison-modes.js`). Each matched pair is passed to `BaseComparisonMode.compareMatch()`, which calls `PropertyDiffer.compareElements()` (file: `differ.js`) to normalise both elements' styles via `normalizerEngine.normalize()` and produce a `differences[]` array. `SeverityAnalyzer.analyzeDifferences()` annotates each diff with a severity level. After all pairs are processed, `#suppressInheritedCascades()` removes diffs that are pure CSS-cascade side-effects of an ancestor change.

**Step 7 — Visual capture.** `runVisualPhase()` calls `captureVisualDiffs()` in `visual-workflow.js`. For each modified element the workflow: attaches Chrome DevTools Protocol via `chrome.debugger.attach`, calls `groupIntoKeyframes()` to cluster elements into minimum scroll positions, scrolls to each keyframe via CDP `Input.dispatchMouseEvent`, freezes the page with `Emulation.setScriptExecutionDisabled`, takes a `Page.captureScreenshot`, and stores the blob in IDB via `storage.saveVisualBlob()`. Captures run sequentially baseline → compare because `Page.bringToFront` requires exclusive tab focus.

**Step 8 — Persist to IDB.** `persistComparison()` strips full element objects down to slim ID/selector records (to avoid duplicating what's already in `STORE_ELEMENTS`), converts the `visualDiffs` Map to a plain object (Maps are not IDB-serialisable), and calls `storage.saveComparison(meta, slimResults)` — which runs the full WAL protocol (PENDING → data write → COMPLETE).

**Step 9 — Notify popup.** The SW strips the non-serialisable `visualDiffs` Map from the result and sends `COMPARISON_COMPLETE` over the port. The popup's `dispatch('COMPARISON_COMPLETE', { result })` call updates the state machine and re-renders the results panel.

**Step 10 — HTML export.** User clicks "Download HTML". Popup calls `sendToBackground(EXPORT_COMPARISON_HTML, { baselineId, compareId, mode })`. The SW handler (`handleExportComparisonHTML`) calls `exportComparisonAsHTML()` in `compare-workflow.js`, which reads meta from IDB (`getCachedComparison`) and diffs from IDB (`storage.loadComparisonDiffs`), reconstructs the full result object, and passes it to `exportToHTML()` in `html-exporter.js`. `exportToHTML` returns `{ success: true }` after triggering a browser download via `chrome.downloads.download`.

---

## 4. Core Concepts

### HPID (Hierarchical Position Identifier)

An HPID is a dot-separated string of sibling ordinals tracing a path from the document root to an element: `1.3.2.1` means "first child of the second child of the third child of the first child of body." Every element receives two HPIDs at extraction time.

The **relative HPID** (`hpid`) is rooted at the display root of the current traversal — for filtered extractions this may be a specific subtree, not `document.body`. It is used by the matcher's sequence-alignment phase because it reflects local structural position.

The **absolute HPID** (`absoluteHpid`) is always rooted at `document.body` via `computeAbsoluteHpidPath()` in `dom-traversal.js`, which walks `parentElement` upward counting preceding siblings at each level. The matcher's Phase 0 (absolute HPID strategy, confidence 0.95) uses absolute HPIDs, which are stable across different filtered extraction scopes.

**Shadow DOM sentinel:** When the traversal crosses a shadow boundary (`parentNode instanceof ShadowRoot`), the sentinel value (`hpid.shadowSentinel`, default `0`) is injected into the path before resuming the host-side ordinal chain. This keeps HPIDs globally unique across host/shadow boundaries. If you change the sentinel value between captures, all shadow-hosted elements will produce HPID mismatches and fail to match.

**The positional identity blind spot:** HPIDs are purely structural. If two siblings swap positions, their HPIDs also swap — the matcher sees two elements that each "match" the other's position, which produces either two incorrect matches (if their tag names are the same) or two replacement detections (if tag names differ). This is a known limitation; test-attribute anchoring (Phase 0) is the mitigation when elements carry `data-testid` or equivalent.

### Element Matching Pipeline (Four Phases)

All four phases run in `ElementMatcher.matchElements()` (file: `matcher.js`). The order is load-bearing: each phase claims elements and removes them from the pool before the next phase runs. Running phases out of order would cause lower-confidence strategies to steal elements that a higher-confidence strategy would have claimed correctly.

**Phase 0 — Test-attribute anchoring (confidence 1.00):** Before sequence alignment, every element with a `data-testid`, `data-test`, `data-qa`, `data-cy`, `data-automation-id`, `data-key`, `data-record-id`, `data-component-id`, or `data-row-key-value` attribute is matched by that attribute's value. Key format is `attrName::value` to prevent collision between attributes. Ambiguous keys (same attribute value on multiple compare elements) are flagged rather than arbitrarily resolved.

**Phase 1 — Sequence alignment (confidence 0.99):** A linear two-pointer walk over all remaining elements. At each position, if `baseline[bi]` and `compare[ci]` share identical HPID segments and tagName (`passesIdentityTriad`), they are paired. On a mismatch, the algorithm scans ahead in a configurable `lookAheadWindow` (default 5) in both directions to re-synchronise after insertions or deletions. Elements where same-HPID but different-tagName is detected are flagged as replacements (removal + addition) rather than matches, because diffing mismatched tag types produces meaningless noise.

**Phase 2 — HPID suffix realignment (confidence 0.85):** Phase 1 orphans (elements that fell out of the sequence walk) are matched by the last `suffixDepth` (default 5) segments of their HPID combined with tagName. This recovers elements that had a wrapper ancestor inserted or removed, which shifts their absolute HPID but leaves the last N segments unchanged. Ambiguous suffix hits are left for Phase 3.

**Phase 3 — Legacy strategy pool (confidence varies):** All remaining orphans are passed through the enabled strategies in decreasing confidence order: `absolute-hpid` (0.95), `id` (0.90), `css-selector` (0.80), `xpath` (0.78), `position` (0.30). Each strategy builds a multi-map keyed by the strategy's identity signal and resolves matches. Two or more available candidates produce an `ambiguous` record rather than an arbitrary pick. The `position` strategy (confidence 0.30) uses a spatial grid (`cellSize` bucketing of bounding rect coordinates) and is the last resort.

### Comparison Modes

**Static mode** compares all tracked CSS properties (`extraction.cssProperties` — 80+ properties, including all shorthand expansions), includes text content comparison, and uses tight tolerances (color: ±5 channels, size: ±3px, opacity: ±0.01). Use this for regression testing between two versions of the same page where the content is expected to be identical.

**Dynamic mode** compares a curated 40-property subset (`comparison.modes.dynamic.compareProperties`), excludes text content comparison (`compareTextContent: false`), restricts attribute comparison to semantic attributes only (`structuralOnlyAttributes`), and uses looser tolerances (color: ±8, size: ±5, opacity: ±0.05). Use this for A/B test comparisons or live-state comparisons where text, data attributes, and minor sizing differences are expected to differ by design.

The key mechanical difference: `static.compareProperties` is `null`, which the `PropertyDiffer` interprets as "compare all properties in the element's style map." `dynamic.compareProperties` is a `Set`, and the differ iterates only over properties present in that Set.

### Inherited Cascade Suppression

After all elements are diffed, `BaseComparisonMode.#suppressInheritedCascades()` (file: `comparison-modes.js`) removes diff entries that are pure CSS inheritance side-effects. It builds a map of `hpid → differences[]` for all modified elements, then for each element checks whether any ancestor (identified by HPID prefix: element's HPID starts with `ancestorHpid + '.'`) has the same property change with identical base and compare values. If so, the child's diff is moved to `suppressedDiffs` (preserved for debugging) and removed from `differences`. The severity and counts are recomputed on the reduced diff list.

`CURRENT_COLOR_DERIVED` properties (`border-top-color`, `border-right-color`, `border-bottom-color`, `border-left-color`) get a second check: if the ancestor changed `color` and the border colour changed by the same delta, it is suppressed as a `currentColor` cascade. This prevents a single parent `color` change from inflating the critical count by N for all its bordered descendants.

Without this suppression, a single `color` change on a parent element with 50 children would produce 50 "critical" diffs (one per child) even though only one element intentionally changed.

### Severity System

`SeverityAnalyzer.analyzeDifferences()` (file: `severity-analyzer.js`) annotates every diff entry with a severity level and returns the single worst level as `overallSeverity`.

Priority order (first matching rule wins): `critical` (property in `comparison.severity.critical` config list, or `_isLayoutBreaking` — display:none appearing/disappearing, flow↔positioned switches, width/height change >50%) → `high` (property in `comparison.severity.high` list, or `_hasHighVisualImpact` — opacity delta >0.3, luminance-contrast delta >0.4, font-size change >25%) → `medium` (property in `comparison.severity.medium` list, or category === layout) → `low` (everything else).

`summary.severityCounts` in the comparison result counts **elements** by their worst severity, not property occurrences. An element with 6 critical-severity property changes counts as 1 critical element. `computeSeverityBreakdown()` (called during IDB persistence) additionally skips elements whose direct parent also has diffs, preventing double-counting in nested changed subtrees.

### Visual Capture Pipeline

`captureVisualDiffs()` in `visual-workflow.js` uses CDP (Chrome DevTools Protocol via `chrome.debugger`) rather than `chrome.tabs.captureVisibleTab` for one specific reason: only CDP exposes `Emulation.setScriptExecutionDisabled`, which freezes the page's main thread. The sequence per keyframe is: scroll to position → wait for scroll settle (up to 800ms, verified with a retry loop) → call `inPageRemeasureRects()` to recompute element positions post-scroll → **then** call `Emulation.setScriptExecutionDisabled(true)` to freeze the thread → call `Page.captureScreenshot` → unfreeze. The JS freeze window eliminates the layout-shift race between "scroll settled" and "screenshot taken."

Tab captures run sequentially (baseline first, then compare) because `Page.bringToFront` requires exclusive tab focus and the CDP session is tab-scoped. Parallel CDP capture across two tabs is not possible.

DevTools detection: if `window.outerHeight - window.innerHeight > 200px`, the workflow infers DevTools is open and adds a warning to `devToolsWarnings`. CDP geometry will be wrong when DevTools is docked because the panel steals content-viewport height — screenshots will not align correctly with element rects.

### WAL Pattern

Every `saveComparison()` call executes three IDB transactions in order:

1. Write `{ id, operation: 'SAVE_COMPARISON', status: 'PENDING', ... }` to `operation_log` in its own transaction. This transaction commits before the data write starts.
2. Write the comparison data to `comparisons`, `comparison_diffs`, and `comparison_summary` in a second transaction.
3. Update the `operation_log` entry to `status: 'COMPLETE'` in a third transaction.

If the SW is killed between steps 1 and 2, the `PENDING` entry survives on disk. On the next SW startup, `applyPendingOperations()` scans the `by_status` index for `PENDING` entries and reports them via `errorTracker`. **The system does not replay or repair the interrupted write** — a PENDING entry is a diagnostic signal, not an automatic recovery mechanism. You must manually verify whether the comparison data is intact by checking whether the `comparisons` store has a record for the relevant `comparisonId`.

---

## 5. File-by-File Reference

### Infrastructure Layer

**`src/infrastructure/idb-repository.js`** — The only module in the extension that opens IndexedDB. Owns the DB connection (`#getDB`), the serial write queue (`#enqueue`), the circuit breaker, the WAL protocol (`#writeWalEntry`, `#completeWalEntry`, `applyPendingOperations`), and all CRUD methods for the 9 object stores. External contract: all public write methods return `{ success: boolean, error?: string }` and never throw. Read methods return their payload type (array, Map, object, null) or a zero-value on error. Do not break: the `#enqueue` serial chain — any write that bypasses it silently races against WAL-guarded writes and can corrupt the comparison_diffs/summary stores.

**`src/infrastructure/chrome-messaging.js`** — Promise wrappers for `chrome.runtime.sendMessage` and `chrome.tabs.sendMessage`. Exports `MessageTypes` (the enum of all message type strings), `sendToBackground`, `sendToTab`, `onMessage`, and `broadcastToAllTabs`. External contract: `sendToBackground` rejects on timeout, `lastError`, or `{ success: false }` — callers must handle all three. `onMessage` handlers must not suppress errors they want the caller to receive. Do not break: the `return true` in the `onMessage` listener — removing it closes the async channel before `sendResponse` fires.

**`src/infrastructure/chrome-tabs.js`** — Promise wrappers for `chrome.tabs`, `chrome.scripting`, and `chrome.webNavigation` APIs. `TabAdapter.executeScript` is the only method here that rethrows on failure (a failed injection vs. an empty injection result are otherwise indistinguishable). All other methods return null/[] on error. Do not break: the synchronous try/catch in `sendMessage` — Chrome throws synchronously (not via `lastError`) when the content script is not yet injected.

**`src/infrastructure/logger.js`** — Fan-out structured logger with pluggable transports. The `ConsoleTransport` is registered by `init()` (called in background.js and content.js). The `StorageTransport` is registered separately in background.js — it buffers entries and flushes to `chrome.storage.local` in batches. The singleton export `logger` is used everywhere. Do not break: the isolation between transports — each transport is wrapped in try/catch so one failing transport never silences others.

**`src/infrastructure/error-tracker.js`** — In-memory deduplicated error registry. Deduplicates by `code:message` key; repeated occurrences increment a counter rather than creating new entries. Capped at 100 entries; oldest evicted first. Cleared on SW restart. Do not break: the `ERROR_CODES` enum — changing a code string invalidates any downstream code that pattern-matches against the old value.

**`src/infrastructure/performance-monitor.js`** — In-process operation timer. Tracks count, total, min, max, stdDev, and p50/p95/p99 over the last 100 samples per named operation. The `wrap()` method returns an async wrapper — even a synchronous throw inside `fn` becomes a rejected Promise. Do not break: always call `end()` in the catch path too — an unended `start()` handle silently leaks a sample from the operation's history.

### Config Layer

**`src/config/defaults.js`** — Single source of truth for all runtime configuration. The frozen `rawConfig` object is the master schema. `get(path, fallback)` reads by dot-separated path and throws (not returns undefined) when the path is missing and no fallback is provided. `init(overrides)` re-derives from `rawConfig` on every call — previous `init()` calls do not accumulate. Arrays are leaf values in `mergeDeep` — overriding `cssProperties` replaces the entire array. Do not break: `comparison.modes.static.compareProperties` is `null` by design (sentinel for "compare all"); changing it to an empty array would silently make static mode compare no properties.

**`src/config/validator.js`** — Runs four validation passes at SW startup: required-path existence, type expectations, numeric sanity ranges, and strategy schema validation. Called by `background.js` with `throwOnError: true` — a failed validation halts SW startup and prevents handler registration. Do not break: the `throwOnError` call in `background.js` — changing it to `false` means a misconfigured SW silently serves broken comparisons instead of failing loudly at startup.

### Application Layer

**`src/application/background.js`** — SW entry point. Owns the one-shot message dispatch table (`handlers`), the port-based comparison streaming handler, and the `fetch` event handler that serves visual blobs from IDB at `/blob/{id}` virtual paths. The SW is the only context with access to `chrome.debugger`, `chrome.downloads`, and IDB. Do not break: the `fetch` event handler — removing it breaks visual blob rendering in the HTML export (which uses `/blob/` URLs to reference stored screenshots).

**`src/application/compare-workflow.js`** — Orchestrates the full comparison: schema validation, URL pre-flight, element matching, visual capture, and IDB persistence. Exports `compareReports`, `getCachedComparison`, `exportComparisonAsHTML`, `PreFlightError`, and `CompatibilityError`. These two error classes are re-thrown unwrapped so callers can `instanceof`-check them. Do not break: the `slimResults` transformation in `persistComparison` — storing full element objects would push comparison records past IDB value size limits and duplicate all data already in `STORE_ELEMENTS`.

**`src/application/extract-workflow.js`** — Orchestrates extraction from the active tab: validates tab URL, sends `EXTRACT_ELEMENTS` to the content script, merges same-origin iframe elements, stamps the `REPORT_VERSION`, and calls `storage.saveReport`. Exports `extractFromActiveTab` and `ProtocolError`. Do not break: `assertReportVersion` after `buildReport` — a version mismatch between what the SW stamps and what the content script returned means the serialisation contract is broken; the report must not be persisted.

**`src/application/report-manager.js`** — Application-layer CRUD for reports. Adds validation (`isValidReport`, `isValidMeta`) and sanitisation on top of the raw IDB calls. `getReportById` does a linear scan of `loadReports()` — O(n) on report count; acceptable given the 50-report cap. Do not break: the `isValidReport` check in `saveReport` — bypassing it allows corrupt records into IDB that will fail to deserialise during comparison.

**`src/application/visual-workflow.js`** — CDP-based visual capture. Owns the DevTools attachment lifecycle, keyframe planning (via `groupIntoKeyframes`), scroll management, JS freeze window, screenshot capture, and blob persistence. `inPage*` functions are serialised strings injected into the page's MAIN context via `executeScript` — they cannot close over SW-scope variables. Do not break: the `Emulation.setScriptExecutionDisabled` call ordering — it must be the last step before `Page.captureScreenshot`. Freezing before scroll settlement produces screenshots of the wrong scroll position.

**`src/application/export-workflow.js`** — Routes export requests to format-specific exporters and triggers downloads. All thrown errors are caught and returned as `{ success: false }`. Do not break: the `EXPORT_FORMAT` vs `EXTRACTED_FORMAT` separation — the two use entirely different formatter chains and must not be used interchangeably.

**`src/application/import-workflow.js`** — Parses JSON, CSV, and Excel files and imports them as reports. Detects duplicate reports by URL+timestamp before writing. Do not break: the `_looksLikeElementHeader` heuristic — it locates the actual data header row in files that prepend metadata rows; removing it causes column index misalignment for all imported records.

**`src/application/url-compatibility.js`** — Classifies two URLs as COMPATIBLE, CAUTION, or INCOMPATIBLE. Strips tracking params (`utm_*`, `gclid`, `fbclid`, etc.) before comparison. CAUTION is path-equal but hash/query differ. Do not break: the `INCOMPATIBLE` → `PreFlightError` throw in `compareReports` — bypassing it allows meaningless cross-page comparisons (e.g. `/login` vs `/dashboard`) to run and produce misleading diff reports.

### Core Layer

**`src/core/comparison/matcher.js`** — The four-phase matching pipeline. 32KB, the largest logic file in the codebase. `ElementMatcher.matchElements()` is an async generator. The `LEGACY_CLASSIFIER_BUILDERS` map at the bottom of the file wires strategy IDs to their classifier factory functions. Do not break: the `usedBaseline` and `usedCompare` Set discipline — every element must be added to these sets immediately when claimed, otherwise two phases can claim the same element producing duplicate matches.

**`src/core/comparison/comparator.js`** — Thin orchestrator between `ElementMatcher` and the comparison mode. Computes match rate, builds report metadata, and assembles the final result frame. Do not break: `drainComparisonGenerator` in `compare-workflow.js` which consumes the generator — the generator must yield at least one `result` frame or `finalResult` will be null and the SW will throw.

**`src/core/comparison/comparison-modes.js`** — `StaticComparisonMode` and `DynamicComparisonMode`, both extending `BaseComparisonMode`. Owns `compareChunked` (the chunked async generator with event-loop yields), `#suppressInheritedCascades`, and `computeSeverityBreakdown`. Do not break: `generateSummary`'s severity counting logic — it counts elements by `overallSeverity`, not by summing per-property severity counts. Changing it to a property-count sum breaks the "14 Critical" semantics that the popup and all exporters display.

**`src/core/comparison/differ.js`** — `PropertyDiffer.compareElements()` normalises both elements' styles then diffs them property by property using tolerance strategies. Exports `PROPERTY_CATEGORIES` (used by `severity-analyzer.js`). Do not break: the normaliser call — comparing raw computed values produces false positives for equivalent values expressed differently (e.g. `rgb(255,0,0)` vs `red`).

**`src/core/comparison/severity-analyzer.js`** — `SeverityAnalyzer.analyzeDifferences()`. The `_isLayoutBreaking` and `_hasHighVisualImpact` heuristics produce `critical` and `high` severity for values outside the config lists. Do not break: the priority order in `_calculateSeverity` — `_isLayoutBreaking` must be checked before the `_high` list, otherwise a 60% width reduction would be classified as `high` instead of `critical`.

**`src/core/comparison/keyframe-grouper.js`** — Groups modified elements into minimum-scroll-count keyframe plans. Pass 1 clusters by HPID root segment; pass 2 converts clusters to viewport-clamped scroll positions. Do not break: the `clampScrollY` call — without it the CDP scroll command can request a scroll past the document bottom, causing the screenshot to capture an empty region.

**`src/core/extraction/extractor.js`** — Orchestrates the full extraction pipeline in the content script. `executePass1` batches all `getBoundingClientRect` and `getComputedStyle` calls in one synchronous sweep before any async work, to minimise forced reflows. DOM element references are nulled immediately after each record is built to prevent heap bloat during the async selector-generation phase. Do not break: the batch geometry read in `executePass1` — interleaving it with DOM writes (or async yields) triggers one reflow per element on complex pages.

**`src/core/extraction/dom-traversal.js`** — Walks the live DOM including shadow subtrees. Exports `traverseDocument` and `serializeHpid`. The traversal uses an explicit stack (not recursion) to handle pathological nesting depths without stack overflow. Shadow boundaries inject the sentinel before re-counting siblings. Do not break: the sentinel injection — if a shadow host has children at the same sibling ordinals as the host itself, without the sentinel they would produce identical HPID strings.

**`src/core/normalization/normalizer-engine.js`** — Routes CSS property values to `color-normalizer.js`, `unit-normalizer.js`, `font-normalizer.js`, and `shorthand-expander.js`. Caches normalised values in an LRU cache (`cache.js`). `normalize()` returns the original styles unchanged on any error. Do not break: the `expandShorthands` call before normalisation — shorthand properties (`border`, `padding`, `margin`) must be expanded before the differ runs, otherwise `border: 1px solid red` and `border-width: 1px; border-style: solid; border-color: red` will compare as different.

**`src/core/selectors/selector-engine.js`** — Orchestrates CSS and XPath selector generation with a `BoundedQueue` concurrency limiter (default 4 simultaneous generators) and per-element total timeout (default 600ms). Always resolves — failed elements receive `NULL_SELECTORS`. Do not break: the `BoundedQueue` limit — removing concurrency control on complex DOMs causes hundreds of concurrent `querySelectorAll` and `document.evaluate` calls, which block the content script's event loop for seconds.

**`src/core/export/comparison/html-exporter.js`** — The largest file (2005 lines, 131KB). Generates the self-contained HTML comparison report. Imports `report-transformer.js` for data reshaping. Do not break: the `/blob/{id}` URL format for embedded screenshots — the SW's `fetch` handler serves these paths; changing the format without updating both sides breaks all screenshot display in reports.

**`src/core/export/shared/report-transformer.js`** — Transforms raw comparison results into the display-ready shape consumed by all exporters. 34KB. Shared by HTML, CSV, Excel, and JSON exporters.

### Presentation Layer

**`src/presentation/content.js`** — Content script entry point. Registers the `EXTRACT_ELEMENTS` message handler and delegates to `handleExtraction()` → `extract()`. The `return true` at the end of the message listener is not optional. Do not break: removing `return true` closes the async channel before the extraction promise resolves, producing a silent "no response" error in the SW.

**`src/presentation/popup.js`** — 48KB. All popup UI rendering and event wiring. Reads state exclusively from `popup-state.js` and writes state exclusively via `dispatch()`. Do not break: the port lifecycle in `handleStartComparison` — if the port is garbage-collected before the comparison finishes (e.g. by storing it in a local variable that falls out of scope), `port.onDisconnect` fires and `aborted` is set to true in the SW, silently discarding all subsequent progress frames.

**`src/presentation/popup-state.js`** — Redux-style state machine. `state` is always replaced (never mutated). Every transition is a pure function. Subscribers are called synchronously after each dispatch. Do not break: the `initialState` shape — the popup's render functions access every field unconditionally; a missing field causes silent `undefined` in the UI.

---

## 6. IDB Schema Reference

Database name: `ui_comparison_db`, version: 6.

| Store | Key | Indices | Stored Data | Eviction |
|---|---|---|---|---|
| `reports` | `id` (UUID) | `by_timestamp`, `by_url`, `by_url_ts` ([url, timestamp]) | Report metadata without elements | Oldest evicted when count > `storage.maxReports` (default 50) |
| `elements` | `reportId` | — | `{ reportId, data: Element[] }` — full element array for one report | Deleted with parent report |
| `comparisons` | `id` (UUID) | `by_pair` (unique, pairKey), `by_timestamp`, `by_baseline`, `by_compare`, `by_triple` (unique, [baselineId, compareId, mode]) | Comparison metadata + matching stats | Oldest evicted when count > 20 |
| `comparison_diffs` | `comparisonId` | — | `{ comparisonId, results: SlimResult[] }` | Deleted with parent comparison |
| `comparison_summary` | `comparisonId` | `by_timestamp` | Summary row for list views | Deleted with parent comparison |
| `visual_blobs` | `key` | `by_comparisonId`, `by_timestamp` | `{ key, blob: Blob, comparisonId, timestamp }` | Manual deletion via `deleteVisualBlobsByComparisonId` |
| `visual_keyframes` | `id` | `by_session` | Keyframe plan records per capture session | Manual deletion via `deleteVisualDataBySession` |
| `visual_element_rects` | `id` | `by_session`, `by_session_element` ([sessionId, elementKey]) | Bounding rect records per element per tab role | Manual deletion via `deleteVisualDataBySession` |
| `operation_log` | `id` (UUID) | `by_status`, `by_timestamp` | WAL entries: `{ id, operation, payload, status: PENDING\|COMPLETE, timestamp }` | Never evicted — preserved for diagnostics even after `deleteAllReports` |

**Read/write asymmetry:** All write methods go through `#enqueue` to enforce serial ordering and WAL discipline. Read methods bypass the queue entirely — they open their own readonly transactions directly. This is safe because IDB readonly transactions are snapshot-isolated: they read a consistent view of the store at the moment the transaction opens, regardless of any concurrent write transaction. If reads were queued behind writes, a user loading the report list while a large comparison was being saved would wait the entire save duration before seeing any results. Do not add reads to the write queue — the only thing you would gain is artificial serialization and unpredictable UI latency.

---

## 7. Configuration Reference

All paths are read via `get('path.to.key')` from `src/config/defaults.js`. Arrays in `mergeDeep` are **leaf values** — overriding any array key replaces the entire array, not individual items.

### schema

Controls which data fields are collected per element during extraction.

| Key (under `schema.`) | Default | If Wrong |
|---|---|---|
| `includeStyles` | `true` | `false` → zero CSS properties extracted; comparator always produces zero diffs |
| `includeAttributes` | `true` | `false` → attribute diffs never fire; `attr:data-testid` Phase 0 matching silently disabled |
| `includeRect` | `true` | `false` → bounding box absent; Phase 3 position matching and visual-capture rect overlays both break |
| `record.textContent.maxLength` | `500` | Too small → text comparisons truncate mid-value producing false diffs. Too large → IDB payload bloat per element |

### extraction

Controls how the content script traverses and batches the DOM.

| Key (under `extraction.`) | Default | Valid Range | If Wrong |
|---|---|---|---|
| `batchSize` | `20` | 1–100 | Too large → content script blocks the event loop per batch. Too small → excessive yield overhead |
| `batchHardCapMs` | `30` | 10–200 | Too high → slow batches starve animation frames. Too low → excessive yielding slows extraction |
| `maxElements` | `10000` | 100–100000 | Too low → large pages silently truncated. Too high → IDB write and SW→popup IPC can hit Chrome message size limits |
| `skipInvisible` | `true` | boolean | `false` → `display:none` elements included in comparison, inflating diff counts with legitimately absent elements |
| `stabilityWindowMs` | `500` | 100–10000 | Too low → extraction starts before dynamic content settles. Too high → unnecessary delay on static pages |
| `cssProperties` | 80+ props | array | Removing a property → its diffs are never detected. Adding unknown properties → no effect but wastes normalizer cycles |

### hpid

Controls how element positional identities are computed across shadow boundaries.

| Key (under `hpid.`) | Default | If Wrong |
|---|---|---|
| `coordinateMode` | `'dual'` | Any other value → `absoluteHpid` not computed; Phase 0 absolute-HPID strategy (confidence 0.95) produces zero matches |
| `shadowSentinel` | `0` | Changing between captures → every shadow-hosted element gets a different HPID path and fails to match |

### selectors

Controls CSS and XPath selector generation concurrency and timeouts.

| Key (under `selectors.`) | Default | Valid Range | If Wrong |
|---|---|---|---|
| `concurrency` | `4` | 1–32 | Too high on complex DOMs → concurrent `querySelectorAll` calls block the content script event loop |
| `totalTimeout` | `600` | 100–10000 (ms) | Too low → selectors not generated for slow elements; Phase 3 CSS/XPath matching disabled, falling back to positional (confidence 0.30) |

### comparison — matching

Controls how baseline elements are paired with compare elements.

| Key (under `comparison.matching.`) | Default | If Wrong |
|---|---|---|
| `confidenceThreshold` | `0.5` | Too high → low-confidence matches rejected, inflating unmatched counts. Too low → spurious positional matches accepted as definitive |
| `positionTolerance` | `50` (px) | Too high → spatial-grid strategy matches wrong elements on dense pages |
| `ambiguityWindow` | `0.12` | Too small → close competitors promoted from ambiguous to definitive incorrectly. Too large → legitimate single-candidate matches flagged ambiguous |

### comparison — tolerances

Per-property type tolerances applied before a value difference is counted as a diff.

| Key (under `comparison.tolerances.`) | Default | Valid Range | If Wrong |
|---|---|---|---|
| `color` | `5` | 0–255 (per channel) | Too high → legitimate brand colour changes suppressed. Too low → sub-pixel anti-aliasing differences flagged as diffs |
| `size` | `3` | 0–100 (px) | Too high → real layout regressions missed. Too low → sub-pixel font rendering noise flagged |
| `opacity` | `0.01` | number | Too high → opacity changes from animations captured mid-transition are silently ignored |

### comparison — severity and modes

| Key (under `comparison.`) | Default | If Wrong |
|---|---|---|
| `severity.critical` | `['display','visibility','position','z-index']` | Removing a property → its diffs downgraded to `high` at best. Adding an unrelated property → false critical counts in all reports |
| `modes.static.compareProperties` | `null` | **`null` is a sentinel meaning "compare all properties."** Changing to `[]` → static mode compares zero properties; all comparisons show zero diffs |
| `modes.dynamic.compareProperties` | 40 props | Arrays are replaced wholesale — to extend the list you must copy the entire default array and append to it |

### normalization, storage, infrastructure, logging, export

| Config Path | Default | If Wrong |
|---|---|---|
| `normalization.cache.maxEntries` | `1000` | Too low → cache churn on pages with many unique property values. Too high → memory pressure in the content script |
| `storage.maxReports` | `50` | Too low → frequent silent eviction of old reports. Too high → IDB quota exhaustion on large-DOM sites |
| `infrastructure.timeout.contentScript` | `300000` (ms) | Too low → extraction times out on slow or large pages before it finishes |
| `logging.level` | `'debug'` | Setting `'error'` in production hides `info`/`warn` entries that diagnose matching quality regressions |
| `logging.slowOperationThreshold` | `500` (ms) | Too high → slow extractions not flagged. Too low → log spam on normal-speed pages |
| `export.excel.maxCellLength` | `32767` | Excel's hard per-cell limit. Reducing it silently truncates data; exceeding it makes the XLSX library produce corrupt files |

---

## 8. Error Handling Contract

### Read Methods

All `IDBRepository` read methods (`loadReports`, `loadReportElements`, `loadComparisonByPair`, `loadComparisonDiffs`, `loadVisualBlob`, `loadKeyframesBySession`, `loadElementRectsBySession`) catch all errors internally and return a zero-value: `[]` for arrays, `null` for single objects, `new Map()` for Maps. They never throw. This design means callers can always destructure or iterate the return value safely. The trade-off is that a read failure is silent to the caller — check the `errorTracker` or logs for `STORAGE_READ_FAILED` codes.

### Write Methods

All `IDBRepository` write methods return `Promise<{ success: boolean, error?: string }>`. Callers **must** check `success` before treating the write as committed. A `success: false` result means the data is not in IDB. The circuit breaker counts consecutive `success: false` returns — callers that ignore the return value and proceed will silently produce inconsistent state and trigger the circuit breaker prematurely.

### Re-thrown Error Types

`PreFlightError` and `CompatibilityError` propagate through `compareReports()` unwrapped. All other errors inside `compareReports` are caught and re-thrown as plain `Error` objects with the original message. This allows `background.js` to distinguish user-actionable failures (incompatible URLs, old report version) from infrastructure failures (IDB write error, CDP timeout) without inspecting error messages.

`PreFlightError` carries `.code` (`'INCOMPATIBLE_URLS'`) and `.compatResult` (the full `assessUrlCompatibility` output) for the popup to display a specific user-facing message. `CompatibilityError` carries `.baselineVersion` and `.compareVersion` so the popup can tell the user exactly which report needs to be recaptured.

### AbortError

`AbortError` is not thrown explicitly in this codebase — it surfaces from the Chrome APIs (e.g. `chrome.debugger.detach` racing with a tab close, or a `chrome.tabs.remove` on an already-closed tab). It typically appears in `visual-workflow.js` during CDP teardown. The popup does not need to handle it separately — it arrives as a plain error string in `COMPARISON_ERROR` messages. The visual capture result in that case is `{ status: 'skipped', reason: '...' }`.

### Circuit Breaker

The circuit breaker opens after `CIRCUIT_BREAKER_LIMIT` (3) consecutive write failures. Once open, `#enqueue` rejects immediately with a descriptive error message without executing the write function. The only reset is a SW restart. The threshold of 3 is intentionally low: 3 consecutive failures means IDB is degraded, not experiencing a transient blip. Keeping the queue running against a broken IDB would accumulate progressively worse partial state across multiple stores.

---

## 9. Extension Permissions: Why Each One Exists

### `storage`
**Unlocks:** `chrome.storage.local` and `chrome.storage.session`
**Used in:** `logger.js` (StorageTransport flushes log buffers to `storage.local`); `background.js` (writes a `pendingComparison` key to `storage.session` so the popup auto-opens after a background comparison finishes).
**Remove it and:** Log persistence fails silently. The popup no longer auto-opens after a background-triggered comparison completes.

---

### `activeTab`
**Unlocks:** Temporary host permission for the user's currently focused tab — without needing `<all_urls>` at install time.
**Used in:** `extract-workflow.js → TabAdapter.getActiveTab()` to get the tab the user is on when they click "Capture."
**Remove it and:** Extraction on the active tab fails immediately with "Missing host permission." The extension appears to do nothing on click.

---

### `tabs`
**Unlocks:** `chrome.tabs.query`, `chrome.tabs.create`, `chrome.tabs.remove`, `chrome.tabs.onUpdated`
**Used in:** `chrome-tabs.js` — every method on `TabAdapter` uses one of these APIs. The comparison workflow opens two background tabs (one for baseline, one for compare), waits for them to load, extracts from each, then closes them.
**Remove it and:** The comparison workflow cannot open or close tabs. Only single-page extraction (no comparison) would remain functional.

---

### `scripting`
**Unlocks:** `chrome.scripting.executeScript`
**Used in:** `chrome-tabs.js → TabAdapter.executeScript`. The visual capture pipeline serialises `inPage*` functions and injects them into each tab's MAIN world context — this is the only way to read `window.innerWidth`, lock the scrollbar, and remeasure element rects inside the page's own JS environment.
**Remove it and:** All `inPage*` function injection fails. The visual capture workflow cannot get viewport dimensions, scroll positions, or freeze the page before screenshots. The entire visual diff feature breaks silently.

---

### `downloads`
**Unlocks:** `chrome.downloads.download`
**Used in:** `download-trigger.js → triggerDownload()`, called by every exporter (HTML, Excel, CSV, JSON).
**Remove it and:** All export downloads fail silently. The comparison and extraction results still exist in IDB but cannot be written to disk.

---

### `notifications`
**Unlocks:** `chrome.notifications`
**Used in:** Not currently called anywhere in the codebase. Reserved for a planned "comparison complete" system notification.
**Remove it and:** No current runtime effect.

---

### `debugger`
**Unlocks:** `chrome.debugger.attach`, `chrome.debugger.detach`, `chrome.debugger.sendCommand` — the full Chrome DevTools Protocol bridge.
**Used in:** `visual-workflow.js`. CDP is required specifically for `Emulation.setScriptExecutionDisabled`, which freezes the page's JS main thread between scroll-settle and screenshot to eliminate layout-shift races. `chrome.tabs.captureVisibleTab` does not expose this capability.
**Remove it and:** The CDP attach call throws on startup of every visual capture. Comparisons complete successfully but produce zero screenshots. The HTML report renders with empty visual diff panels.

---

### `<all_urls>` (host permission)
**Unlocks:** Content script injection into any URL at `document_idle`, and `chrome.tabs.sendMessage` to tabs on any origin.
**Used in:** The `content_scripts` manifest entry (injects `content.js` into every page); `sendToTab` in `chrome-messaging.js` (sends extraction and visual-prepare messages to specific tabs during comparison).
**Remove it and:** `content.js` is only injected into tabs the user actively clicks on (covered by `activeTab`), not into the background tabs the comparison workflow creates. Comparison-workflow extraction from those tabs fails with "Could not establish connection."

---

## 10. Known Failure Modes and Limitations

**Shadow DOM matching across different compositions.** HPIDs traverse shadow boundaries using the configured sentinel. If the baseline page uses open shadow DOM and the compare page renders the same component differently (e.g. via a slot rearrangement), the HPID path diverges at the boundary and Phase 0 (absolute HPID) fails to match. Phase 3 strategies (CSS selector, XPath) also fail because shadow-hosted elements require compound selectors. Mitigation: ensure test-attribute annotations (`data-testid`) on shadow-hosted components so Phase 0 (test-attribute, confidence 1.0) claims them before Phase 0 (absolute HPID) fails.

**DevTools open during visual capture.** When Chrome DevTools is docked, it reduces `window.innerHeight`, making element rects and screenshot geometry inconsistent. The extension detects this via `outerHeight - innerHeight > 200px` and adds a warning to `devToolsWarnings`. Screenshots are still taken, but element overlay rectangles in the HTML report will not align correctly. Close DevTools before running a comparison that includes screenshots.

**Dynamic IDs in CSS selectors.** CSS selector generation skips IDs matching `dynamicIdPatterns` (UUIDs, timestamps, React/Vue/Angular auto-generated IDs). If an ID is the only stable identifier for an element, the CSS strategy in Phase 3 will generate a selector based on structural position instead, which has lower robustness. Mitigation: add `data-testid` annotations.

**Cross-origin iframes.** `discoverAndExtractFrames` in `extract-workflow.js` only extracts from same-origin iframes. Cross-origin frames are skipped silently — Chrome's message isolation prevents content script injection into them. Elements inside cross-origin iframes will not appear in the report or comparison. This is a Chrome security constraint with no extension-level workaround.

**Tab creation race on instant-loading pages.** `TabAdapter.createTab` registers its `onUpdated` listener after `chrome.tabs.create` returns. If the page reaches `status === 'complete'` before the listener is registered (e.g. `chrome://newtab`), the event is missed and the Promise hangs until the 30-second timeout. Do not use this extension for `chrome://` pages — they are blocked by the `BLOCKED_PROTOCOLS` check in `extract-workflow.js` anyway.

**WAL false positives.** A PENDING entry in the operation log does not always mean data loss. If the SW is killed between step 2 (data write committed) and step 3 (WAL marked COMPLETE), the PENDING entry survives but the data is intact. `applyPendingOperations` cannot distinguish this case from a genuine interrupted write. The only way to confirm data integrity is to check whether the `comparisons` store contains the expected record.

**`storage.maxReports` eviction is silent.** When a new report would push the count above the cap, the oldest report and all its associated comparisons are deleted atomically before the new one is written. There is no UI notification. Users who repeatedly capture without reviewing will lose old reports.

**Selector robustness threshold.** `selectors.minRobustnessScore` (default 50) filters out selectors that the generator scores as unstable. On highly dynamic pages (single-page apps with hashed class names), most CSS selectors fall below this threshold and Phase 3 CSS matching is effectively disabled, falling back to XPath and then positional matching.

---

## 11. How To: Common Development Tasks

### Add a New Comparison Mode

1. Open `src/core/comparison/comparison-modes.js`. Create a class extending `BaseComparisonMode` with an `async* compare(matches, ambiguous)` generator that calls `this.compareChunked(matches, ambiguous, filter, 'yourModeName')` where `filter` follows the shape of `STATIC_FILTER`.
2. Add the new mode's config under `comparison.modes.yourModeName` in `src/config/defaults.js` with at least `compareProperties`, `compareTextContent`, and `tolerances`.
3. Add the required paths to `REQUIRED_PATHS` in `src/config/validator.js`.
4. Register the mode in `Comparator`'s constructor in `src/core/comparison/comparator.js`: `this.#modes = { static: ..., dynamic: ..., yourModeName: new YourMode() }`.
5. Add the mode string to the popup UI in `src/presentation/popup.js` so users can select it.

### Add a New IDB Object Store

1. Increment `DB_VERSION` in `src/infrastructure/idb-repository.js` (currently 6 → 7).
2. Add a `const STORE_YOURSTORE = 'your_store'` constant.
3. Write a `buildYourStore(db)` function that calls `db.createObjectStore(...)` and adds indices.
4. Add `if (oldVersion < 7) { buildYourStore(db); }` to `runUpgrade`.
5. Add read and write methods to `IDBRepository`. All writes must go through `#enqueue`. Reads may use `#getDB()` directly.
6. Export the new methods from the singleton `storage`.
7. If the store holds data that should be cleared by "Delete All", add it to the `stores` array in `#deleteAllInner`. If it should survive a reset (like `STORE_OP_LOG`), document why it is excluded.

### Add a New Config Key

1. Add the key under the correct namespace in `rawConfig` in `src/config/defaults.js`.
2. Add the full dot path to `REQUIRED_PATHS` in `src/config/validator.js`.
3. If the value has a type constraint, add an entry to `TYPE_EXPECTATIONS`.
4. If the value is a number with valid bounds, add an entry to `SANITY_CHECKS`.
5. Call `get('your.new.path')` wherever the value is needed. Provide a fallback if the path may be absent in older configs loaded from storage.

### Add a New One-Shot Message Handler

1. Add the message type string to `MessageTypes` in `src/infrastructure/chrome-messaging.js`.
2. Write the handler function in `src/application/background.js` (or import it from a workflow module).
3. Register it in the `handlers` dispatch table in `background.js`: `[MessageTypes.YOUR_TYPE]: handleYourType`.
4. Send it from the popup via `sendToBackground(MessageTypes.YOUR_TYPE, payload)` in `src/presentation/popup.js`.
5. The handler's return value becomes `response.data` on the popup side. If the handler throws, the error arrives as `{ success: false, error: message }` — the popup must handle both paths.

### Add a New Streaming Port-Based Operation

1. Add a new port name constant. The existing port is named `'comparison'`.
2. In `background.js`, add a new `chrome.runtime.onConnect` handler: `if (port.name !== 'yourOperation') { return; }`.
3. Set up the `aborted` flag and `port.onDisconnect` listener following the exact pattern of the comparison port (guard every `port.postMessage` call behind `if (aborted)`).
4. In `popup.js`, open the port: `const port = chrome.runtime.connect({ name: 'yourOperation' })`, register `port.onMessage` for progress and result frames, and handle `port.onDisconnect` for cleanup.
5. Send the start message to the port: `port.postMessage({ type: MessageTypes.YOUR_START_MSG, ...params })`.

---

## 12. Local Setup and Build

**Prerequisites:** Node.js ≥ 18 (for native ESM support with `--experimental-vm-modules`), npm.

```bash
# Install dependencies
npm install

# Production build (output: dist/)
npm run build

# Development build with source maps
npm run build:dev

# Watch mode (rebuilds on file change)
npm run watch
```

To load the extension in Chrome: navigate to `chrome://extensions`, enable "Developer mode", click "Load unpacked", and select the `dist/` directory. You must rebuild and click "Update" (or reload the extension) after any source change — the watch mode rebuilds automatically but Chrome does not hot-reload.

```bash
# Run tests with coverage
npm test

# Run tests in watch mode
npm run test:watch

# Run only unit tests (tests/unit/ or __tests__/ with .test.js)
npm run test:unit

# Lint source files
npm run lint

# Auto-fix linting issues
npm run lint:fix

# Check for circular imports (fails loudly if any cycle is found)
npm run check:circular
```

Coverage thresholds are enforced in `package.json`: 60% lines, functions, and statements; 50% branches across all files in `src/core/` and `src/config/`. A build is not required before running tests — Jest processes source files directly via the ESM module transform.

The `libs/` directory contains `xlsx.full.min.js` (bundled separately, not through webpack). The `DOWNLOAD_XLSX_LIBRARY.txt` file in that directory contains the original download URL. This file is copied to `dist/libs/` by webpack's `CopyPlugin`. If you need to update it, replace the file and rebuild.

The webpack entry points are `src/application/background.js` → `dist/background.js`, `src/presentation/content.js` → `dist/content.js`, and `src/presentation/popup.js` → `dist/popup.js`. The popup HTML, CSS, icons, manifest, and libs are copied verbatim by `CopyPlugin`.
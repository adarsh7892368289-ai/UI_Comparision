# SYSTEM_REFERENCE.md

Technical blueprint for the Web Page Element Comparator extension.

## Architecture Overview

**5-Layer Design:**

1. **Presentation** (`popup.js`) - UI controller, orchestrates extraction/comparison, manages report storage in-memory + persistent
2. **Data Extraction** (`content.js`) - Content script injected into pages, extracts DOM elements, generates selectors (XPath, CSS)
3. **Domain Logic** (`src/domain/`) - Selector generation (22 XPath strategies, 10 CSS strategies), element matching (3 strategies), CSS normalization (4 normalizers)
4. **Infrastructure** (`src/infrastructure/`) - Config (immutable), logging, error tracking, resilience patterns (timeout, retry, circuit breaker)
5. **Shared** (`src/shared/`) - DOM utilities and stability validators used by selectors

---

## 2. Sequence of Operations (Control Flow)

### A. Element Extraction (Content Discovery)

**Triggering:** User clicks "Extract Elements" button in `popup.html`.

**Flow:**

1.  **Initiation (`popup.js`):** The `extractElements()` function disables the UI button and updates the status message.
2.  **Active Tab Query:** Retrieves the currently active browser tab using `chrome.tabs.query({ active: true, currentWindow: true })`.
3.  **Content Script Injection (`popup.js`):** Attempts to inject `content.js` into the active tab using `chrome.scripting.executeScript()`. This is necessary because the content script may not be present yet (especially on pages that were already open before the extension was installed).
4.  **Messaging (`popup.js`):** Sends a message with structure `{ action: 'extractElements' }` to the content script via `chrome.tabs.sendMessage()`.
5.  **DOM Traversal (`content.js`):**
    - The `chrome.runtime.onMessage` listener in `content.js` receives the message and triggers `extractAllElements()`.
    - **Batch Processing:** The function converts `document.querySelectorAll('*')` to an array, filters out non-relevant tags (SCRIPT, STYLE, META, LINK, NOSCRIPT, BR, HR), then processes elements in batches (default: 10 per batch).
    - **Yielding:** After each batch, `setTimeout(resolve, 0)` yields to the main thread to prevent blocking the page's rendering.
    - **Per-Element Extraction:** For each element, `extractElementData(element, index)` is called within a `safeExecute()` wrapper that enforces a per-element timeout (default: 150ms).
6.  **Selector Generation (`content.js`):**
    - For each element, the system calls both `generateBestXPath()` and `generateBestCSS()` in parallel using `Promise.all()`.
    - These return structured results containing the selector string, strategy used, and robustness score.
    - If either generator fails, fallback selectors are generated using simple methods (`getXPath`, `getCssSelector`).
7.  **Style & Attribute Extraction (`content.js`):**
    - Calls `window.getComputedStyle()` to retrieve CSS properties.
    - Extracts element attributes, dimensions, visibility information, text content, and parent/child hierarchy.
    - Builds an element data object containing all relevant properties for later comparison.
8.  **Report Compilation (`content.js`):**
    - All extracted element data is compiled into a `ReportObject` with structure:
      ```javascript
      {
        url: string,
        title: string,
        timestamp: ISO8601,
        totalElements: number,
        duration: number (ms),
        elements: Array<ElementData>
      }
      ```
9.  **Response & Storage (`popup.js`):**
    - The content script sends the report back via `sendResponse()`.
    - `popup.js` receives the response and creates a new report object with auto-generated `id` (timestamp) and `url`.
    - The report is pushed to the in-memory `reports` array.
    - `saveReports()` persists the entire array to `chrome.storage.local` under the key (default: `page_comparator_reports`).
    - The UI is updated to show the new report in the "Manage Reports" tab.

**Complexity:**

- **Time Complexity:** O(N) where N = number of DOM elements. Each element is processed once.
- **Selector Generation:** Each element undergoes 22 XPath strategies and 10 CSS strategies, but with early exit (returns first valid). Typical time: 50-200ms per element depending on page complexity.
- **Space Complexity:** O(N \* M) where M = average size of element data (selectors, styles, attributes). Reports are persisted, limited by `maxReports` config (default: 50 reports).

---

### B. Report Comparison (Diff & Analysis)

**Triggering:** User selects two reports from dropdowns and clicks "Compare Reports".

**Flow:**

1.  **User Selection (`popup.js`):** The `compareReports()` function reads the selected report IDs from two `<select>` elements and retrieves the corresponding report objects from the in-memory `reports` array.
2.  **Normalization Phase:**
    - `normalizeReport(report)` is called on both reports.
    - Creates a deep copy of each report's element array.
    - For each element, `normalizerEngine.normalize(element.styles, element)` is called.
    - **Normalization Cascade:**
      1. `ShorthandExpander.expand()` breaks down shorthand properties (margin, padding, border, font, background) into longhand equivalents.
      2. `ColorNormalizer.normalize()` converts all color formats (hex, named, rgb, hsl) to canonical `rgba(r, g, b, a)`.
      3. `UnitNormalizer.normalize()` converts all size units to absolute pixels.
      4. `FontNormalizer.normalize()` standardizes font-family strings.
    - **LRU Cache Optimization:** The `NormalizerEngine` maintains a 1000-entry LRU cache of (property, value) → normalized_value mappings. Cache is context-free (no element-dependent values).
3.  **Matching Phase:**
    - Creates `Map` structures for efficient O(1) lookup by selector:
      ```javascript
      baseMap: xpath/css → { element, index }
      compareMap: xpath/css → { element, index }
      ```
    - Uses **Static Matching Strategy** by default:
      1. Tries to match by `data-testid` (confidence: 0.98)
      2. Then by stable ID (confidence: 0.95)
      3. Then by CSS selector (confidence: 0.90)
      4. Then by XPath (confidence: 0.85)
      5. Fallback to position-based matching (confidence: 0.50-0.70) for unmatched elements
4.  **Diffing Phase:**
    - Iterates through matched pairs and calls `findElementDifferences(baseEl, compareEl)` for each.
    - Compares all enumerable properties and styles.
    - Tracks added elements (in compareMap but no baseline match) and removed elements (in baseMap but no compare match).
    - Builds categorized result object:
      ```javascript
      {
        matched: Array<{ baseline, compare, differences }>,
        added: Array<Element>,
        removed: Array<Element>,
        summary: { matchRate, modifiedCount, ... }
      }
      ```
5.  **Rendering (`popup.js`):**
    - `displayComparisonResults()` dynamically generates HTML for the comparison results.
    - Displays summary statistics (match rate, modification count).
    - Shows tabular breakdown of added, removed, and modified elements with side-by-side diffs.
    - Uses collapsible sections for large diff lists.

**Complexity:**

- **Time Complexity:** O(N + M) where N = baseline elements, M = compare elements.
  - Normalization: O(N \* K) where K = average number of CSS properties per element.
  - Matching: O(N + M) with static matcher using early exit and Map-based lookups.
  - Diffing: O(matched_count \* properties_per_element).
- **Space Complexity:** O(N + M) for storing normalized reports and Maps.
- **Potential Race Condition:** None identified. The comparison operates on immutable, snapshotted report data. Live DOM changes do not affect stored reports.

---

### `src/domain/strategies/matching/position-matcher.js`

- **Architecture Layer:** Domain Logic (Matching Strategy).

- **State Ownership:** Stateless.

- **Interface Contract:**
  - **`match(baselineElements, compareElements, options)`**:
    - **Signature:** `match(baseline: Array, compare: Array, options: Object): Object`
    - **Purpose:** Matches elements purely by spatial proximity when stable identifiers are unavailable.
    - **Algorithm:**
      1. For each baseline element, calculates its (x, y) center position using `getElementPosition()`.
      2. For each unmatched compare element, calculates the Euclidean distance between centers using `calculateDistance()`.
      3. Finds the closest compare element within the tolerance threshold (default: 50px).
      4. Records the match with confidence score degrading by distance: `confidence = 0.70 - (distance / 1000)`.
    - **Complexity:** O(N \* M) where N = baseline count, M = compare count. Used as fallback only.
    - **Input/Output:** Returns `{ matches: [], unmatched: { baseline, compare }, stats: {} }`.

- **Message Schema:** Not applicable.

- **Coupling & Dependencies:**
  - **`../../shared/dom-utils.js`**: Uses `getElementPosition()` and `calculateDistance()` for spatial calculations.
  - Used by: `MatcherEngine._matchStatic()` as fallback when static matching leaves unmatched elements.

---

### `src/domain/strategies/normalization/unit-normalizer.js`

- **Architecture Layer:** Domain Logic (Normalization Strategy).

- **State Ownership:** Stateless. However, dependent on live DOM context to resolve relative units.

- **Interface Contract:**
  - **`normalize(property, value, element)`**:
    - **Signature:** `normalize(property: string, value: string, element: Element): string`
    - **Purpose:** Converts all CSS length units to canonical `px` values.
    - **Supported Conversions:**
      - Absolute units: `px`, `pt`, `cm`, `mm`, `in`, `pc` → converted to `px`
      - Relative units: `em`, `rem` → resolved using element and root font-size
      - Viewport units: `vw`, `vh`, `vmin`, `vmax` → resolved using viewport dimensions
      - Percentage units: `%` → resolved relative to parent dimensions (for width/height/padding/margin)
    - **Algorithm:**
      1. Parses the value using regex to extract numeric and unit parts.
      2. If absolute unit, applies conversion factor to pixels.
      3. If relative unit (em, rem), retrieves font-size from element or root and multiplies.
      4. If viewport unit, queries `window.innerWidth/innerHeight`.
      5. If percentage, queries parent element dimensions.
      6. Returns normalized value as `"123.45px"` (rounded to 2 decimals).
    - **Complexity:** O(1) with occasional DOM reads for element context.
    - **Side Effects:** **Reads live DOM** for element dimensions, font-size, parent context. This is why the `NormalizerEngine` bypasses caching for element-dependent properties.

- **Message Schema:** Not applicable.

- **Coupling & Dependencies:**
  - **`../../shared/dom-utils.js`**: Uses `getElementPosition()` and `walkUpTree()` for context.
  - **DOM APIs**: `element.getBoundingClientRect()`, `window.getComputedStyle()`.

---

### `src/domain/strategies/normalization/font-normalizer.js`

- **Architecture Layer:** Domain Logic (Normalization Strategy).

- **State Ownership:** Contains a static `namedFontFamilies` map loaded on first use.

- **Interface Contract:**
  - **`normalize(value)`**:
    - **Signature:** `normalize(value: string): string`
    - **Purpose:** Standardizes font-family strings for consistent comparison.
    - **Transformations:**
      1. Removes outer quotes from generic families (sans-serif, serif, monospace, etc.).
      2. Normalizes spacing around commas.
      3. Replaces known font name aliases (e.g., 'Courier New' variant spellings).
      4. Lowercases generic family names.
      5. Sorts multiple font families to canonical order.
    - **Example:** `"'Arial', serif"` → `"arial, serif"`.
    - **Complexity:** O(F) where F = number of font families in the list.

- **Message Schema:** Not applicable.

- **Coupling & Dependencies:**
  - No external dependencies. Pure string transformation.

---

### `src/domain/strategies/normalization/named-colors.js`

- **Architecture Layer:** Domain Logic (Data Reference).

- **State Ownership:** Exports a static, immutable `NAMED_COLORS` map.

- **Interface Contract:**
  - **`export const NAMED_COLORS`**: A Map of CSS named color names to their RGB values.
    - **Example entries:** `{ 'red': { r: 255, g: 0, b: 0 }, 'blue': { r: 0, g: 0, b: 255 }, ... }`
    - Contains ~150 standard CSS color names plus extended X11 named colors.

- **Usage:** Consumed by `ColorNormalizer._namedToRgba()` to look up RGB values for named colors.

---

## 4. Complexity Analysis & Performance

### Time Complexity Summary

| Operation                                 | Complexity           | Notes                                                                                               |
| ----------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| Element Extraction (`extractAllElements`) | O(N \* S)            | N = elements, S = avg selector generation time (50-200ms per element)                               |
| Selector Generation (XPath)               | O(K \* V)            | K = strategies (22), V = validation overhead. Early exit + caching optimizations reduce actual cost |
| Selector Generation (CSS)                 | O(J \* V)            | J = strategies (10), similar early exit optimization                                                |
| Report Normalization                      | O(N \* P)            | N = elements, P = CSS properties (~30-50 per element)                                               |
| Report Comparison (Matching)              | O(N + M)             | N = baseline, M = compare. Maps provide O(1) lookups                                                |
| Diffing (per matched pair)                | O(K)                 | K = unique properties across both elements                                                          |
| Total Comparison                          | O(N _ P + M _ Q + D) | P, Q = properties per element, D = diffed pairs                                                     |

### Space Complexity Summary

| Data Structure              | Space        | Notes                                                                     |
| --------------------------- | ------------ | ------------------------------------------------------------------------- |
| In-Memory Reports Array     | O(R _ N _ P) | R = reports (max 50), N = elements per report, P = properties per element |
| Normalizer Engine LRU Cache | O(1000)      | Fixed size (configurable), not dependent on input                         |
| Extraction Batch Processing | O(B)         | B = batch size (10), minimal overhead                                     |

### Performance Critical Sections

#### 1. **Selector Generation (XPath/CSS)**

- **Bottleneck:** Each element requires 22 XPath strategies or 10 CSS strategies to be evaluated.
- **Mitigation:**
  - Early exit: Return first valid/unique selector (typically Tier 0-3, not all 22).
  - Per-strategy timeout: Abandon strategy if > 50ms.
  - Total timeout: Abandon all generation if > 500ms (XPath) or 50ms (CSS).
  - `safeExecute()` wrapper prevents timeout from crashing extraction.
- **Real-World Performance:**
  - Simple page (500 elements): ~5-10 seconds extraction time.
  - Complex page (5000 elements): ~30-50 seconds extraction time.
  - Performance limited by: DOM traversal, getComputedStyle() calls (causing reflows), selector generation attempts.

#### 2. **CSS Normalization**

- **Bottleneck:** Color conversion (hex → rgba), unit resolution (em → px), font-family normalization.
- **Optimization:**
  - LRU cache in `NormalizerEngine` stores normalized (property, value) pairs.
  - Typical hit rate: 60-80% for repeated properties (color, font-size, padding).
  - Color normalization (~50 color operations per typical report) is cache-friendly.
  - Unit normalization is NOT cached (element-dependent: em depends on element's font-size).
- **Real-World Performance:**
  - Normalizing 1000 elements: ~500-1000ms (with cache hits accelerating repeated props).
  - Without cache, would be 2-3x slower.

#### 3. **Diff Calculation**

- **Bottleneck:** Comparing every property of every matched pair.
- **Complexity:** O(D \* K) where D = matched elements, K = properties. For 1000 matched elements with ~100 properties each = 100K comparisons.
- **Optimization:** Short-circuit on first mismatch (not implemented, but could be). Property order doesn't matter (both are objects).
- **Real-World Performance:** ~100-200ms for typical reports.

### Potential Race Conditions

#### Scenario 1: Concurrent Extractions

- **Issue:** User clicks "Extract Elements" twice rapidly.
- **Current Behavior:** Second message will overwrite first because both reference same `reports` array.
- **Mitigation:** UI disables button during extraction (`extractBtn.disabled = true`).
- **Risk Level:** Low (UI prevents user action, but programmatic API could still cause race).

#### Scenario 2: Storage Write During Read

- **Issue:** `loadReports()` reads from storage while `saveReports()` writes.
- **Current Behavior:** chrome.storage.local is atomic for single `get` or `set`, so no corruption. Worst case: one operation is stale.
- **Risk Level:** Very Low. chrome.storage.local API is thread-safe.

#### Scenario 3: Live DOM Changes During Extraction

- **Issue:** If page modifies DOM during extraction (e.g., lazy-loading, animations), extracted selectors may become invalid.
- **Current Behavior:** Selectors are validated against the DOM at extraction time. If page changes after extraction, selectors may fail on subsequent comparison.
- **Mitigation:** Extractions are fast enough (~5-50 seconds) that major changes are unlikely. Users can re-extract if page is still loading.
- **Risk Level:** Low. Affects accuracy, not correctness.

#### Scenario 4: Normalizer Engine Cache Pollution

- **Issue:** If element-dependent properties are cached (should not happen), normalization could return wrong values.
- **Current Behavior:** `NormalizerEngine._isContextDependentProperty()` explicitly excludes properties with relative/viewport units from caching. Only absolute values are cached.
- **Risk Level:** Very Low. Cache guard is correct.

---

## 5. Message Schemas & Inter-Process Communication

### Popup ↔ Content Script Messaging

#### Message: `extractElements` (Popup → Content)

```javascript
{
  action: 'extractElements';
}
```

- **Direction:** popup.js → content.js
- **Trigger:** User clicks "Extract Elements" button.
- **Handler:** `chrome.runtime.onMessage` listener in content.js.
- **Response (Success):**

  ```javascript
  {
    success: true,
    data: {
      url: "https://example.com/page",
      title: "Example Page",
      timestamp: "2024-02-11T12:34:56.789Z",
      totalElements: 1234,
      duration: 12500,
      elements: [
        {
          id: "el-1",
          index: 0,
          tagName: "DIV",
          className: "container",
          textContent: "Hello World",
          xpath: "//div[@class='container']",
          cssSelector: "div.container",
          styles: {
            "background-color": "rgba(255, 255, 255, 1)",
            "font-size": "16px",
            "padding-top": "10px"
          },
          attributes: {
            "id": "header",
            "data-testid": "main-header",
            "role": "banner"
          },
          visibility: {
            isVisible: true,
            opacity: 1,
            display: "block"
          },
          position: {
            x: 10,
            y: 20,
            width: 500,
            height: 100
          }
        },
        // ... more elements
      ]
    }
  }
  ```

  - **Schema Notes:**
    - `elements` array contains one object per extracted element.
    - `xpath` and `cssSelector` are generated by the specialized generators with fallback to simple selectors.
    - `styles` object contains only selected CSS properties (not all ~500+), normalized to canonical formats.
    - `attributes` is filtered to include only meaningful attributes (id, class, role, data-testid, etc.).
    - `totalElements` = count of successfully extracted elements (some may be skipped if invisible or lack selectors).
    - `duration` = wall-clock time in milliseconds.

- **Response (Error):**
  ```javascript
  {
    success: false,
    error: "Cannot extract elements from browser internal pages"
  }
  ```

  - **Error Codes:** Typical errors:
    - `"Cannot extract elements from browser internal pages"` (chrome://, edge://, etc.)
    - `"No active tab found"`
    - Timeout or network error from Chrome APIs.
    - Selector generation failures (seldom, fallback selectors are usually available).

### Popup ↔ Chrome Storage

#### Key: `page_comparator_reports` (from config, customizable)

```javascript
// Value: Array of Report objects
[
  {
    id: '1707641696123',
    url: 'https://example.com/page1',
    timestamp: '2024-02-11T12:34:56.789Z',
    data: {
      /* ReportObject as above */
    },
  },
  {
    id: '1707641712456',
    url: 'https://example.com/page2',
    timestamp: '2024-02-11T12:35:12.456Z',
    data: {
      /* ReportObject */
    },
  },
  // ... up to maxReports (default: 50)
];
```

- **Direction:** popup.js ← → chrome.storage.local.
- **Operations:**
  - `loadReports()`: Reads entire array on startup.
  - `saveReports()`: Writes entire array after modifications (add, delete).
  - No incremental updates; entire array is persisted.
- **Size Limits:**
  - chrome.storage.local quota: ~10MB per extension.
  - With 50 reports × 5000 elements each × ~500 bytes per element ≈ 125MB. **Exceeds quota.**
  - Practical limit: ~100-500 elements per report for 50 reports to stay within 10MB.
  - With current element size (~500B), realistic max = 500 elements per report for 50 reports = 12.5MB.

#### Key: `page_comparator_logs` (from config, optional)

```javascript
// Value: Array of LogEntry objects
[
  {
    level: 'info',
    message: 'Extraction successful',
    timestamp: '2024-02-11T12:34:56.789',
    context: { script: 'popup', reportId: '...' },
    duration: 12500,
  },
  // ... up to 1000 entries
];
```

- **Direction:** Logger → chrome.storage.local.
- **Purpose:** Persistent log storage for diagnostics.
- **Flushed:** Every 10 log entries, or manually via `storageTransport.forceFlush()`.

---

## 6. Resilience Patterns & Error Handling

### Pattern 1: Safe Execute (Timeout)

**Location:** `src/infrastructure/safe-execute.js`

**Function:** `safeExecute(fn, options)`

**Purpose:** Prevents a single slow operation from blocking the entire process.

```javascript
// Example usage:
const result = await safeExecute(() => extractElementData(element, index), {
  timeout: 150, // ms
  fallback: null, // return value on timeout
  operation: 'extractElement',
});
```

**How it works:**

1. **Timeout Race:** Wraps function in a race against `setTimeout(reject, timeout)`.
2. **Error Classification:** On failure, classifies error as "transient" (retryable) or "permanent" (fail-fast).
3. **Logging:** Files error to error-tracker if permanent.
4. **Fallback:** Returns configured fallback value on timeout.

**Used By:**

- `extractElementData()`: 150ms timeout per element.
- `generateBestXPath()`: 500ms total timeout.
- `generateBestCSS()`: 50ms total timeout.
- `safe-execute.js` itself: Manages circuit breakers for broader patterns.

**Effectiveness:** Prevents single slow elements (e.g., with massive DOM subtree) from blocking batch processing. Typical impact: <5% of elements timeout, but batch continues successfully.

---

### Pattern 2: Retry with Exponential Backoff

**Location:** `src/infrastructure/safe-execute.js`

**Function:** `safeExecuteWithRetry(fn, options)`

**Purpose:** Recovers from transient failures automatically.

```javascript
// Example (not currently used in popup.js, but available):
const result = await safeExecuteWithRetry(
  () => chrome.storage.local.set(...),
  {
    timeout: 5000,
    maxRetries: 3,
    backoffMultiplier: 2,    // 0ms, 100ms, 200ms, 400ms
    fallback: null
  }
);
```

**How it works:**

1. **Transient Error Detection:** Checks error message for patterns like "timeout", "network", "quota exceeded", etc.
2. **Retry Loop:** If transient, waits `backoff = min(100ms * 2^attempt, maxBackoff)`, then retries.
3. **Circuit Breaker Integration:** Checks global circuit breaker state before attempt. If breaker is OPEN, fails immediately.
4. **Logging:** Logs each retry attempt.

**Used By:** Not currently used in popup.js (all storage operations are simple, not expected to fail transdiently). Available for future use.

---

### Pattern 3: Circuit Breaker

**Location:** `src/infrastructure/safe-execute.js`

**Class:** `CircuitBreaker`

**Purpose:** Prevents cascading failures by stopping further attempts against a service/function that is known to be unhealthy.

```javascript
// Internal state machine:
// CLOSED (normal) → OPEN (too many failures) → HALF_OPEN (testing recovery) → CLOSED (recovered)
```

**States:**

- **CLOSED:** Normal operation. All requests proceed.
- **OPEN:** Too many recent failures (threshold: 5 failures in 30 seconds). All requests fail immediately.
- **HALF_OPEN:** After cooldown period (5 seconds), allow one test request. If succeeds, transition to CLOSED. If fails, go back to OPEN.

**Used By:** Currently tracked but not actively leveraged. Could be useful for storage operations or network calls in future versions.

**Global Circuit Breakers Managed:**

- One per unique operation name (e.g., 'xpath-generation', 'xml-extraction', 'storage-write').

---

### Pattern 4: LRU Cache with Eviction

**Location:** `src/domain/engines/normalizer-engine.js`

**Purpose:** Reduce redundant normalization computations by caching results.

```javascript
// LRU Cache Implementation:
_cache = new Map();  // Insertion order preserved (ES6 Map guarantees)
_cacheMaxSize = 1000;

_updateCache(key, value) {
  if (this._cache.size >= this._cacheMaxSize) {
    const lruKey = this._cache.keys().next().value;  // First key (oldest)
    this._cache.delete(lruKey);                       // Evict
  }
  this._cache.delete(key);  // If exists, delete to re-insert at end
  this._cache.set(key, value);  // Insert at end (most recently used)
}
```

**Behavior:**

- **Cache Key:** `"${property}:${value}"` (e.g., `"color:red"`).
- **Cache Value:** Normalized result (e.g., `"rgba(255, 0, 0, 1)"`).
- **Hit Rate:** 60-80% typical (repeated properties across elements).
- **Size:** 1000 entries × ~50 bytes (key + value strings) ≈ 50KB memory.

**Context Dependency Guard:**

```javascript
_isContextDependentProperty(property, value) {
  // Don't cache if value contains relative/viewport units
  return /\d+(em|rem|%|vw|vh|vmin|vmax)/.test(value);
}
```

This ensures properties like `padding: 2em` are NOT cached (since `em` depends on element's font-size).

---

### Error Tracking & Deduplication

**Location:** `src/infrastructure/error-tracker.js`

**Purpose:** Aggregate errors to prevent log spam and provide diagnostics.

```javascript
// Example: Two identical errors in sequence
errorTracker.logError(
  ErrorCodes.XPATH_GENERATION_FAILED,
  'No valid XPath found',
  { element: 'DIV', id: 'header' }
);

errorTracker.logError(
  ErrorCodes.XPATH_GENERATION_FAILED,
  'No valid XPath found',
  { element: 'DIV', id: 'sidebar' }
);

// Result: Single entry in error map with count=2, lastSeen updated.
```

**Deduplication Key:** `${code}:${message}` (context ignored for deduplication).

**LRU Eviction:** When max unique errors (100) reached, oldest error is removed.

**Exported Error Codes:**

```javascript
(EXTRACTION_TIMEOUT,
  EXTRACTION_ELEMENT_DETACHED,
  EXTRACTION_INVALID_ELEMENT,
  XPATH_GENERATION_FAILED,
  XPATH_VALIDATION_FAILED,
  XPATH_TIMEOUT,
  CSS_GENERATION_FAILED,
  CSS_VALIDATION_FAILED,
  COMPARISON_NO_XPATH,
  COMPARISON_INVALID_REPORT,
  STORAGE_QUOTA_EXCEEDED,
  STORAGE_WRITE_FAILED,
  STORAGE_READ_FAILED,
  STORAGE_VERSION_CONFLICT,
  UNKNOWN_ERROR);
```

---

## 7. XPath Generator: 22-Strategy Tournament

### Strategy Tiers (Priority Order)

| Tier | Strategy                   | Confidence | Notes                                                          |
| ---- | -------------------------- | ---------- | -------------------------------------------------------------- |
| 0    | Exact Text                 | 99%        | Full element text must be static and unique                    |
| 1    | Test Attributes            | 98%        | data-testid, data-qa, etc.                                     |
| 2    | Stable ID                  | 95%        | Non-dynamic ID attribute                                       |
| 3    | Normalized Text            | 94%        | Whitespace-normalized text                                     |
| 4    | Preceding Sibling          | 88%        | Position relative to previous element                          |
| 5    | Parent-Descendant          | 85%        | Contextual selector with ancestor                              |
| 6    | Attribute-Text Combo       | 93%        | Combines @attr AND text() in single predicate                  |
| 7    | Following Anchor           | 80%        | Position relative to next element                              |
| 8    | Framework Attributes       | 82%        | Detects framework-specific attrs                               |
| 9    | Multi-Attribute            | 75%        | Combines 2+ attributes with AND                                |
| 10   | Role & ARIA Label          | 76%        | Uses accessibility attributes                                  |
| 11   | Label Element              | 80%        | For form inputs, links to associated <label>                   |
| 12   | Partial Text               | 72%        | Substring match (less robust than exact)                       |
| 13   | HRef Attribute             | 74%        | For links, uses href value                                     |
| 14   | Parent-Child               | 68%        | Single-level parent context                                    |
| 15   | Sibling Combinator         | 64%        | Siblings at same level                                         |
| 16   | Semantic Ancestor          | 64%        | Uses semantic HTML ancestors (nav, main, form)                 |
| 17   | Class-Attribute Combo      | 60%        | Combines class with other attributes                           |
| 18   | Ancestor Chain             | 58%        | Multiple ancestor levels combined                              |
| 19   | Table Row Attribute        | 90%        | Special handling for @data-row-key or similar                  |
| 20   | SVG Specific               | 80%        | Uses SVG/namespaced element detection                          |
| 21   | Spatial-Text Hybrid        | 65%        | Combines position and text content                             |
| 22   | Guaranteed Path (Fallback) | 30%        | Full index-based path from root; always works but very brittle |

### Early Exit Optimization

The generator doesn't evaluate all 22 strategies. It **stops after the first valid, unique XPath** is found. Typical execution:

- **Fast Page (simple structure):** Returns at Tier 0-3 (~50ms for page with 500 simple elements).
- **Complex Page (framework, generated IDs):** May reach Tier 10-15 before success (~200ms per element).
- **Worst Case (falls back to Tier 22):** Index-based path, ~20-30ms per element.

### Uniqueness Validation

For each candidate XPath, the generator calls:

```javascript
const matchCount = countXPathMatches(candidate.xpath, context);
```

This uses `document.evaluate()` to count how many elements match. Only XPath matching exactly 1 element is accepted (ensures uniqueness).

---

## 8. CSS Generator: 10-Strategy Cascade

### Strategy Cascade (Priority Order)

| Tier | Strategy                 | Robustness | Notes                                                          |
| ---- | ------------------------ | ---------- | -------------------------------------------------------------- |
| 1    | ID Selector              | 100        | `#my-id` or `tag#my-id`. Uses `isStableId()` to validate.      |
| 2    | Test Attributes          | 91         | `[data-testid="value"]`. Stops at first test attribute found.  |
| 3    | Combined Data Attributes | 82         | `tag[data-a="v1"][data-b="v2"]`. Combines 2+ data attributes.  |
| 4    | Type & Name              | 81         | `input[type="text"][name="email"]`. Form-specific.             |
| 5    | Class & Attribute        | 82         | `tag.class[attr="val"]`. Combines class with stable attribute. |
| 6    | Parent > Child           | 73         | `.parent > tag`. Single-level parent context.                  |
| 7    | Ancestor Descendant      | 64         | `div.container tag`. Descendant from ancestor.                 |
| 8    | Pseudo-Classes           | 64         | `button:disabled`, `input:checked`. Matches state.             |
| 9    | :nth-child(n)            | 54         | `div:nth-child(3)`. Fragile; position-dependent.               |
| 10   | :nth-of-type(n)          | 44         | `p:nth-of-type(2)`. Least robust; pure positional.             |

### Uniqueness Validation

For each candidate CSS selector, the generator calls:

```javascript
const elements = document.querySelectorAll(selector);
if (elements.length === 1 && elements[0] === targetElement) {
  // Valid and unique
}
```

### Performance Optimizations

1. **Early Exit:** Returns first valid selector (usually Tier 1-3).
2. **Per-Strategy Timeout:** Each strategy limited to ~200ms.
3. **Total Timeout:** Overall CSS generation limited to 50ms per element.
4. **Fallback:** If CSS generation fails or times out, a simple `tag.class#id` fallback is generated.

---

## 7. Project Structure & File Organization

---

### `manifest.json`

- **Architecture Layer:** Configuration / Extension Entry Point Definition

- **State Ownership:** None. This is a declarative configuration file.

- **Interface Contract:** This file declares the extension's primary interfaces and capabilities to the browser.
  - **`action`:** Defines the main user interaction point. Clicking the extension icon loads `popup.html`.
  - **`content_scripts`:** Configures the automatic injection of `content.js` into all web pages visited by the user (`<all_urls>`). The script is injected at `document_idle` to minimize impact on page load times.
  - **`permissions`:** Declares the necessary browser APIs:
    - `activeTab`: Grants temporary access to the active tab when the user invokes the extension.
    - `storage`: Allows the extension to use the `chrome.storage.local` API for data persistence.
    - `scripting`: Provides the ability to execute scripts within tabs, a core requirement for programmatic interaction.
  - **`host_permissions`:** Grants blanket permission (`<all_urls>`) for the content script to be injected into any website.

- **Message Schema:** Not applicable. This file enables messaging between components but does not define message structures itself.

- **Coupling & Dependencies:**
  - **`popup.html`**: Declared as the main action popup. The build process must ensure this file, along with its dependencies (`popup.js`, `popup.css`), is correctly located.
  - **`content.js`**: Declared as the primary content script. This implies a build process is configured to place the bundled output at the root of the extension package.
  - **`Images/*.png`**: Declares dependencies on icon files for the browser UI.

---

### `package.json`

- **Architecture Layer:** Build & Dependency Management

- **State Ownership:** None. This file is for project metadata and build configuration.

- **Interface Contract (Scripts):** Defines the command-line interface for managing the project.
  - `npm run build`: The primary build command. It invokes Webpack to bundle all source files from `src/` into a distributable format in the `dist/` directory.
  - `npm run setup`: A utility for first-time setup, which installs npm packages and then runs `copy-xlsx`.
  - `npm run copy-xlsx`: Manually copies the `xlsx` library into the `libs/` directory. This suggests the library might be used in a context where ES6 imports are not available, requiring it to be a standalone file.
  - `npm run clean`: A housekeeping script to remove `node_modules` and `package-lock.json` for a clean reinstall.

- **Message Schema:** Not applicable.

- **Coupling & Dependencies:**
  - **Runtime Dependencies:**
    - `xlsx`: A library for creating and parsing spreadsheet files, used for the "Export to Excel" feature.
  - **Development Dependencies:**
    - `webpack` / `webpack-cli`: The core of the build system.
    - `copy-webpack-plugin`: A Webpack plugin used to copy static files (like `.html`, `.css`, and images) from the source directories to the final `dist/` build output.
  - **Implicit Dependencies:**
    - `webpack.config.js`: The build process is entirely configured by this file, creating a tight coupling.
    - `libs/xlsx.full.min.js`: The `copy-xlsx` script's output target, indicating a direct file-path dependency elsewhere in the project.

---

### `webpack.config.js`

- **Architecture Layer:** Build Tooling.
- **Purpose:** Configures the Webpack bundler, which transforms the `src/` source code into the final `dist/` directory that is packaged into the browser extension.
- **Core Configuration:**
  - **`entry`**: Defines the two JavaScript entry points: `popup.js` and `content.js`. Webpack creates dependency graphs starting from these two files.
  - **`output`**: Bundles the output into `popup.js` and `content.js` inside the `dist/` folder.
  - **`plugins` (`CopyPlugin`)**: Copies non-JavaScript assets directly to the `dist/` folder, including `manifest.json`, `.html`, `.css`, images, and the `libs/` directory.
- **Coupling:** Tightly coupled to the project's file structure and the `package.json` scripts that invoke it.

---

### `src/presentation/popup.js`

- **Architecture Layer:** Presentation Layer (UI Controller) & Application Logic. It handles all user-facing interactions and orchestrates the core features of the extension.

- **State Ownership:**
  - **In-Memory State:**
    - `reports` (Array): A global array holding the full data for all extracted reports. This serves as the primary in-memory database for the application's lifecycle.
    - `normalizerEngine` (Object): An instance of `NormalizerEngine`, which contains its own stateful LRU cache for performance.
  - **Persistent State (`chrome.storage.local`):**
    - The `reports` array is persisted to `chrome.storage.local` under a key defined in the application config (default: `page_comparator_reports`), ensuring data durability between sessions.

- **Message Schema:**
  - **Outgoing (to `content.js`):**
    - **Action:** `extractElements`
    - **Payload:** `{ action: 'extractElements' }`
    - **Purpose:** To command the content script to begin scanning the DOM.
  - **Incoming (from `content.js`):**
    - **On Success:** `{ success: true, data: { totalElements: Number, elements: Array<Object> } }`
    - **On Error:** `{ success: false, error: String }`
    - **Purpose:** To receive the structured report data or an error message from the content script.

- **Coupling & Dependencies:**
  - **`../infrastructure/config.js`**: Strong coupling. Used to retrieve configuration values like storage keys.
  - **`../infrastructure/logger.js`**: Strong coupling. Used for all event and error logging.
  - **`../infrastructure/error-tracker.js`**: Strong coupling. Used for logging aggregated errors.
  - **`../domain/engines/normalizer-engine.js`**: Strong coupling. A key dependency for the comparison logic.
  - **`content.js`**: Loose coupling via `chrome.tabs.sendMessage`. Expects `content.js` to respond to the defined message schema.
  - **`popup.html`**: Very tight coupling. The script is directly tied to the HTML structure, referencing many element IDs.
  - **`libs/xlsx.full.min.js`**: Loose coupling. The `XLSX` global is expected to be available for the `downloadReport` function.
  - **Chrome APIs**: `chrome.tabs`, `chrome.storage`, `chrome.scripting`.

- **Interface Contract (Functions):**
  - **`DOMContentLoaded` Listener**: The script's main entry point.
    - **Signature:** DOM event listener, no parameters.
    - **Orchestration:** Calls `loadReports()`, `loadCurrentPageUrl()`, `setupTabs()`, and attaches event listeners to UI buttons.
    - **Side Effects:** Reads from chrome.storage.local, mutates DOM, sets up event listeners.
    - **Complexity:** O(R) where R = number of stored reports.

  - **`extractElements()`**:
    - **Signature:** `async extractElements(): Promise<void>`
    - **Purpose:** Orchestrates the element extraction workflow.
    - **Algorithm:**
      1. Queries active tab via `chrome.tabs.query()`.
      2. Validates the URL (rejects `chrome://`, `chrome-extension://`, `edge://`).
      3. Injects content.js via `chrome.scripting.executeScript()` (with error handling for already-injected scripts).
      4. Waits 100ms for script initialization.
      5. Sends `{ action: 'extractElements' }` message via `chrome.tabs.sendMessage()`.
      6. On success: creates report object with `id`, `url`, `timestamp`, and response `data`.
      7. Pushes to `reports` array, calls `saveReports()`, updates UI via `displayReports()`.
      8. Logs metrics: reportId, elementCount, duration.
    - **Side Effects:** Injects scripts, writes to storage, mutates DOM.
    - **Complexity:** O(1) for UI operations + O(N) for content.js extraction (deferred).
    - **Error Handling:** Tries-catches script injection failures (expected on already-injected pages). Logs and displays user-friendly error messages.

  - **`loadReports()`**:
    - **Signature:** `async loadReports(): Promise<void>`
    - **Purpose:** Initializes the in-memory `reports` array from persistent storage.
    - **Algorithm:** Queries `chrome.storage.local` with configured storage key, retrieves array, updates `reports` variable, calls `displayReports()`.
    - **Side Effects:** Reads from chrome.storage.local, mutates `reports` global variable.
    - **Complexity:** O(R) where R = number of stored reports (linear UI render).

  - **`saveReports()`**:
    - **Signature:** `async saveReports(): Promise<void>`
    - **Purpose:** Persists the in-memory `reports` array to chrome.storage.local.
    - **Algorithm:**
      1. Enforces `maxReports` limit from config (default: 50).
      2. If limit exceeded, truncates oldest reports using `reports.slice(-maxReports)`.
      3. Sets to storage under configured key.
      4. Logs count and any truncation.
    - **Side Effects:** Writes to chrome.storage.local.
    - **Complexity:** O(R) where R = number of reports.
    - **Note:** Storage quota is limited (~10MB per extension). Should monitor usage.

  - **`compareReports()`**:
    - **Signature:** `async compareReports(): Promise<void>`
    - **Purpose:** Orchestrates the comparison of two selected reports.
    - **Algorithm:**
      1. Reads selected report IDs from two `<select>` elements.
      2. Retrieves report objects from `reports` array (array access: O(R) linear search).
      3. Calls `performComparison(report1, report2)`.
      4. Calls `displayComparisonResults()` to render results.
    - **Complexity:** O(R + N + M) where R = number of reports, N and M = element counts.
    - **Potential Inefficiency:** Linear search through `reports` array. Could be optimized with a Map if needed.

  - **`performComparison(report1, report2)`**:
    - **Signature:** `performComparison(report1: Report, report2: Report): ComparisonResult`
    - **Purpose:** Core comparison algorithm. Normalizes both reports, matches elements, identifies differences.
    - **Algorithm:**
      1. Calls `normalizeReport(report1)` and `normalizeReport(report2)` to create canonical CSS representations.
      2. Creates two Maps for fast lookups: `baseMap = Map<xpath|css, element>` and `compareMap = Map<xpath|css, element>`.
      3. Iterates through `baseMap`, finding matches in `compareMap` (O(N) with O(1) lookups).
      4. For each matched pair, calls `findElementDifferences()` to compute detailed diffs.
      5. Identifies added elements (in compareMap, not in baseMap) and removed (vice versa).
      6. Aggregates results: matched (with diffs), added, removed.
    - **Complexity:** O(N + M + K) where N = baseline elements, M = compare elements, K = average properties per element.
    - **Time Optimization:** Normalization already happened; comparison uses pre-normalized data (cached via LRU).
    - **Space Complexity:** O(N + M) for Maps and results arrays.

  - **`normalizeReport(report)`**:
    - **Signature:** `normalizeReport(report: Report): Report`
    - **Purpose:** Creates a deep copy of report with all element CSS normalized.
    - **Algorithm:**
      1. Deep-copies the report object structure.
      2. For each element in the elements array, calls `normalizerEngine.normalize(element.styles, element)`.
      3. Returns the modified copy (original unchanged).
    - **Complexity:** O(N \* P) where N = elements, P = average CSS properties.
    - **Caching:** `NormalizerEngine` uses LRU cache to avoid re-normalizing the same (property, value) pairs.

  - **`findElementDifferences(el1, el2)`**:
    - **Signature:** `findElementDifferences(el1: ElementData, el2: ElementData): Array<Difference>`
    - **Purpose:** Pure function that compares two element data objects.
    - **Algorithm:**
      1. Collects all keys from both elements (attributes + CSS properties).
      2. For each key, compares values (using `===`) and records mismatches.
      3. Returns array of `{ property, baseline, compare }` for each mismatch.
    - **Complexity:** O(K) where K = unique keys across both elements.

  - **`displayReports()`**:
    - **Signature:** `displayReports(): void`
    - **Purpose:** Renders the list of stored reports into the "Manage Reports" UI.
    - **Algorithm:**
      1. Clears the existing report list (DOM).
      2. Iterates through `reports` array.
      3. For each report, creates a `<div>` with report metadata (URL, timestamp, element count).
      4. Attaches event listeners to "Download" and "Delete" buttons.
      5. Inserts into DOM.
    - **Side Effects:** Mutates DOM significantly.
    - **Complexity:** O(R \* DOM_operations) where R = number of reports. Can be optimized with template libraries for large lists.

  - **`displayComparisonResults(comparison, report1, report2)`**:
    - **Signature:** `displayComparisonResults(comparison: Object, report1: Report, report2: Report): void`
    - **Purpose:** Renders the complete diff result into the UI.
    - **Algorithm:**
      1. Displays summary: match rate `(matched / total * 100)`, modification count, added count, removed count.
      2. Creates collapsible sections for added, removed, and modified elements.
      3. For modified elements, shows side-by-side diffs of properties.
      4. Uses HTML table or list structure for legibility.
    - **Side Effects:** Heavy DOM mutation.
    - **Complexity:** O(D + A + R) where D = diffed elements, A = added, R = removed. Large diffs can cause UI jank.
    - **Potential Optimization:** Virtualize the list (only render visible elements) for very large diffs.

  - **`downloadReport(reportId)`**:
    - **Signature:** `downloadReport(reportId: string): void`
    - **Purpose:** Exports a report to Excel format.
    - **Algorithm:**
      1. Finds report by ID from `reports` array.
      2. Transforms element data into a tabular format (one row per element).
      3. Uses the XLSX library (`window.XLSX`) to create a workbook with multiple sheets (summary, details).
      4. Uses `XLSX.write()` to generate a .xlsx file.
      5. Triggers browser download via `<a href="..." download>` trick.
    - **Side Effects:** File download.
    - **Complexity:** O(N) where N = elements in report. Excel generation is synchronous but fast.
    - **Dependencies:** `libs/xlsx.full.min.js` must be globally available.

  - **`deleteReport(reportId)`**:
    - **Signature:** `deleteReport(reportId: string): void`
    - **Purpose:** Removes a report from storage.
    - **Algorithm:**
      1. Shows `confirm()` dialog.
      2. Filters `reports` array to remove matching ID.
      3. Calls `saveReports()` to persist change.
      4. Calls `displayReports()` and `populateReportSelectors()` to refresh UI.
    - **Side Effects:** Mutates `reports`, writes to storage, updates UI.
    - **Complexity:** O(R) where R = number of reports (linear filter).

  - **`populateReportSelectors()`**:
    - **Signature:** `populateReportSelectors(): void`
    - **Purpose:** Updates the two `<select>` dropdowns with the current list of reports.
    - **Algorithm:**
      1. Clears both select elements.
      2. Iterates through `reports` array.
      3. For each report, creates an `<option>` with value=ID and text=URL+timestamp.
      4. Appends to selects.
    - **Complexity:** O(R \* DOM_operations).

---

### `src/presentation/content.js`

- **Architecture Layer:** Data Extraction Layer. This script is programmatically injected into the target web page to scrape DOM element data.

- **State Ownership:** Stateless. The script holds no state between invocations. It initializes, receives a command, executes, and sends a response.

- **Message Schema:**
  - **Incoming (from `popup.js`):**
    - **Payload:** `{ action: 'extractElements' }`
    - **Purpose:** A command to begin the DOM extraction process.
  - **Outgoing (to `popup.js`):**
    - **On Success:** A response object: `{ success: true, data: ReportObject }`. The `ReportObject` includes the URL, title, timestamp, element count, and an array of all extracted element data.
    - **On Error:** `{ success: false, error: "Error message" }`.

- **Coupling & Dependencies:**
  - **`../domain/selectors/css-generator.js`**: Strong coupling. Called for every element to generate a stable CSS selector.
  - **`../domain/selectors/xpath-generator.js`**: Strong coupling. Called for every element to generate a robust XPath.
  - **`../infrastructure/safe-execute.js`**: Strong coupling. This is a critical dependency for resilience. The `extractElementData` function is wrapped in `safeExecute` to apply a timeout, preventing a single problematic element from halting the entire process.
  - **`../infrastructure/config.js`**, **`logger.js`**, **`error-tracker.js`**: Strong coupling to the infrastructure layer for configuration, logging, and error reporting.
  - **`popup.js`**: Loose coupling via `chrome.runtime.onMessage`. It depends on the popup to send the initial command.
  - **DOM & CSSOM APIs**: The script is tightly coupled to browser APIs like `document.querySelectorAll`, `window.getComputedStyle`, and `element.getBoundingClientRect`.

- **Interface Contract (Functions):**
  - **`chrome.runtime.onMessage` Listener**:
    - **Signature:** `(request: Object, sender: Object, sendResponse: Function) => true`
    - **Purpose:** Main entry point. Listens for `{ action: 'extractElements' }` messages from popup.
    - **Algorithm:**
      1. Checks `request.action === 'extractElements'`.
      2. Async calls `extractAllElements()`.
      3. Sends response via `sendResponse({ success: true, data: result })` on success, or `sendResponse({ success: false, error: msg })` on failure.
      4. Returns `true` to indicate async response handling.
    - **Complexity:** O(N) where N = DOM elements (deferred to extractAllElements).

  - **`extractAllElements()`**:
    - **Signature:** `async extractAllElements(): Promise<ReportObject>`
    - **Purpose:** Primary orchestration function. Extracts all relevant elements from the page.
    - **Algorithm:**
      1. Records start time for performance measurement.
      2. Queries `document.querySelectorAll('*')` to get all elements.
      3. Filters out non-relevant tags (SCRIPT, STYLE, META, LINK, NOSCRIPT, BR, HR) to reduce noise.
      4. Converts to array and processes in batches (default batch size: 10).
      5. For each element in each batch, calls `extractElementData(element, index)`.
      6. Yields to main thread after each batch via `setTimeout(resolve, 0)` to prevent page freeze.
      7. Filters out null results (skipped elements).
      8. Calculates total duration and builds return object: `{ url, title, timestamp, totalElements, duration, elements }`.
    - **Complexity:** O(N) where N = total elements. Per-element work depends on selector generation (See below).
    - **Space Complexity:** O(N) for storing element array.
    - **Batching Rationale:** Improves UI responsiveness. 10 elements per batch with 0ms yields allows ~100 yields per second.
    - **Side Effects:** Reads entire DOM.

  - **`extractElementData(element, index)`**:
    - **Signature:** `async extractElementData(element: Element, index: number): Promise<ElementData | null>`
    - **Purpose:** Wrapper that applies timeout protection to the core extraction logic.
    - **Algorithm:**
      1. Wraps `extractElementDataUnsafe()` in `safeExecute()` with timeout (default: 150ms).
      2. Returns result or `null` on timeout.
    - **Complexity:** O(element-specific) + timeout overhead.
    - **Rationale:** Prevents a single problematic element (e.g., with huge DOM tree) from blocking the entire extraction.

  - **`extractElementDataUnsafe(element, index)`**:
    - **Signature:** `async extractElementDataUnsafe(element: Element, index: number): Promise<ElementData | null>`
    - **Purpose:** Core data extraction for a single element. Gathers all relevant properties for later comparison.
    - **Algorithm:**
      1. Generates best selectors in parallel: `Promise.all([generateBestXPath(element), generateBestCSS(element)])`.
      2. Falls back to simple selectors if generators fail: `getXPath()`, `getCssSelector()`.
      3. Extracts element properties:
         - `tagName`, `id`, `className`, `textContent` (cleaned and truncated)
         - `attributes`: Iterates all attributes, extracts key ones.
         - Computed styles: Calls `extractComputedStyles(element)` to retrieve relevant CSS properties.
         - Position: Uses `getElementPosition()` from dom-utils.
         - Visibility: Calls `isElementVisible(element)` to check if rendered.
      4. Skips element if invisible OR if both XPath and CSS selector are null.
      5. Returns structured `ElementData` object or `null` if skipped.
    - **Complexity:** O(K) where K = number of element properties/attributes (~20-50 typically).
    - **Side Effects:** Reads from `window.getComputedStyle()`, which can trigger reflow in some browsers.
    - **Performance Note:** The selector generation (XPath/CSS) dominates the time per element (50-200ms), while property extraction is fast (~5-10ms).

  - **`isElementVisible(element)`**:
    - **Signature:** `isElementVisible(element: Element): boolean`
    - **Purpose:** Determines if an element is rendered on the page.
    - **Algorithm:**
      1. Checks computed style `display === 'none'` → return false.
      2. Checks computed style `visibility === 'hidden'` or `visibility === 'collapse'` → return false.
      3. Checks computed style `opacity === '0'` → return false.
      4. Checks bounding rect: `offsetWidth === 0` OR `offsetHeight === 0` → return false.
      5. Otherwise return true.
    - **Complexity:** O(1) (constant number of style reads).
    - **Caveats:** Does not check for elements hidden by overflow or positioned off-screen. More complete visibility check would be expensive.

  - **`extractComputedStyles(element)`**:
    - **Signature:** `extractComputedStyles(element: Element): Object`
    - **Purpose:** Extracts a curated list of CSS properties relevant for visual comparison.
    - **Algorithm:**
      1. Calls `window.getComputedStyle(element)`.
      2. Iterates through a predefined list of properties (font-size, color, padding, margin, display, position, etc. ~30-50 properties).
      3. For each property, reads value from computed styles and stores in result object.
      4. Returns object: `{ 'font-size': '14px', 'color': 'rgb(...)', ... }`.
    - **Complexity:** O(P) where P = number of tracked properties (~50).
    - **Optimization:** Only retrieves properties likely to be visually important. Does NOT retrieve all ~500+ CSS properties.
    - **Side Effects:** `getComputedStyle()` is expensive (can trigger browser reflow). Per-element cost: ~10-20ms on complex pages.

  - **`getXPath(element)`** (Fallback):
    - **Signature:** `getXPath(element: Element): string | null`
    - **Purpose:** Last-resort fallback to generate a simple XPath if the advanced generator fails.
    - **Algorithm:** Constructs a basic index-based XPath like `//html[1]/body[1]/div[3]/...`.
    - **Complexity:** O(D) where D = DOM depth (~10-20 typically).
    - **Robustness:** Very low. Brittle and fragile to DOM changes.

  - **`getCssSelector(element)`** (Fallback):
    - **Signature:** `getCssSelector(element: Element): string | null`
    - **Purpose:** Last-resort fallback to generate a simple CSS selector if advanced generator fails.
    - **Algorithm:** Constructs a selector using element tag and classes/id if available. E.g., `div.my-class#my-id`.
    - **Complexity:** O(C) where C = number of classes (~5-10 typically).
    - **Robustness:** Low.

---

### `src/domain/selectors/xpath-generator.js`

- **Architecture Layer:** Domain Logic (Selector Generation).

- **State Ownership:** Stateless. The generator holds no state between calls; its output depends solely on the provided element and the current state of the DOM.

- **Interface Contract:**
  - **`generateBestXPath(element)`**:
    - **Signature:** `export function generateBestXPath(element: Element): string | null`
    - **Purpose:** The sole public function. It orchestrates the entire XPath generation process, wrapping the core logic in a `safeExecute` call to protect against strategy timeouts.
    - **Input/Output:** Takes a DOM `Element` and returns a single, validated, unique XPath `string`, or `null` if generation fails.

- **Core Logic & Methodology:**
  - The generator employs a sophisticated **"tournament" model**, executing over 22 prioritized strategies in a specific order.
  - It runs through each strategy, generates candidate XPaths, and immediately validates them for uniqueness and correctness using `strictValidate`.
  - The **first** strategy to produce a valid, unique XPath wins, and its result is returned. This ensures the most robust possible selector is chosen with minimal computation.
  - A total timeout is enforced to prevent excessive execution time on complex pages.
  - **Strategy Tiers:** The strategies are tiered by robustness, from most to least reliable:
    - **High-Tier (e.g., Tiers 1-3):** Focus on explicit markers like `data-testid`, `data-qa`, a stable `id`, or unique, static text.
    - **Mid-Tier (e.g., Tiers 4-18):** Use contextual information, such as stable attributes on parent or sibling elements, ARIA roles, or combinations of attributes (`strategyMultiAttributeFingerprint`).
    - **Fallback-Tier (e.g., Tiers 19-22):** Used as a last resort. This includes the `strategyGuaranteedPath`, which generates a full, brittle, index-based path from the document root, guaranteeing a result but at the cost of stability.

- **Message Schema:** Not applicable.

- **Coupling & Dependencies:**
  - **`../../shared/dom-utils.js`**: Very strong coupling. This is the most critical dependency, providing essential functions for DOM analysis like `isStableId`, `isStableClass`, `getBestAttribute`, and `getStableAncestorChain`.
  - **`../../infrastructure/safe-execute.js`**: Strong coupling. The entry point is wrapped in `safeExecute` to provide timeout protection.
  - **`../../infrastructure/config.js`**: Used to fetch configuration values for timeouts.
  - **DOM APIs**: Tightly coupled to browser APIs like `document.evaluate` for XPath validation.

---

### `src/domain/selectors/css-generator.js`

- **Architecture Layer:** Domain Logic (Selector Generation).

- **State Ownership:** Stateless. The generator's output is purely dependent on the input element and the current state of the DOM.

- **Interface Contract:**
  - **`generateBestCSS(element)`**:
    - **Signature:** `export function generateBestCSS(element: Element): string | null`
    - **Purpose:** The sole public function for generating a CSS selector. It wraps the core logic in `safeExecute` to protect against timeouts.
    - **Input/Output:** Takes a DOM `Element` and returns a single, validated, unique CSS selector `string`, or `null` if generation fails.

- **Core Logic & Methodology:**
  - The generator employs a **"cascade" model**, executing 10 strategies in a fixed, prioritized order.
  - It tries each strategy sequentially. The first strategy that produces a selector passing the `isUnique` validation check wins, and its result is immediately returned.
  - The `isUnique` function is the core validator, ensuring any candidate selector matches exactly one element on the page, and that it is the correct target element.
  - **Strategy Cascade Order:** The strategies are ordered from most to least robust:
    1.  **ID:** Uses the element's ID (`#my-id`).
    2.  **Test Attributes:** Checks for `data-testid`, `data-qa`, etc.
    3.  **Combined Data Attributes:** Combines multiple `data-*` attributes for specificity.
    4.  **Type & Name:** For form elements, e.g., `input[type="text"]`.
    5.  **Class & Attribute:** Combines a meaningful class with a stable attribute.
    6.  **Parent > Child:** Uses the direct child combinator from a stable parent.
    7.  **Parent Descendant:** Uses the descendant combinator.
    8.  **Pseudo-classes:** Uses stateful selectors like `:disabled` or `:checked`.
    9.  **:nth-child:** A positional, more brittle fallback.
    10. **:nth-of-type:** The final positional fallback.

- **Message Schema:** Not applicable.

- **Coupling & Dependencies:**
  - **`../../shared/dom-utils.js`**: Strong coupling. Relies on `isStableId` for ID validation and `walkUpTree` to find stable ancestor elements for contextual selectors.
  - **`../../infrastructure/safe-execute.js`**: Strong coupling. Used to provide timeout protection for the generation process.
  - **`../../infrastructure/config.js`**: Fetches configuration values for timeouts.
  - **DOM APIs**: Tightly coupled to `document.querySelectorAll` and `CSS.escape` for validation and selector construction.

---

### `src/shared/dom-utils.js`

- **Architecture Layer:** Shared Utilities. This is a foundational, stateless library of pure functions providing low-level DOM interrogation and stability analysis capabilities to the selector generators.

- **State Ownership:** Stateless. The module exports pure functions that do not maintain any internal state.

- **Interface Contract (Key Functions):**
  - **Stability Validators**: This is the module's core responsibility. It contains the business logic for identifying "stable" identifiers using extensive, heuristic-based regex patterns.
    - `isStableId(id)`: Validates an ID, returning `false` if it appears dynamically generated (e.g., contains UUIDs, is all-numeric, or matches known framework patterns like `ember...` or `lightning-...`).
    - `isStableClass(className)`: Rejects class names matching patterns from common CSS-in-JS libraries or frameworks (e.g., `Mui...`, `css-...`, `sc-...`).
    - `isStaticText(text)`: Filters out dynamic text content like timestamps, currency, or loading indicators.

  - **Attribute Collectors**: These functions prioritize and gather attributes for building selectors.
    - `collectStableAttributes(element)`: Collects all stable attributes from an element in a prioritized order: test attributes (`data-testid`) first, then other meaningful attributes (`role`, `href`), and finally any other `data-*` attributes.
    - `getBestAttribute(element)`: A convenience wrapper that returns only the single highest-priority stable attribute for an element.

  - **DOM Traversal**: These helpers enable safe and intelligent traversal of the DOM tree.
    - `walkUpTree(element, maxDepth)`: Safely traverses up the DOM from a starting element to a specified maximum depth, returning an array of ancestors.
    - `getStableAncestorChain(element, maxDepth)`: Finds a chain of parent elements that have stable attributes, which is critical for creating robust, contextual selectors.
    - `findBestSemanticAncestor(element)`: Locates the nearest parent with a meaningful HTML tag (e.g., `<form>`, `<nav>`) that also possesses a stable attribute.

- **Message Schema:** Not applicable.

- **Coupling & Dependencies:**
  - **`../infrastructure/logger.js`**: Loosely coupled for logging rare errors within `try...catch` blocks.
  - **Selector Generators**: While this module does not depend on them, `xpath-generator.js` and `css-generator.js` are both critically dependent on this file for their core stability analysis logic.
  - **DOM APIs**: Tightly coupled to standard browser DOM APIs.

---

### `src/domain/engines/normalizer-engine.js`

- **Architecture Layer:** Domain Logic (Normalization Engine). This module acts as a **Facade** that orchestrates the complex process of CSS normalization.

- **State Ownership:**
  - **In-Memory State**: The engine is stateful.
    - `_cache` (Map): It maintains an LRU (Least Recently Used) cache that stores the results of property-value normalizations (e.g., mapping `red` to `rgba(255, 0, 0, 1)`). This significantly improves performance on subsequent normalizations of the same style, but is only used when a DOM element context is not required.
    - It also holds instances of the various normalization strategy classes.

- **Interface Contract:**
  - **`normalize(cssObject, element)`**:
    - **Signature:** `normalize(cssObject: Object, element?: Element): Object`
    - **Purpose:** The main public method. It takes a raw CSS style object and returns a new object where all values are canonicalized.
    - **Orchestration Flow:**
      1.  The input object is first passed to `ShorthandExpander` to break down properties like `margin` into their longhand equivalents (`margin-top`, etc.).
      2.  It then iterates through each property of the expanded object and delegates to the appropriate strategy (`ColorNormalizer`, `UnitNormalizer`, `FontNormalizer`) based on the property name.
      3.  The `UnitNormalizer` is the only strategy that requires the optional `element` parameter to resolve relative units (like `em`, `rem`, `%`) into pixels.

- **Message Schema:** Not applicable.

- **Coupling & Dependencies:**
  - **`../strategies/normalization/*.js`**: Has strong, direct dependencies on all normalization strategy modules (`color-normalizer.js`, `unit-normalizer.js`, `shorthand-expander.js`, `font-normalizer.js`), which it instantiates and delegates to.
  - **`popup.js`**: The `NormalizerEngine` is instantiated and used by `popup.js` to process reports before the comparison logic is run.

---

### Normalization Strategies (`src/domain/strategies/normalization/`)

This directory contains a set of stateless, single-purpose modules, each responsible for normalizing one aspect of CSS. They are orchestrated by the `NormalizerEngine`.

- **`shorthand-expander.js`**:
  - **Purpose:** The first step in normalization. It expands CSS shorthand properties into their longhand equivalents for explicit comparison.
  - **Interface:** `expand(cssObject)` takes a style object and returns a new object with shorthands expanded (e.g., `margin: 10px` becomes `margin-top: 10px`, etc.).
  - **Dependencies:** None. It is a pure data transformation module.

- **`color-normalizer.js`**:
  - **Purpose:** Converts all valid color formats (named, hex, rgb, hsl) into a single, canonical `rgba(r, g, b, a)` string.
  - **Interface:** `normalize(color)` takes a color string (e.g., `#F00`, `red`) and returns its `rgba()` equivalent.
  - **State:** It lazy-loads a read-only map of named CSS colors on first use.
  - **Dependencies:** None.

- **`unit-normalizer.js`**:
  - **Purpose:** Converts all CSS length units into a canonical `px` value for consistent numerical comparison.
  - **Interface:** `normalize(property, value, element)` takes a CSS value and the **live DOM element** to which it applies.
  - **Dependencies:** This is the only normalizer with a **strong dependency on the live DOM**. It requires the element context to resolve relative units (`em`, `rem`, `%`) and viewport units (`vw`, `vh`) into absolute pixel values.

- **`font-normalizer.js`**:
  - **Purpose:** Standardizes `font-family` strings by removing quotes, normalizing spacing, and lower-casing generic family names (`sans-serif`, etc.).
  - **Interface:** `normalize(value)` takes a `font-family` string and returns the cleaned version.
  - **Dependencies:** None.

---

### `src/domain/engines/detector-engine.js`

- **Architecture Layer:** Domain Logic (Detection Engine).
- **Purpose:** This stateless engine infers the "component type" of a given DOM element using a cascade of heuristics. This is a critical prerequisite for dynamic matching.
- **Interface:** `detectComponentType(element)` is the main method. It uses the following strategies in order of confidence:
  1.  `data-component` attribute.
  2.  BEM class name patterns (e.g., `block__element`).
  3.  ARIA roles (e.g., `role="dialog"`).
  4.  Semantic HTML tags (e.g., `<nav>`).
  5.  Common class name prefixes (e.g., `card-`).
- **Coupling:** It is a key dependency for the `DynamicMatcher`.

---

### Matching Engine & Strategies (`src/domain/engines/matcher-engine.js`, etc.)

- **Architecture Layer:** Domain Logic (Matching).
- **Purpose:** This system identifies corresponding elements between two different webpage captures. It is orchestrated by the `MatcherEngine`.

- **`matcher-engine.js` (Facade):**
  - **Purpose:** Orchestrates the matching process by selecting from different strategies based on a `mode` parameter (`static`, `dynamic`, `hybrid`).
  - **Interface:** `match(baselineElements, compareElements, options)` is the main entry point that delegates to the appropriate strategy.

- **`static-matcher.js` (Strategy):**
  - **Purpose:** The primary, high-confidence strategy that assumes elements have stable identifiers.
  - **Methodology:** Matches elements using a cascade of techniques: 1) Test IDs (`data-testid`), 2) Stable element IDs, 3) High-quality CSS/XPath selectors.

- **`dynamic-matcher.js` (Strategy):**
  - **Purpose:** A specialized strategy for modern, dynamic UIs where element order and attributes may change.
  - **Methodology:** Uses the `DetectorEngine` to group elements by component type. It then either matches the groups as a whole if their CSS structure is consistent (a "template") or matches elements based on their order within the group.

- **`position-matcher.js` (Strategy):**
  - **Purpose:** A low-confidence fallback strategy.
  - **Methodology:** Matches elements based purely on their spatial proximity (i.e., how many pixels apart they are), used when other strategies fail.

---

### `src/infrastructure/config.js`

- **Architecture Layer:** Infrastructure. It acts as the centralized, single source of truth for all application settings.

- **State Ownership:** It manages the application's entire configuration state.
  - **Immutability:** The module is designed to be **immutable** after initialization. The `init()` method performs a deep freeze on the configuration object, preventing any runtime modifications and ensuring predictable behavior across the application.
  - **State:**
    - `_config`: The internal, frozen object holding all configuration values.
    - `_frozen`: A boolean flag to prevent re-initialization.

- **Interface Contract:**
  - **`init(overrides)`**:
    - **Signature:** `init(overrides?: Object): Config`
    - **Purpose:** Called once at application startup. It merges hard-coded defaults with any runtime overrides, validates the final structure, and freezes the result to make it read-only. This "fail-fast" approach ensures configuration errors are caught immediately.
  - **`get(path, fallback)`**:
    - **Signature:** `get(path: string, fallback?: any): any`
    - **Purpose:** The primary method used by other modules to consume configuration values. It retrieves a setting using a dot-separated path (e.g., `'selectors.xpath.totalTimeout'`).

- **Message Schema:** Not applicable.

- **Coupling & Dependencies:**
  - This module is foundational and has **zero external dependencies**.
  - Conversely, nearly every other module in the application (from presentation to domain logic) depends on this file to retrieve settings.

---

### `src/infrastructure/logger.js`

- **Architecture Layer:** Infrastructure. Provides a centralized, structured logging service for the entire application.

- **State Ownership:** The logger is stateful.
  - `context` (Object): A global context object that is automatically merged into every log message, providing consistent metadata.
  - `StorageTransport.buffer` (Array): The `StorageTransport` maintains an in-memory circular buffer of log entries, which is periodically flushed to `chrome.storage.local`.

- **Interface Contract:**
  - **`init()`**: Initializes the logger based on settings from `config.js`. It sets the minimum logging level (e.g., 'info') and configures the output transports.
  - **Logging Methods (`debug`, `info`, `warn`, `error`)**: The primary interface for logging. They create a structured log entry (with timestamp, level, message, and metadata) and pass it to all configured transports, but only if the message's severity meets the configured level.
  - **`setContext(context)`**: Sets global metadata (e.g., `{ script: 'popup' }`) to be included in all subsequent logs.
  - **`measure(label, fn)`**: A high-level utility function that wraps a given function or promise to measure its execution time using `performance.now()`. It automatically logs the result, making it a powerful tool for performance monitoring.

- **Core Logic & Methodology (Transports):**
  - The logger uses a **transport** system to define where logs are written.
  - **`ConsoleTransport`**: Writes formatted logs to the developer console.
  - **`StorageTransport`**: Writes logs to an in-memory buffer which is then periodically persisted to `chrome.storage.local`, allowing logs to be saved and exported for diagnostics.

- **Message Schema:** Not applicable.

- **Coupling & Dependencies:**
  - **`./config.js`**: Tightly coupled. The logger's level, persistence, and other settings are all driven by the `config` module.
  - **Chrome APIs**: The `StorageTransport` depends on `chrome.storage.local`.
  - **Application-wide Dependency**: This module is a dependency for nearly every other module in the application.

---

### `src/infrastructure/error-tracker.js`

- **Architecture Layer:** Infrastructure. Provides a service for tracking and aggregating application errors, with a key feature of preventing log spam.

- **State Ownership:** The tracker is stateful.
  - `errors` (Map): It maintains an in-memory `Map` of unique errors. When a known error reoccurs, its counter is simply incremented instead of creating a new log entry.
  - **LRU Eviction**: To prevent unbounded memory growth, the `errors` map is capped at a maximum size (from config) and uses an LRU (Least Recently Used) eviction policy.

- **Interface Contract:**
  - **`ErrorCodes` (Exported Enum)**: Provides a standardized, exported object of constant error codes (e.g., `EXTRACTION_TIMEOUT`, `STORAGE_WRITE_FAILED`). This ensures a consistent error vocabulary across the application.
  - **`logError(code, message, context)`**: The primary method for logging a structured error. It performs the core deduplication logic: if the error has been seen before, it increments a counter; otherwise, it creates a new entry. It then calls `logger.error()` to ensure the issue is still captured in the standard logs.
  - **`createError(code, message, context)`**: A utility that calls `logError` and then returns a new `TrackedError` instance, which can be thrown by the calling code.
  - **Diagnostic Methods (`getErrors`, `getMostFrequent`, `exportErrors`)**: A suite of public methods that allow other parts of the application to query the aggregated error data for diagnostics and health monitoring.

- **Message Schema:** Not applicable.

- **Coupling & Dependencies:**
  - **`./config.js`**: Tightly coupled for retrieving settings like deduplication behavior and maximum error map size.
  - **`./logger.js`**: Tightly coupled, as it delegates to the standard logger after processing an error.
  - **Application-wide Dependency**: Used by any module that needs to report structured, non-fatal errors without spamming the logs.

---

### `src/infrastructure/safe-execute.js`

- **Architecture Layer:** Infrastructure. Provides a suite of high-level functions that wrap asynchronous operations to make them resilient against common failures.

- **State Ownership:** The module is stateful.
  - `circuitBreakers` (Map): It manages a global, in-memory collection of `CircuitBreaker` instances. Each breaker tracks the failure rate of a specific, named operation (e.g., 'xpath-generation'), forming the basis of the Circuit Breaker pattern.

- **Interface Contract & Resilience Patterns:**
  - **`safeExecute(fn, options)` - Timeout Pattern**:
    - Runs an async function but races it against a `setTimeout`. If the function does not complete within the configured timeout, it is abandoned and a fallback value is returned.
    - **Purpose:** To prevent a single, slow operation (like processing one difficult DOM element) from halting an entire batch process.

  - **`safeExecuteWithRetry(fn, options)` - Retry & Circuit Breaker Pattern**:
    - This is a more advanced wrapper that combines three patterns:
      1.  **Timeout**: The same timeout logic as `safeExecute`.
      2.  **Retry with Exponential Backoff**: If the operation fails with a _transient_ error (e.g., a timeout), it automatically waits for a short, increasing delay and retries the operation several times before failing permanently.
      3.  **Circuit Breaker**: Before executing, it checks a global `CircuitBreaker` for that operation. If the operation has failed too frequently, the breaker is "tripped" (put in an `OPEN` state), and all subsequent calls fail immediately without attempting to run. This prevents the application from wasting resources on a service or function that is known to be unhealthy.

  - **`safeExecuteAll(functions, options)` - Bulkhead Pattern**:
    - Takes an array of functions and runs them all in parallel. Each function is individually wrapped in `safeExecute`, isolating it from the others.
    - **Purpose:** Ensures that the failure or timeout of one function in a batch does not affect the execution or completion of the others.

- **Message Schema:** Not applicable.

- **Coupling & Dependencies:**
  - **`./config.js`**, **`./logger.js`**, **`./error-tracker.js`**: Tightly coupled to the rest of the infrastructure layer for configuration, detailed logging of its state (retries, circuit breaker trips), and error reporting.
  - **Application-wide Dependency**: A key dependency for any module performing potentially unreliable operations, such as `content.js` and the selector generators.

---

### `src/infrastructure/di-container.js`

- **Architecture Layer:** Infrastructure
- **Status:** **Unused.** While present, this DI container is not integrated into the application. All modules resolve their dependencies via direct ES6 `import` statements. This component may be legacy code or an unfulfilled architectural goal.

# UI_Comparison Project Structure

UI_Comparison/
├── .eslintrc.json # ESLint configuration
├── .gitignore # Git ignore file
├── .prettierrc # Prettier configuration
├── manifest.json # Chrome extension manifest
├── package.json # NPM package configuration
├── PROJECT_STRUCTURE.txt # Project structure documentation
├── SYSTEM_REFERENCE.md # System reference documentation
├── webpack.config.js # Webpack configuration
│
├── Images/ # Extension icons
│ ├── icon16.png # 16x16 icon
│ ├── icon48.png # 48x48 icon
│ └── icon128.png # 128x128 icon
│
├── libs/ # External libraries
│ ├── DOWNLOAD_XLSX_LIBRARY.txt # Notes on XLSX library
│ └── xlsx.full.min.js # XLSX library for Excel operations
│
└── src/ # Source code directory
│
├── application/ # Application layer (currently empty)
│
├── domain/ # Domain layer
│ ├── engines/ # Engine modules
│ │ ├── detector-engine.js # Component type detection
│ │ ├── matcher-engine.js # Element matching orchestration
│ │ └── normalizer-engine.js # CSS normalization with LRU caching
│ │
│ ├── selectors/ # Selector generation modules
│ │ ├── css-generator.js # 10-strategy CSS selector generator
│ │ └── xpath-generator.js # 22-strategy XPath generator with tournament logic
│ │
│ └── strategies/ # Strategy modules (pluggable implementations)
│ ├── matching/ # Matching strategies for element pairing
│ │ ├── dynamic-matcher.js # Component-based dynamic matching
│ │ ├── position-matcher.js # Spatial proximity fallback
│ │ └── static-matcher.js # Primary stable identifier matching
│ └── normalization/ # CSS normalization strategies
│ ├── color-normalizer.js # Hex/RGB/HSL → rgba() normalization
│ ├── font-normalizer.js # Font-family string standardization
│ ├── named-colors.js # CSS named colors reference data (150+ colors)
│ ├── shorthand-expander.js # margin/padding/border/font expansion
│ └── unit-normalizer.js # em/rem/px/% → px conversion
│
├── infrastructure/ # Cross-cutting infrastructure services
│ ├── config.js # Immutable configuration management (single source of truth)
│ ├── di-container.js # Dependency injection container (unused)
│ ├── error-tracker.js # Error aggregation with deduplication & LRU eviction
│ ├── logger.js # Structured logging with transports (console + storage)
│ └── safe-execute.js # Resilience wrapper (timeout, retry, circuit breaker, bulkhead patterns)
│
├── presentation/ # UI layer (popup interface)
│ ├── content.js # Content script (injected into page, extracts DOM data)
│ ├── popup.css # Popup styling
│ ├── popup.html # Extension popup UI
│ └── popup.js # Popup controller (main orchestrator, report management)
│
└── shared/ # Reusable utility library
└── dom-utils.js # DOM interrogation, stability validators, utilities

---

## 8. Key Dependencies & Coupling Map

### Critical Dependencies (Strong Coupling)

| Module                 | Depends On                             | Purpose                            |
| ---------------------- | -------------------------------------- | ---------------------------------- |
| `popup.js`             | `MatcherEngine`, `NormalizerEngine`    | Core comparison logic              |
| `popup.js`             | `config`, `logger`, `errorTracker`     | Infrastructure services            |
| `content.js`           | `generateBestXPath`, `generateBestCSS` | Selector generation                |
| `content.js`           | `safeExecute`                          | Timeout protection                 |
| All engines/strategies | `dom-utils.js`                         | Stability validation & DOM helpers |
| `selector-generators`  | `safe-execute.js`                      | Timeout protection                 |
| `normalizer-engine`    | Normalization strategies               | Orchestration                      |

### Loose Coupling (via Messaging)

| Module A   | Module B               | Protocol                  | Notes                           |
| ---------- | ---------------------- | ------------------------- | ------------------------------- |
| `popup.js` | `content.js`           | `chrome.tabs.sendMessage` | `{ action: 'extractElements' }` |
| `popup.js` | `chrome.storage.local` | Storage API               | Report persistence              |
| `logger`   | `chrome.storage.local` | Storage API               | Log persistence (buffered)      |

### Unused / Legacy

| Module            | Status | Notes                                                            |
| ----------------- | ------ | ---------------------------------------------------------------- |
| `di-container.js` | Unused | Dependency injection not integrated; all modules use ES6 imports |
| `application/`    | Empty  | Layer not populated in current implementation                    |

---

## 9. Configuration System Deep Dive

### Configuration Hierarchy & Defaults

The system uses a frozen, immutable configuration. Key sections:

```javascript
{
  extraction: {
    timeout: 150,          // ms per element
    batchSize: 10,         // elements per batch
    maxRetries: 3,
    skipInvisible: true,
    maxDepth: 100          // DOM traversal depth limit
  },

  normalization: {
    colorTolerance: 5,     // % RGB distance threshold
    sizeTolerance: 3,      // px difference threshold
    enableCaching: true,
    cacheMaxSize: 1000     // LRU cache size
  },

  matching: {
    defaultMode: 'static', // 'static' | 'dynamic' | 'hybrid'
    minConfidence: 0.50,   // Minimum match confidence
    positionTolerance: 50, // pixels for spatial matching
    templateThreshold: 0.90,
    enableFallback: true   // Position fallback if static matching fails
  },

  selectors: {
    xpath: {
      maxStrategies: 22,
      earlyExitAfter: 1,
      strategyTimeout: 100,
      totalTimeout: 500
    },
    css: {
      maxStrategies: 10,
      strategyTimeout: 200,
      earlyExitAfter: 1,
      totalTimeout: 300
    }
  },

  storage: {
    keys: {
      reports: 'page_comparator_reports',
      logs: 'page_comparator_logs'
    },
    maxReports: 50
  },

  logging: {
    level: 'info',
    persistLogs: true
  }
}
```

### Mutation Safety

The config is **frozen after initialization**, making it impossible to accidentally mutate at runtime.

---

## 10. Testing & Debugging Guide

### Enabling Debug Logs

Edit `config.js` to set `logging.level: 'debug'`. Logs appear in:

1. Browser DevTools Console (popup context)
2. `chrome.storage.local['page_comparator_logs']` (persistent)

### Common Issues & Troubleshooting

| Issue                       | Cause                                       | Solution                                          |
| --------------------------- | ------------------------------------------- | ------------------------------------------------- |
| "Cannot access this page"   | Browser internal pages (chrome://, edge://) | Expected; skip these pages                        |
| Extraction >30 seconds      | >5000 elements or slow selector generation  | Increase `selectors.xpath.totalTimeout` in config |
| "No valid XPath found"      | All 22 strategies fail (rare)               | Check for element detachment                      |
| Comparison shows no matches | Selectors changed between extractions       | Re-extract if page has mutated                    |
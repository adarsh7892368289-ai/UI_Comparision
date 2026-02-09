# SYSTEM_REFERENCE.md

This document serves as the high-fidelity technical blueprint for the UI_Comparison extension.

## 1. Overall Architecture

The project follows a layered architecture pattern, separating concerns into distinct logical components:

- **Presentation Layer (`src/presentation`):** Handles all user interaction. This includes the extension's popup (`popup.html`, `popup.js`, `popup.css`) and the content script (`content.js`) that interacts with the web page.
- **Application Layer (`src/application`):** Orchestrates the core application logic. (Currently empty, suggesting logic might be in other layers).
- **Domain Layer (`src/domain`):** Contains the business logic for generating selectors (`css-generator.js`, `xpath-generator.js`). This is the core of the element identification process.
- **Infrastructure Layer (`src/infrastructure`):** Provides cross-cutting technical services like configuration (`config.js`), dependency injection (`di-container.js`), logging (`logger.js`), error handling (`error-tracker.js`), and safe execution contexts (`safe-execute.js`).
- **Shared Utilities (`src/shared`):** Contains common utilities, such as DOM manipulation functions (`dom-utils.js`), used across different layers.

## 2. File-by-File Analysis

This section details the technical specifications of each file in the system.

### `manifest.json`

- **Architecture Layer:** Configuration
- **State Ownership:** None.
- **Interface Contract:** Not applicable (declarative JSON).
- **Message Schema:** Not applicable.
- **Coupling & Dependencies:**
    - **Defines Entry Points:**
        - **Popup:** `popup.html` is the entry point for user interaction via the extension's toolbar action.
        - **Content Script:** Injects `content.js` into all web pages (`<all_urls>`).
    - **Permissions:**
        - `activeTab`: Allows the extension to interact with the currently active tab.
        - `storage`: Grants access to the `chrome.storage` API for data persistence.
        - `scripting`: Required to execute scripts in different contexts.
    - **Icons:** Specifies the paths to the extension's icons.

### `src/presentation/popup.html`

-   **Architecture Layer:** Presentation
-   **State Ownership:** None. This file defines the static DOM structure.
-   **Interface Contract:** Not applicable (HTML document). The file provides the UI structure for the extension's popup, including two main tabs: "Extract Elements" and "Compare Reports". It defines the buttons, input fields, and containers that `popup.js` will interact with.
-   **Message Schema:** Not applicable.
-   **Coupling & Dependencies:**
    -   **CSS:** Links to `popup.css` for all styling information.
    
-   **JavaScript:**
        -   Includes `libs/xlsx.full.min.js`, making the XLSX library available in the popup's global scope for Excel file generation.
        -   Includes `popup.js`, which contains all the logic for handling user interactions within the popup.

### `src/presentation/popup.js`

-   **Architecture Layer:** Presentation (UI Controller)
-   **State Ownership:**
    -   **In-Memory:** `let reports = [];` holds the array of all loaded/captured element reports.
    -   **`chrome.storage.local`:** Persists the `reports` array under a key defined in the configuration (defaults to `page_comparator_reports`).
-   **Interface Contract:**
    -   **`DOMContentLoaded` Event Listener:**
        -   **Signature:** `document.addEventListener('DOMContentLoaded', async () => { ... })`
        -   **Purpose:** Initializes the popup, loads reports from storage, gets the current page URL, and sets up all UI event listeners.
        -   **Side Effects:** Calls `loadReports()`, `loadCurrentPageUrl()`, `setupTabs()`. Attaches click handlers to buttons.
    -   **`extractElements()`**
        -   **Signature:** `async function extractElements()`
        -   **Purpose:** Orchestrates the entire element extraction process.
        -   **Side Effects:** Mutates the DOM to show loading states. Injects `content.js` via `chrome.scripting.executeScript`. Sends a message to the content script and awaits a response. On success, it creates a new report object, saves it to storage via `saveReports()`, and updates the UI via `displayReports()` and `populateReportSelectors()`.
    -   **`loadReports()`**
        -   **Signature:** `async function loadReports()`
        -   **Purpose:** Fetches the report array from `chrome.storage.local`.
        -   **Side Effects:** Populates the in-memory `reports` array and calls `displayReports()` to render them.
    -   **`saveReports()`**
        -   **Signature:** `async function saveReports()`
        -   **Purpose:** Saves the in-memory `reports` array to `chrome.storage.local`, enforcing the `maxReports` limit from configuration.
        -   **Side Effects:** Writes data to `chrome.storage.local`.
    -   **`downloadReport(reportId)`**
        -   **Signature:** `function downloadReport(reportId)`
        -   **Purpose:** Generates an `.xlsx` file from the selected report's data.
        -   **Side Effects:** Triggers a browser file download.
        -   **Dependencies:** Relies on the `XLSX` library being available in the global scope.
    -   **`compareReports()`**
        -   **Signature:** `function compareReports()`
        -   **Purpose:** Manages the comparison process between two user-selected reports.
        -   **Side Effects:** Reads selected values from the DOM, calls `performComparison()`, and renders the output by calling `displayComparisonResults()`.
    -   **`performComparison(report1, report2)`**
        -   **Signature:** `function performComparison(report1, report2)`
        -   **Purpose:** Contains the core logic for diffing two reports. It uses a keying strategy (XPath or CSS selector) to create a `Map` of elements for efficient lookup.
        -   **Input/Output:** Takes two report objects; returns an object `{ added: [], removed: [], modified: [] }`.
        -   **Complexity:** The use of `Map` makes this an efficient O(N + M) operation, where N and M are the element counts of the two reports.
-   **Message Schema:**
    -   **Outgoing (to `content.js`):**
        ```json
        {
          "action": "extractElements"
        }
        ```
-   **Coupling & Dependencies:**
    -   **DOM:** Tightly coupled to the element IDs and classes in `popup.html`.
    -   **Infrastructure:** Imports and uses `config.js`, `logger.js`, and `error-tracker.js`.
    -   **Chrome APIs:** `chrome.tabs`, `chrome.storage`, `chrome.scripting`.
    
-   **Libraries:** Expects `XLSX` from `libs/xlsx.full.min.js` to be in the global scope.

### `src/presentation/content.js`

-   **Architecture Layer:** Presentation (DOM Interaction)
-   **State Ownership:** Stateless. The script executes, gathers data, and responds within a single message lifecycle.
-   **Interface Contract:**
    -   **`chrome.runtime.onMessage` Listener:** The primary entry point.
        -   **Purpose:** Listens for requests from the extension's popup.
        -   **Trigger:** Fires when `chrome.runtime.sendMessage` is called from another extension context.
        -   **Action:** If `request.action === 'extractElements'`, it initiates the element scraping process by calling `extractAllElements()`. It uses `sendResponse` to return the data asynchronously.
    -   **`extractAllElements()`**
        -   **Signature:** `async function extractAllElements()`
        -   **Purpose:** Iterates through every element on the page (`document.querySelectorAll('*')`), filters unwanted tags, and gathers detailed data for each valid element using `extractElementData`.
        -   **Complexity:** This is an O(N) operation, where N is the total number of DOM elements on the page. Performance is directly proportional to page size.
    -   **`extractElementDataUnsafe(element, index)`**
        -   **Signature:** `function extractElementDataUnsafe(element, index)`
        -   **Purpose:** Extracts all relevant properties from a single DOM element, including generating its XPath and CSS selectors by calling the respective generators. It also determines element visibility.
-   **Message Schema:**
    -   **Incoming (Request from `popup.js`):**
        ```json
        { "action": "extractElements" }
        ```
    -   **Outgoing (Response to `popup.js`):**
        -   **Success:**
            ```json
            {
              "success": true,
              "data": {
                "url": "...",
                "title": "...",
                "totalElements": 42,
                "elements": [ { /* ...element data... */ } ]
              }
            }
            ```
        -   **Failure:**
            ```json
            { "success": false, "error": "Error message details." }
            ```
-   **Coupling & Dependencies:**
    -   **DOM:** Tightly coupled to the live DOM of the web page it is injected into.
    -   **Domain Logic:** Imports and uses `generateBestCSS` and `generateBestXPath` from the `src/domain/selectors/` directory.
    -   **Infrastructure:** Imports and uses `config.js`, `logger.js`, `error-tracker.js`, and `safe-execute.js`.
    -   **Chrome APIs:** `chrome.runtime.onMessage`.

### `src/domain/selectors/xpath-generator.js`

-   **Architecture Layer:** Domain
-   **State Ownership:** Stateless. The functions are pure, operating only on the provided DOM element and the global `document` context.
-   **Interface Contract:**
    -   **`generateBestXPath(element)` (Exported):**
        -   **Signature:** `export function generateBestXPath(element)`
        -   **Purpose:** The main public entry point for the module. It orchestrates the entire XPath generation process for a single DOM element, returning the first valid, unique XPath found. It wraps the core logic in a `safeExecute` call to enforce a timeout.
        -   **Input/Output:** Takes a DOM element; returns a string containing the generated XPath, or `null` if no valid XPath could be created.
    -   **`generateBestXPathUnsafe(element)`:**
        -   **Purpose:** Implements a "tournament" system that runs through 22+ different XPath generation strategies in a prioritized order. These strategies range from highly specific (e.g., using a `data-testid` attribute) to general fallbacks (e.g., a full path from the root). It validates each generated candidate for uniqueness and correctness.
    -   **`XPathStrategies` Class:**
        -   **Purpose:** A container for all the individual XPath generation methods (e.g., `strategyStableId`, `strategyVisibleTextNormalized`, `strategyPrecedingContext`), each representing a different "tier" in the tournament.
    -   **`strictValidate(...)` & `ensureUniqueness(...)`:**
        -   **Purpose:** Helper functions that are critical to the process. `strictValidate` confirms that an XPath resolves to exactly one element, which is the target element. `ensureUniqueness` attempts to refine a non-unique XPath by adding contextual information from its ancestors.
-   **Message Schema:** Not applicable.
-   **Coupling & Dependencies:**
    -   **DOM:** Heavily coupled to the live DOM for evaluation and validation (`document.evaluate`).
    -   **Shared Utilities:** Tightly coupled to `src/shared/dom-utils.js`, importing numerous helper functions (`getBestAttribute`, `isStableId`, `cleanText`, etc.).
    
-   **Infrastructure:** Imports and uses `config.js`, `logger.js`, `error-tracker.js`, and `safe-execute.js`.

### `src/domain/selectors/css-generator.js`

-   **Architecture Layer:** Domain
-   **State Ownership:** Stateless.
-   **Interface Contract:**
    -   **`generateBestCSS(element)` (Exported):**
        -   **Signature:** `export function generateBestCSS(element)`
        -   **Purpose:** The main public entry point for the module. It orchestrates the CSS selector generation process for a single DOM element, returning the first valid, unique selector found from a prioritized cascade of strategies. It is wrapped in a `safeExecute` call to enforce a timeout.
        -   **Input/Output:** Takes a DOM element; returns a string containing the generated CSS selector, or `null` if one could not be created.
    -   **`generateBestCSSUnsafe(element)`:**
        -   **Purpose:** Implements a "cascade" system that runs through 10 different CSS selector generation strategies in order. It tries each strategy (e.g., using ID, data attributes, classes, `:nth-child`) and returns the first selector that is successfully validated as unique.
    -   **`isUnique(selector, element)`:**
        -   **Purpose:** A critical validation function that ensures a generated selector is syntactically valid, matches exactly one element on the page, and that the matched element is the original target element.
-   **Message Schema:** Not applicable.
-   **Coupling & Dependencies:**
    -   **DOM:** Tightly coupled to the live DOM for validation (`document.querySelectorAll`, `CSS.escape`).
    -   **Shared Utilities:** Imports and uses `isStableId` and `walkUpTree` from `src/shared/dom-utils.js`.
    -   **Infrastructure:** Imports and uses `config.js`, `logger.js`, `error-tracker.js`, and `safe-execute.js`.

### `src/infrastructure/config.js`

-   **Architecture Layer:** Infrastructure
-   **State Ownership:**
    -   **In-Memory & Immutable:** The module exports a singleton `Config` instance that holds all application settings in a private `_config` object.
    -   After the `init()` method is called once at startup, the internal configuration object is frozen with `Object.freeze()`, preventing any further modifications at runtime.
-   **Interface Contract:**
    -   **`init(overrides = {})`:**
        -   **Purpose:** Merges the hardcoded default settings with any provided overrides, validates the final configuration against a set of rules, and freezes the result. Designed to be called once.
        -   **Side Effects:** Throws an error on invalid configuration, preventing the application from starting in a bad state.
    -   **`get(path, fallback = undefined)`:**
        -   **Purpose:** The primary method used by other modules to retrieve configuration values using a dot-notation path (e.g., `comparison.matchStrategy`).
-   **Message Schema:** Not applicable.
-   **Coupling & Dependencies:**
    -   **None.** This is a foundational, self-contained module with zero external dependencies. Other modules depend on it.

### `src/infrastructure/logger.js`

-   **Architecture Layer:** Infrastructure
-   **State Ownership:**
    -   The exported singleton `Logger` instance holds the current log `level` and a `context` object that is added to all subsequent log entries.
    -   The internal `StorageTransport` class maintains an in-memory `buffer` of log entries.
    -   **`chrome.storage.local`:** The `StorageTransport` periodically flushes its buffer to `chrome.storage.local` under a key defined in the configuration.
-   **Interface Contract:**
    -   **`init()`:**
        -   **Purpose:** Initializes the logger based on settings from `config.js`. It sets the minimum log level to record and configures the transports (e.g., `ConsoleTransport`, `StorageTransport`).
    -   **`setContext(context)`:**
        -   **Purpose:** Attaches a metadata object to the logger instance, which is then automatically included in every log entry. This is used to tag logs with their origin (e.g., `{ script: 'popup' }`).
    -   **`debug()`, `info()`, `warn()`, `error()`:**
        -   **Purpose:** Standard logging methods for recording messages at different severity levels. The logger will discard messages below the configured level.
    -   **`measure(label, fn)`:**
        -   **Purpose:** A utility method that wraps a function call, automatically measures its execution time, and logs the result as a performance metric.
-   **Message Schema:** Not applicable.
-   **Coupling & Dependencies:**
    -   **Infrastructure:** Tightly coupled to `config.js` for its settings.
    -   **Chrome APIs:** The optional `StorageTransport` uses `chrome.storage.local.set` to persist logs.

### `src/infrastructure/error-tracker.js`

-   **Architecture Layer:** Infrastructure
-   **State Ownership:**
    -   **In-Memory & Stateful:** The exported singleton `ErrorTracker` instance maintains a `Map` of aggregated error data. It is a stateful service designed to collect and summarize errors over the application's lifecycle.
    -   **Error Deduplication:** It generates a key for each error and, if an error is seen multiple times, it increments a counter instead of creating a new entry.
    -   **LRU Eviction:** The `Map` is used to enforce a maximum number of unique errors, with the least recently used error being evicted when the limit is reached.
-   **Interface Contract:**
    -   **`ErrorCodes` (Exported Constant):**
        -   **Purpose:** Provides a standardized, enumerable list of unique codes for all known error types, ensuring consistency in error tracking across the application.
    -   **`logError(code, message, context = {})`:**
        -   **Purpose:** The primary method for logging and tracking an error. It handles the deduplication and eviction logic.
        -   **Side Effects:** Mutates the internal error `Map`. It also calls `logger.error()`, ensuring every tracked error is also passed to the standard logging system.
    -   **`createError(...)`:**
        -   **Purpose:** A convenience method that both logs an error via `logError()` and returns a new `TrackedError` instance to be thrown or handled.
    -   **Diagnostic Methods (`getErrors`, `exportErrors`, etc.):**
        -   **Purpose:** A suite of methods that provide an API to query the tracker's state, allowing for diagnostics, debugging, and health checks.
-   **Message Schema:** Not applicable.
-   **Coupling & Dependencies:**
    -   **Infrastructure:** Tightly coupled to `config.js` for its settings and `logger.js` for routing all tracked errors to the logging output.

### `src/infrastructure/safe-execute.js`

-   **Architecture Layer:** Infrastructure
-   **State Ownership:**
    -   **In-Memory & Stateful:** This module is stateful due to its maintenance of a global, in-memory `Map` of `CircuitBreaker` instances. Each circuit breaker tracks the failure history for a specific operation and can prevent future executions of that operation to avoid cascading failures.
-   **Interface Contract:**
    -   **`safeExecute(fn, options)`:**
        -   **Purpose:** Provides a simple **Timeout** pattern. Wraps a function in a `Promise.race` against a `setTimeout` to ensure it completes within a specified duration.
    -   **`safeExecuteWithRetry(fn, options)`:**
        -   **Purpose:** Provides a robust set of resilience patterns: **Timeout**, **Retry with Exponential Backoff**, and **Circuit Breaker**. It automatically retries operations that fail with "transient" errors and can "trip" a circuit breaker to fail fast if an operation fails too frequently.
    -   **`safeExecuteAll(functions, options)`:**
        -   **Purpose:** Provides a **Bulkhead** pattern. It executes an array of functions in parallel but wraps each one in its own `safeExecute` call. This ensures that the failure or timeout of one function does not prevent the others in the batch from completing.
    -   **Diagnostic Methods (`getCircuitBreakerStates`, `resetCircuitBreakers`):**
        -   **Purpose:** Provides an API to inspect and reset the state of the circuit breakers, primarily for debugging and testing.
-   **Message Schema:** Not applicable.
-   **Coupling & Dependencies:**
    -   **Infrastructure:** As a high-level infrastructure service, it is tightly coupled to the other infrastructure modules: `config.js` (for default settings like timeouts and retries), `logger.js` (for logging state changes and failures), and `error-tracker.js` (for reporting permanent failures).

### `src/infrastructure/di-container.js`

-   **Architecture Layer:** Infrastructure
-   **Status:** **Unused.** This file defines a Dependency Injection (DI) container, but it is not currently used anywhere in the application. All modules resolve their dependencies via direct ES6 `import` statements. This component represents either legacy code or an aspirational architectural pattern that was not implemented.
-   **State Ownership:**
    -   **In-Memory & Stateful:** The singleton `DIContainer` instance holds maps for service factories, cached singleton instances, and a set for detecting circular dependencies during resolution.
-   **Interface Contract (Intended):**
    -   **`register(name, factory)`:**
        -   **Purpose:** To register a service factory function with the container.
    -   **`resolve(name)`:**
        -   **Purpose:** To get an instance of a service. It was designed to handle lazy initialization, singleton caching, and circular dependency detection.
    -   **`bootstrapServices(container)`:**
        -   **Purpose:** Intended as the single entry point to register all application services. It is currently empty.
-   **Message Schema:** Not applicable.
-   **Coupling & Dependencies:**
    -   **Infrastructure:** Depends only on `logger.js` for internal logging.

### `src/shared/dom-utils.js`

-   **Architecture Layer:** Shared
-   **State Ownership:** Stateless. This module is a collection of pure, exported functions that operate on the DOM elements passed to them.
-   **Interface Contract:**
    -   **Purpose:** Provides a library of low-level, reusable functions for querying and analyzing the DOM. This module is the foundation upon which the more complex selector generators are built.
    -   **Key Responsibilities:**
        -   **Stability Analysis:** A critical function of this module is to determine if parts of the DOM are "stable" or dynamically generated. This includes `isStableId`, `isStableClass`, `isStableValue`, and `isStaticText`. These functions contain the business logic for identifying patterns associated with frameworks like React, MUI, etc.
        -   **Attribute Collection:** Functions like `collectStableAttributes` and `getBestAttribute` provide a prioritized way to find the most reliable attributes on an element for use in selectors.
        -   **DOM Traversal & Analysis:** Helpers like `walkUpTree`, `findBestSemanticAncestor`, and `findNearbyTextElements` provide advanced ways to understand an element's context within the DOM tree.
-   **Message Schema:** Not applicable.
-   **Coupling & Dependencies:**
    -   **DOM:** Heavily coupled to the live DOM, as its purpose is to inspect DOM properties and structure.
    -   **Infrastructure:** Has a one-way dependency on `logger.js` to warn about non-critical errors during DOM inspection without crashing the calling function.
    -   It is a foundational module with **no dependencies** on the `presentation` or `domain` layers.

---

## 3. Sequence of Operations

This section details the step-by-step execution flow for key operations.

### 1. Element Extraction

This sequence describes the flow from a user clicking the "Extract Elements" button to the final report being saved and displayed.

1.  **User Action (in `popup.html`):**
    *   The user clicks the "Extract Elements" button (`#extract-btn`).

2.  **UI Controller (`popup.js`):**
    *   The `click` event listener for `#extract-btn` invokes the `extractElements()` async function.
    *   The UI is updated to a "loading" state.
    *   `chrome.tabs.query({ active: true, currentWindow: true })` is called to get the currently active tab.
    *   `chrome.scripting.executeScript()` is called to ensure `content.js` is injected into the target tab.
    *   A message is sent to the content script in the target tab via `chrome.tabs.sendMessage()` with the payload `{ action: 'extractElements' }`. The script then `await`s a response.

3.  **Content Script (`content.js`):**
    *   The `chrome.runtime.onMessage` listener fires, receiving the message from `popup.js`.
    - It verifies `request.action === 'extractElements'`.
    *   The `extractAllElements()` function is called.
    *   The function gets a flat list of all DOM nodes via `document.querySelectorAll('*')`.
    *   It iterates through this list. For each element:
        *   It calls `extractElementData()`, which wraps the core logic in a `safeExecute` timeout.
        *   Inside the wrapper, `extractElementDataUnsafe()` is called.
        *   `generateBestXPath()` and `generateBestCSS()` (from the Domain Layer) are invoked to create stable selectors for the element.
        *   Visibility, attributes, and other metadata are collected.
    *   Once the iteration is complete, the script assembles a final `data` object containing all the collected element information.
    *   This `data` object is returned to the popup via the `sendResponse` callback.

4.  **UI Controller (`popup.js`):**
    *   The `await` for the `sendMessage` call resolves, providing the `response` object from `content.js`.
    *   The script checks for `response.success === true`.
    *   A new `report` object is created with a unique ID, timestamp, and the data received from the content script.
    *   This report is added to the in-memory `reports` array.
    *   `saveReports()` is called, which writes the entire `reports` array to `chrome.storage.local`.
    *   `displayReports()` is called to re-render the list of saved reports in the UI.
    *   `populateReportSelectors()` is called to update the comparison dropdowns with the new report.
    *   The UI is updated to show a success message.

---

## 4. Complexity Notes

-   **`O(N)` DOM Traversal (`content.js`):** The `extractAllElements` function performs a full DOM scan using `document.querySelectorAll('*')`. This is a linear operation where `N` is the number of elements on the page. On pages with a very large number of nodes, this operation can be slow and may cause the page to become unresponsive during the extraction process. The use of `safeExecute` with a timeout for individual element processing (`extractElementData`) helps prevent a single problematic element from blocking the entire process indefinitely, but it does not mitigate the cost of the main traversal itself.

-   **`O(N + M)` Comparison (`popup.js`):** The `performComparison` function is implemented efficiently. Instead of a nested loop (`O(N*M)`), it converts each report's element list into a `Map` where the selector is the key. It then iterates through the second map (`M` operations) and the first map (`N` operations) to find additions, removals, and modifications. This results in a much more performant `O(N + M)` time complexity.

-   **Redundant Script Injection (`popup.js` & `manifest.json`):**
    -   `manifest.json` declares that `content.js` should be injected into all pages at `document_idle`.
    -   `popup.js` also programmatically injects `content.js` via `chrome.scripting.executeScript` immediately before sending a message.
    -   This creates a logical redundancy. While Chrome may handle this gracefully, it introduces a potential race condition on slow-loading pages where the programmatic injection might complete and receive a message before the declarative injection has finished. The programmatic injection acts as a safeguard to ensure the content script is ready, but it's an important architectural detail to note.

---


UI_Comparison Project Structure
================================

UI_Comparison/
├── .eslintrc.json                # ESLint configuration
├── .gitignore                    # Git ignore file
├── .prettierrc                   # Prettier configuration
├── manifest.json                 # Chrome extension manifest
├── package.json                  # NPM package configuration
├── PROJECT_STRUCTURE.txt         # Project structure documentation
├── SYSTEM_REFERENCE.md           # System reference documentation
├── webpack.config.js             # Webpack configuration
│
├── Images/                       # Extension icons
│   ├── icon16.png               # 16x16 icon
│   ├── icon48.png               # 48x48 icon
│   └── icon128.png              # 128x128 icon
│
├── libs/                         # External libraries
│   ├── DOWNLOAD_XLSX_LIBRARY.txt # Notes on XLSX library
│   └── xlsx.full.min.js         # XLSX library for Excel operations
│
└── src/                          # Source code directory
    │
    ├── application/              # Application layer (currently empty)
    │
    ├── domain/                   # Domain layer
    │   └── selectors/            # Selector generation modules
    │       ├── css-generator.js  # CSS generator for UI comparison
    │       └── xpath-generator.js # XPath generator for element selection
    │
    ├── infrastructure/           # Infrastructure modules
    │   ├── config.js            # Configuration management
    │   ├── di-container.js      # Dependency injection container
    │   ├── error-tracker.js     # Error tracking utilities
    │   ├── logger.js            # Logging utilities
    │   └── safe-execute.js      # Safe execution wrapper
    │
    ├── presentation/             # Presentation layer
    │   ├── content.js            # Content script (runs in page context)
    │   ├── popup.css             # Popup styling
    │   ├── popup.html            # Extension popup HTML
    │   └── popup.js              # Popup script (runs in extension context)
    │
    └── shared/                   # Shared utilities
        └── dom-utils.js          # DOM utility functions

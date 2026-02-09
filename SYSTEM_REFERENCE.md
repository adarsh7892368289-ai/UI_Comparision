# SYSTEM_REFERENCE.md

This document serves as the high-fidelity technical blueprint for the Web Page Element Comparator extension. It details the architecture, control flow, and component contracts of the system.

## 1. High-Level Architecture Overview

The extension follows a standard architecture for browser extensions, partitioned into several distinct layers:

-   **Presentation Layer (`popup.html`, `popup.css`, `popup.js`):** The user-facing interface, responsible for managing user interactions, initiating element extraction, and displaying comparison reports. It acts as the central controller of the application.
-   **Data Extraction Layer (`content.js`):** A content script injected into web pages. Its sole responsibility is to traverse the page's DOM, extract relevant data from each element, and send this data back to the presentation layer.
-   **Domain Logic Layer (`src/domain/**`):** Contains the core business logic of the application. This includes selector generation (`xpath-generator.js`, `css-generator.js`) and the CSS normalization engine (`normalizer-engine.js` and its strategies).
-   **Infrastructure Layer (`src/infrastructure/**`):** Provides cross-cutting concerns and core services like configuration, logging, error tracking, and resilience patterns.
-   **Shared Utilities Layer (`src/shared/**`):** Provides common, reusable functions (`dom-utils.js`) used across different layers.

## 2. Sequence of Operations (Control Flow)

### A. Element Extraction

1.  **User Action:** The user clicks the "Extract Elements" button in `popup.html`.
2.  **Initiation (`popup.js`):** The `extractElements` function is called.
3.  **Messaging (`popup.js`):** A message `{ action: 'extractElements' }` is sent to the active tab's `content.js`.
4.  **Data Collection (`content.js`):**
    -   The `onMessage` listener triggers `extractAllElements()`.
    -   This function iterates through the DOM, calling `extractElementData()` for each element. This core data gathering is wrapped in a `safeExecute` call to prevent timeouts on single elements from halting the entire process.
    -   `extractElementData()` in turn calls `generateBestXPath()` and `generateBestCSS()` to get stable selectors for the element.
5.  **Data Response (`content.js`):** The complete report object is sent back to the popup.
6.  **Report Storage (`popup.js`):** The new report is added to an in-memory `reports` array and persisted to `chrome.storage.local`.
7.  **UI Update (`popup.js`):** The UI is re-rendered to show the new report.

### B. Report Comparison

1.  **User Action:** The user selects two reports and clicks "Compare Reports".
2.  **Initiation (`popup.js`):** The `compareReports` function is called.
3.  **Data Retrieval (`popup.js`):** The two report objects are retrieved from the in-memory `reports` array.
4.  **Comparison Logic (`popup.js`):**
    -   `performComparison` is called.
    -   **Normalization:** It calls `normalizeReport()`, which uses the `NormalizerEngine` to process the CSS styles of every element in both reports. The engine first uses `ShorthandExpander` and then applies other normalizers like `ColorNormalizer` and `UnitNormalizer`.
    -   **Matching & Diffing:** It uses a `Map` to efficiently match elements by XPath and identify added, removed, and modified elements.
5.  **Render Results (`popup.js`):** The results are rendered into the UI.

## 3. Component Deep Dive

---

### `manifest.json`

-   **Architecture Layer:** Configuration / Extension Entry Point Definition

-   **State Ownership:** None. This is a declarative configuration file.

-   **Interface Contract:** This file declares the extension's primary interfaces and capabilities to the browser.
    -   **`action`:** Defines the main user interaction point. Clicking the extension icon loads `popup.html`.
    -   **`content_scripts`:** Configures the automatic injection of `content.js` into all web pages visited by the user (`<all_urls>`). The script is injected at `document_idle` to minimize impact on page load times.
    -   **`permissions`:** Declares the necessary browser APIs:
        -   `activeTab`: Grants temporary access to the active tab when the user invokes the extension.
        -   `storage`: Allows the extension to use the `chrome.storage.local` API for data persistence.
        -   `scripting`: Provides the ability to execute scripts within tabs, a core requirement for programmatic interaction.
    -   **`host_permissions`:** Grants blanket permission (`<all_urls>`) for the content script to be injected into any website.

-   **Message Schema:** Not applicable. This file enables messaging between components but does not define message structures itself.

-   **Coupling & Dependencies:**
    -   **`popup.html`**: Declared as the main action popup. The build process must ensure this file, along with its dependencies (`popup.js`, `popup.css`), is correctly located.
    -   **`content.js`**: Declared as the primary content script. This implies a build process is configured to place the bundled output at the root of the extension package.
    -   **`Images/*.png`**: Declares dependencies on icon files for the browser UI.

---

### `package.json`

-   **Architecture Layer:** Build & Dependency Management

-   **State Ownership:** None. This file is for project metadata and build configuration.

-   **Interface Contract (Scripts):** Defines the command-line interface for managing the project.
    -   `npm run build`: The primary build command. It invokes Webpack to bundle all source files from `src/` into a distributable format in the `dist/` directory.
    -   `npm run setup`: A utility for first-time setup, which installs npm packages and then runs `copy-xlsx`.
    -   `npm run copy-xlsx`: Manually copies the `xlsx` library into the `libs/` directory. This suggests the library might be used in a context where ES6 imports are not available, requiring it to be a standalone file.
    -   `npm run clean`: A housekeeping script to remove `node_modules` and `package-lock.json` for a clean reinstall.

-   **Message Schema:** Not applicable.

-   **Coupling & Dependencies:**
    -   **Runtime Dependencies:**
        -   `xlsx`: A library for creating and parsing spreadsheet files, used for the "Export to Excel" feature.
    -   **Development Dependencies:**
        -   `webpack` / `webpack-cli`: The core of the build system.
        -   `copy-webpack-plugin`: A Webpack plugin used to copy static files (like `.html`, `.css`, and images) from the source directories to the final `dist/` build output.
    -   **Implicit Dependencies:**
        -   `webpack.config.js`: The build process is entirely configured by this file, creating a tight coupling.
        -   `libs/xlsx.full.min.js`: The `copy-xlsx` script's output target, indicating a direct file-path dependency elsewhere in the project.

---

### `webpack.config.js`

-   **Architecture Layer:** Build Tooling.
-   **Purpose:** Configures the Webpack bundler, which transforms the `src/` source code into the final `dist/` directory that is packaged into the browser extension.
-   **Core Configuration:**
    -   **`entry`**: Defines the two JavaScript entry points: `popup.js` and `content.js`. Webpack creates dependency graphs starting from these two files.
    -   **`output`**: Bundles the output into `popup.js` and `content.js` inside the `dist/` folder.
    -   **`plugins` (`CopyPlugin`)**: Copies non-JavaScript assets directly to the `dist/` folder, including `manifest.json`, `.html`, `.css`, images, and the `libs/` directory.
-   **Coupling:** Tightly coupled to the project's file structure and the `package.json` scripts that invoke it.

---

### `src/presentation/popup.js`

-   **Architecture Layer:** Presentation Layer (UI Controller) & Application Logic. It handles all user-facing interactions and orchestrates the core features of the extension.

-   **State Ownership:**
    -   **In-Memory State:**
        -   `reports` (Array): A global array holding the full data for all extracted reports. This serves as the primary in-memory database for the application's lifecycle.
        -   `normalizerEngine` (Object): An instance of `NormalizerEngine`, which contains its own stateful LRU cache for performance.
    -   **Persistent State (`chrome.storage.local`):**
        -   The `reports` array is persisted to `chrome.storage.local` under a key defined in the application config (default: `page_comparator_reports`), ensuring data durability between sessions.

-   **Message Schema:**
    -   **Outgoing (to `content.js`):**
        -   **Action:** `extractElements`
        -   **Payload:** `{ action: 'extractElements' }`
        -   **Purpose:** To command the content script to begin scanning the DOM.
    -   **Incoming (from `content.js`):**
        -   **On Success:** `{ success: true, data: { totalElements: Number, elements: Array<Object> } }`
        -   **On Error:** `{ success: false, error: String }`
        -   **Purpose:** To receive the structured report data or an error message from the content script.

-   **Coupling & Dependencies:**
    -   **`../infrastructure/config.js`**: Strong coupling. Used to retrieve configuration values like storage keys.
    -   **`../infrastructure/logger.js`**: Strong coupling. Used for all event and error logging.
    -   **`../infrastructure/error-tracker.js`**: Strong coupling. Used for logging aggregated errors.
    -   **`../domain/engines/normalizer-engine.js`**: Strong coupling. A key dependency for the comparison logic.
    -   **`content.js`**: Loose coupling via `chrome.tabs.sendMessage`. Expects `content.js` to respond to the defined message schema.
    -   **`popup.html`**: Very tight coupling. The script is directly tied to the HTML structure, referencing many element IDs.
    -   **`libs/xlsx.full.min.js`**: Loose coupling. The `XLSX` global is expected to be available for the `downloadReport` function.
    -   **Chrome APIs**: `chrome.tabs`, `chrome.storage`, `chrome.scripting`.

-   **Interface Contract (Functions):**
    -   **`DOMContentLoaded` Listener**: The script's main entry point. It orchestrates the entire application startup by calling `loadReports`, attaching event listeners to UI controls (`extract-btn`, `compare-btn`), and setting up the initial UI state.
    -   **`extractElements()`**: Orchestrates the element extraction process. It handles UI state changes (e.g., disabling buttons), injects the content script, sends the `extractElements` message, and processes the response. On success, it updates the in-memory `reports` array, calls `saveReports()` to persist it, and updates the UI.
    -   **`loadReports()`**: Loads the report array from `chrome.storage.local` into the in-memory `reports` variable and triggers a UI update by calling `displayReports()`.
    -   **`saveReports()`**: Persists the in-memory `reports` array to `chrome.storage.local`. It also enforces the `maxReports` limit from the configuration, truncating the oldest reports if necessary.
    -   **`displayReports()`**: Renders the list of saved reports into the "Manage Reports" UI. It dynamically creates the HTML and attaches event listeners to the "Download" and "Delete" buttons for each report.
    -   **`downloadReport(reportId)`**: Finds a report by its ID and uses the `XLSX` library to generate and trigger the download of an Excel spreadsheet containing the element data.
    -   **`deleteReport(reportId)`**: Prompts the user for confirmation, then filters the specified report out of the in-memory `reports` array, saves the updated array, and refreshes the UI.
    -   **`populateReportSelectors()`**: Updates the `<select>` dropdowns in the "Comparator" tab with the list of currently available reports.
    -   **`compareReports()`**: Retrieves the two user-selected reports and calls `performComparison` to execute the core diffing logic. It then calls `displayComparisonResults` to render the outcome.
    -   **`performComparison(report1, report2)`**: The core comparison algorithm. It first calls `normalizeReport` on both reports. Then, using a `Map` for efficient lookups (keyed by XPath or CSS selector), it categorizes elements into `added`, `removed`, and `modified` arrays. This has a time complexity of approximately O(N+M).
    -   **`normalizeReport(report)`**: Creates a deep copy of a report where every element's CSS styles have been processed by the `NormalizerEngine`. This canonicalizes the style data for accurate comparison.
    -   **`findElementDifferences(el1, el2)`**: A pure function that compares two element objects and returns an array detailing every mismatched attribute or style property.
    -   **`displayComparisonResults(comparison, report1, report2)`**: Renders the complete comparison result (summary, added/removed/modified lists) into the UI. It performs significant DOM manipulation to display the results.

---

### `src/presentation/content.js`

-   **Architecture Layer:** Data Extraction Layer. This script is programmatically injected into the target web page to scrape DOM element data.

-   **State Ownership:** Stateless. The script holds no state between invocations. It initializes, receives a command, executes, and sends a response.

-   **Message Schema:**
    -   **Incoming (from `popup.js`):**
        -   **Payload:** `{ action: 'extractElements' }`
        -   **Purpose:** A command to begin the DOM extraction process.
    -   **Outgoing (to `popup.js`):**
        -   **On Success:** A response object: `{ success: true, data: ReportObject }`. The `ReportObject` includes the URL, title, timestamp, element count, and an array of all extracted element data.
        -   **On Error:** `{ success: false, error: "Error message" }`.

-   **Coupling & Dependencies:**
    -   **`../domain/selectors/css-generator.js`**: Strong coupling. Called for every element to generate a stable CSS selector.
    -   **`../domain/selectors/xpath-generator.js`**: Strong coupling. Called for every element to generate a robust XPath.
    -   **`../infrastructure/safe-execute.js`**: Strong coupling. This is a critical dependency for resilience. The `extractElementData` function is wrapped in `safeExecute` to apply a timeout, preventing a single problematic element from halting the entire process.
    -   **`../infrastructure/config.js`**, **`logger.js`**, **`error-tracker.js`**: Strong coupling to the infrastructure layer for configuration, logging, and error reporting.
    -   **`popup.js`**: Loose coupling via `chrome.runtime.onMessage`. It depends on the popup to send the initial command.
    -   **DOM & CSSOM APIs**: The script is tightly coupled to browser APIs like `document.querySelectorAll`, `window.getComputedStyle`, and `element.getBoundingClientRect`.

-   **Interface Contract (Functions):**
    -   **`chrome.runtime.onMessage` Listener**: The script's single entry point. It listens for the `extractElements` action and triggers the `extractAllElements` function, returning the result asynchronously via `sendResponse`.
    -   **`extractAllElements()`**: The main orchestration function. It iterates over every element in the DOM (`*`), calls `extractElementData` for each, and compiles the results into a final `ReportObject`.
        -   **Complexity Note:** This operation is O(N) where N is the number of elements on the page. The work done per element is computationally significant.
    -   **`extractElementData(element, index)`**: A resilient wrapper that invokes the core extraction logic (`extractElementDataUnsafe`) inside a `safeExecute` call, protecting it with a configured timeout.
    -   **`extractElementDataUnsafe(element, index)`**: The core data gathering function for a single element. It calls the CSS and XPath generators, reads element properties (`id`, `textContent`, etc.), checks visibility, and extracts computed styles. It returns a structured data object for the element or `null` if the element should be skipped (e.g., invisible or lacks a stable selector).
    -   **`isElementVisible(element)`**: A utility function that checks if an element is visible by inspecting its computed style (`display`, `visibility`, `opacity`) and dimensions.
    -   **`extractComputedStyles(element)`**: Extracts a curated list of relevant CSS properties (e.g., `font-size`, `color`, `padding`) from an element's `window.getComputedStyle` object. This avoids capturing all ~500+ properties, focusing only on those valuable for comparison.

---

### `src/domain/selectors/xpath-generator.js`

-   **Architecture Layer:** Domain Logic (Selector Generation).

-   **State Ownership:** Stateless. The generator holds no state between calls; its output depends solely on the provided element and the current state of the DOM.

-   **Interface Contract:**
    -   **`generateBestXPath(element)`**:
        -   **Signature:** `export function generateBestXPath(element: Element): string | null`
        -   **Purpose:** The sole public function. It orchestrates the entire XPath generation process, wrapping the core logic in a `safeExecute` call to protect against strategy timeouts.
        -   **Input/Output:** Takes a DOM `Element` and returns a single, validated, unique XPath `string`, or `null` if generation fails.

-   **Core Logic & Methodology:**
    -   The generator employs a sophisticated **"tournament" model**, executing over 22 prioritized strategies in a specific order.
    -   It runs through each strategy, generates candidate XPaths, and immediately validates them for uniqueness and correctness using `strictValidate`.
    -   The **first** strategy to produce a valid, unique XPath wins, and its result is returned. This ensures the most robust possible selector is chosen with minimal computation.
    -   A total timeout is enforced to prevent excessive execution time on complex pages.
    -   **Strategy Tiers:** The strategies are tiered by robustness, from most to least reliable:
        -   **High-Tier (e.g., Tiers 1-3):** Focus on explicit markers like `data-testid`, `data-qa`, a stable `id`, or unique, static text.
        -   **Mid-Tier (e.g., Tiers 4-18):** Use contextual information, such as stable attributes on parent or sibling elements, ARIA roles, or combinations of attributes (`strategyMultiAttributeFingerprint`).
        -   **Fallback-Tier (e.g., Tiers 19-22):** Used as a last resort. This includes the `strategyGuaranteedPath`, which generates a full, brittle, index-based path from the document root, guaranteeing a result but at the cost of stability.

-   **Message Schema:** Not applicable.

-   **Coupling & Dependencies:**
    -   **`../../shared/dom-utils.js`**: Very strong coupling. This is the most critical dependency, providing essential functions for DOM analysis like `isStableId`, `isStableClass`, `getBestAttribute`, and `getStableAncestorChain`.
    -   **`../../infrastructure/safe-execute.js`**: Strong coupling. The entry point is wrapped in `safeExecute` to provide timeout protection.
    -   **`../../infrastructure/config.js`**: Used to fetch configuration values for timeouts.
    -   **DOM APIs**: Tightly coupled to browser APIs like `document.evaluate` for XPath validation.

---

### `src/domain/selectors/css-generator.js`

-   **Architecture Layer:** Domain Logic (Selector Generation).

-   **State Ownership:** Stateless. The generator's output is purely dependent on the input element and the current state of the DOM.

-   **Interface Contract:**
    -   **`generateBestCSS(element)`**:
        -   **Signature:** `export function generateBestCSS(element: Element): string | null`
        -   **Purpose:** The sole public function for generating a CSS selector. It wraps the core logic in `safeExecute` to protect against timeouts.
        -   **Input/Output:** Takes a DOM `Element` and returns a single, validated, unique CSS selector `string`, or `null` if generation fails.

-   **Core Logic & Methodology:**
    -   The generator employs a **"cascade" model**, executing 10 strategies in a fixed, prioritized order.
    -   It tries each strategy sequentially. The first strategy that produces a selector passing the `isUnique` validation check wins, and its result is immediately returned.
    -   The `isUnique` function is the core validator, ensuring any candidate selector matches exactly one element on the page, and that it is the correct target element.
    -   **Strategy Cascade Order:** The strategies are ordered from most to least robust:
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

-   **Message Schema:** Not applicable.

-   **Coupling & Dependencies:**
    -   **`../../shared/dom-utils.js`**: Strong coupling. Relies on `isStableId` for ID validation and `walkUpTree` to find stable ancestor elements for contextual selectors.
    -   **`../../infrastructure/safe-execute.js`**: Strong coupling. Used to provide timeout protection for the generation process.
    -   **`../../infrastructure/config.js`**: Fetches configuration values for timeouts.
    -   **DOM APIs**: Tightly coupled to `document.querySelectorAll` and `CSS.escape` for validation and selector construction.

---

### `src/shared/dom-utils.js`

-   **Architecture Layer:** Shared Utilities. This is a foundational, stateless library of pure functions providing low-level DOM interrogation and stability analysis capabilities to the selector generators.

-   **State Ownership:** Stateless. The module exports pure functions that do not maintain any internal state.

-   **Interface Contract (Key Functions):**
    -   **Stability Validators**: This is the module's core responsibility. It contains the business logic for identifying "stable" identifiers using extensive, heuristic-based regex patterns.
        -   `isStableId(id)`: Validates an ID, returning `false` if it appears dynamically generated (e.g., contains UUIDs, is all-numeric, or matches known framework patterns like `ember...` or `lightning-...`).
        -   `isStableClass(className)`: Rejects class names matching patterns from common CSS-in-JS libraries or frameworks (e.g., `Mui...`, `css-...`, `sc-...`).
        -   `isStaticText(text)`: Filters out dynamic text content like timestamps, currency, or loading indicators.

    -   **Attribute Collectors**: These functions prioritize and gather attributes for building selectors.
        -   `collectStableAttributes(element)`: Collects all stable attributes from an element in a prioritized order: test attributes (`data-testid`) first, then other meaningful attributes (`role`, `href`), and finally any other `data-*` attributes.
        -   `getBestAttribute(element)`: A convenience wrapper that returns only the single highest-priority stable attribute for an element.

    -   **DOM Traversal**: These helpers enable safe and intelligent traversal of the DOM tree.
        -   `walkUpTree(element, maxDepth)`: Safely traverses up the DOM from a starting element to a specified maximum depth, returning an array of ancestors.
        -   `getStableAncestorChain(element, maxDepth)`: Finds a chain of parent elements that have stable attributes, which is critical for creating robust, contextual selectors.
        -   `findBestSemanticAncestor(element)`: Locates the nearest parent with a meaningful HTML tag (e.g., `<form>`, `<nav>`) that also possesses a stable attribute.

-   **Message Schema:** Not applicable.

-   **Coupling & Dependencies:**
    -   **`../infrastructure/logger.js`**: Loosely coupled for logging rare errors within `try...catch` blocks.
    -   **Selector Generators**: While this module does not depend on them, `xpath-generator.js` and `css-generator.js` are both critically dependent on this file for their core stability analysis logic.
    -   **DOM APIs**: Tightly coupled to standard browser DOM APIs.

---

### `src/domain/engines/normalizer-engine.js`

-   **Architecture Layer:** Domain Logic (Normalization Engine). This module acts as a **Facade** that orchestrates the complex process of CSS normalization.

-   **State Ownership:**
    -   **In-Memory State**: The engine is stateful.
        -   `_cache` (Map): It maintains an LRU (Least Recently Used) cache that stores the results of property-value normalizations (e.g., mapping `red` to `rgba(255, 0, 0, 1)`). This significantly improves performance on subsequent normalizations of the same style, but is only used when a DOM element context is not required.
        -   It also holds instances of the various normalization strategy classes.

-   **Interface Contract:**
    -   **`normalize(cssObject, element)`**:
        -   **Signature:** `normalize(cssObject: Object, element?: Element): Object`
        -   **Purpose:** The main public method. It takes a raw CSS style object and returns a new object where all values are canonicalized.
        -   **Orchestration Flow:**
            1.  The input object is first passed to `ShorthandExpander` to break down properties like `margin` into their longhand equivalents (`margin-top`, etc.).
            2.  It then iterates through each property of the expanded object and delegates to the appropriate strategy (`ColorNormalizer`, `UnitNormalizer`, `FontNormalizer`) based on the property name.
            3.  The `UnitNormalizer` is the only strategy that requires the optional `element` parameter to resolve relative units (like `em`, `rem`, `%`) into pixels.

-   **Message Schema:** Not applicable.

-   **Coupling & Dependencies:**
    -   **`../strategies/normalization/*.js`**: Has strong, direct dependencies on all normalization strategy modules (`color-normalizer.js`, `unit-normalizer.js`, `shorthand-expander.js`, `font-normalizer.js`), which it instantiates and delegates to.
    -   **`popup.js`**: The `NormalizerEngine` is instantiated and used by `popup.js` to process reports before the comparison logic is run.

---

### Normalization Strategies (`src/domain/strategies/normalization/`)

This directory contains a set of stateless, single-purpose modules, each responsible for normalizing one aspect of CSS. They are orchestrated by the `NormalizerEngine`.

-   **`shorthand-expander.js`**:
    -   **Purpose:** The first step in normalization. It expands CSS shorthand properties into their longhand equivalents for explicit comparison.
    -   **Interface:** `expand(cssObject)` takes a style object and returns a new object with shorthands expanded (e.g., `margin: 10px` becomes `margin-top: 10px`, etc.).
    -   **Dependencies:** None. It is a pure data transformation module.

-   **`color-normalizer.js`**:
    -   **Purpose:** Converts all valid color formats (named, hex, rgb, hsl) into a single, canonical `rgba(r, g, b, a)` string.
    -   **Interface:** `normalize(color)` takes a color string (e.g., `#F00`, `red`) and returns its `rgba()` equivalent.
    -   **State:** It lazy-loads a read-only map of named CSS colors on first use.
    -   **Dependencies:** None.

-   **`unit-normalizer.js`**:
    -   **Purpose:** Converts all CSS length units into a canonical `px` value for consistent numerical comparison.
    -   **Interface:** `normalize(property, value, element)` takes a CSS value and the **live DOM element** to which it applies.
    -   **Dependencies:** This is the only normalizer with a **strong dependency on the live DOM**. It requires the element context to resolve relative units (`em`, `rem`, `%`) and viewport units (`vw`, `vh`) into absolute pixel values.

-   **`font-normalizer.js`**:
    -   **Purpose:** Standardizes `font-family` strings by removing quotes, normalizing spacing, and lower-casing generic family names (`sans-serif`, etc.).
    -   **Interface:** `normalize(value)` takes a `font-family` string and returns the cleaned version.
    -   **Dependencies:** None.

---

### `src/domain/engines/detector-engine.js`

-   **Architecture Layer:** Domain Logic (Detection Engine).
-   **Purpose:** This stateless engine infers the "component type" of a given DOM element using a cascade of heuristics. This is a critical prerequisite for dynamic matching.
-   **Interface:** `detectComponentType(element)` is the main method. It uses the following strategies in order of confidence:
    1.  `data-component` attribute.
    2.  BEM class name patterns (e.g., `block__element`).
    3.  ARIA roles (e.g., `role="dialog"`).
    4.  Semantic HTML tags (e.g., `<nav>`).
    5.  Common class name prefixes (e.g., `card-`).
-   **Coupling:** It is a key dependency for the `DynamicMatcher`.

---

### Matching Engine & Strategies (`src/domain/engines/matcher-engine.js`, etc.)

-   **Architecture Layer:** Domain Logic (Matching).
-   **Purpose:** This system identifies corresponding elements between two different webpage captures. It is orchestrated by the `MatcherEngine`.

-   **`matcher-engine.js` (Facade):**
    -   **Purpose:** Orchestrates the matching process by selecting from different strategies based on a `mode` parameter (`static`, `dynamic`, `hybrid`).
    -   **Interface:** `match(baselineElements, compareElements, options)` is the main entry point that delegates to the appropriate strategy.

-   **`static-matcher.js` (Strategy):**
    -   **Purpose:** The primary, high-confidence strategy that assumes elements have stable identifiers.
    -   **Methodology:** Matches elements using a cascade of techniques: 1) Test IDs (`data-testid`), 2) Stable element IDs, 3) High-quality CSS/XPath selectors.

-   **`dynamic-matcher.js` (Strategy):**
    -   **Purpose:** A specialized strategy for modern, dynamic UIs where element order and attributes may change.
    -   **Methodology:** Uses the `DetectorEngine` to group elements by component type. It then either matches the groups as a whole if their CSS structure is consistent (a "template") or matches elements based on their order within the group.

-   **`position-matcher.js` (Strategy):**
    -   **Purpose:** A low-confidence fallback strategy.
    -   **Methodology:** Matches elements based purely on their spatial proximity (i.e., how many pixels apart they are), used when other strategies fail.

---

### `src/infrastructure/config.js`

-   **Architecture Layer:** Infrastructure. It acts as the centralized, single source of truth for all application settings.

-   **State Ownership:** It manages the application's entire configuration state.
    -   **Immutability:** The module is designed to be **immutable** after initialization. The `init()` method performs a deep freeze on the configuration object, preventing any runtime modifications and ensuring predictable behavior across the application.
    -   **State:**
        -   `_config`: The internal, frozen object holding all configuration values.
        -   `_frozen`: A boolean flag to prevent re-initialization.

-   **Interface Contract:**
    -   **`init(overrides)`**:
        -   **Signature:** `init(overrides?: Object): Config`
        -   **Purpose:** Called once at application startup. It merges hard-coded defaults with any runtime overrides, validates the final structure, and freezes the result to make it read-only. This "fail-fast" approach ensures configuration errors are caught immediately.
    -   **`get(path, fallback)`**:
        -   **Signature:** `get(path: string, fallback?: any): any`
        -   **Purpose:** The primary method used by other modules to consume configuration values. It retrieves a setting using a dot-separated path (e.g., `'selectors.xpath.totalTimeout'`).

-   **Message Schema:** Not applicable.

-   **Coupling & Dependencies:**
    -   This module is foundational and has **zero external dependencies**.
    -   Conversely, nearly every other module in the application (from presentation to domain logic) depends on this file to retrieve settings.

---

### `src/infrastructure/logger.js`

-   **Architecture Layer:** Infrastructure. Provides a centralized, structured logging service for the entire application.

-   **State Ownership:** The logger is stateful.
    -   `context` (Object): A global context object that is automatically merged into every log message, providing consistent metadata.
    -   `StorageTransport.buffer` (Array): The `StorageTransport` maintains an in-memory circular buffer of log entries, which is periodically flushed to `chrome.storage.local`.

-   **Interface Contract:**
    -   **`init()`**: Initializes the logger based on settings from `config.js`. It sets the minimum logging level (e.g., 'info') and configures the output transports.
    -   **Logging Methods (`debug`, `info`, `warn`, `error`)**: The primary interface for logging. They create a structured log entry (with timestamp, level, message, and metadata) and pass it to all configured transports, but only if the message's severity meets the configured level.
    -   **`setContext(context)`**: Sets global metadata (e.g., `{ script: 'popup' }`) to be included in all subsequent logs.
    -   **`measure(label, fn)`**: A high-level utility function that wraps a given function or promise to measure its execution time using `performance.now()`. It automatically logs the result, making it a powerful tool for performance monitoring.

-   **Core Logic & Methodology (Transports):**
    -   The logger uses a **transport** system to define where logs are written.
    -   **`ConsoleTransport`**: Writes formatted logs to the developer console.
    -   **`StorageTransport`**: Writes logs to an in-memory buffer which is then periodically persisted to `chrome.storage.local`, allowing logs to be saved and exported for diagnostics.

-   **Message Schema:** Not applicable.

-   **Coupling & Dependencies:**
    -   **`./config.js`**: Tightly coupled. The logger's level, persistence, and other settings are all driven by the `config` module.
    -   **Chrome APIs**: The `StorageTransport` depends on `chrome.storage.local`.
    -   **Application-wide Dependency**: This module is a dependency for nearly every other module in the application.

---

### `src/infrastructure/error-tracker.js`

-   **Architecture Layer:** Infrastructure. Provides a service for tracking and aggregating application errors, with a key feature of preventing log spam.

-   **State Ownership:** The tracker is stateful.
    -   `errors` (Map): It maintains an in-memory `Map` of unique errors. When a known error reoccurs, its counter is simply incremented instead of creating a new log entry.
    -   **LRU Eviction**: To prevent unbounded memory growth, the `errors` map is capped at a maximum size (from config) and uses an LRU (Least Recently Used) eviction policy.

-   **Interface Contract:**
    -   **`ErrorCodes` (Exported Enum)**: Provides a standardized, exported object of constant error codes (e.g., `EXTRACTION_TIMEOUT`, `STORAGE_WRITE_FAILED`). This ensures a consistent error vocabulary across the application.
    -   **`logError(code, message, context)`**: The primary method for logging a structured error. It performs the core deduplication logic: if the error has been seen before, it increments a counter; otherwise, it creates a new entry. It then calls `logger.error()` to ensure the issue is still captured in the standard logs.
    -   **`createError(code, message, context)`**: A utility that calls `logError` and then returns a new `TrackedError` instance, which can be thrown by the calling code.
    -   **Diagnostic Methods (`getErrors`, `getMostFrequent`, `exportErrors`)**: A suite of public methods that allow other parts of the application to query the aggregated error data for diagnostics and health monitoring.

-   **Message Schema:** Not applicable.

-   **Coupling & Dependencies:**
    -   **`./config.js`**: Tightly coupled for retrieving settings like deduplication behavior and maximum error map size.
    -   **`./logger.js`**: Tightly coupled, as it delegates to the standard logger after processing an error.
    -   **Application-wide Dependency**: Used by any module that needs to report structured, non-fatal errors without spamming the logs.

---

### `src/infrastructure/safe-execute.js`

-   **Architecture Layer:** Infrastructure. Provides a suite of high-level functions that wrap asynchronous operations to make them resilient against common failures.

-   **State Ownership:** The module is stateful.
    -   `circuitBreakers` (Map): It manages a global, in-memory collection of `CircuitBreaker` instances. Each breaker tracks the failure rate of a specific, named operation (e.g., 'xpath-generation'), forming the basis of the Circuit Breaker pattern.

-   **Interface Contract & Resilience Patterns:**
    -   **`safeExecute(fn, options)` - Timeout Pattern**:
        -   Runs an async function but races it against a `setTimeout`. If the function does not complete within the configured timeout, it is abandoned and a fallback value is returned.
        -   **Purpose:** To prevent a single, slow operation (like processing one difficult DOM element) from halting an entire batch process.

    -   **`safeExecuteWithRetry(fn, options)` - Retry & Circuit Breaker Pattern**:
        -   This is a more advanced wrapper that combines three patterns:
            1.  **Timeout**: The same timeout logic as `safeExecute`.
            2.  **Retry with Exponential Backoff**: If the operation fails with a *transient* error (e.g., a timeout), it automatically waits for a short, increasing delay and retries the operation several times before failing permanently.
            3.  **Circuit Breaker**: Before executing, it checks a global `CircuitBreaker` for that operation. If the operation has failed too frequently, the breaker is "tripped" (put in an `OPEN` state), and all subsequent calls fail immediately without attempting to run. This prevents the application from wasting resources on a service or function that is known to be unhealthy.

    -   **`safeExecuteAll(functions, options)` - Bulkhead Pattern**:
        -   Takes an array of functions and runs them all in parallel. Each function is individually wrapped in `safeExecute`, isolating it from the others.
        -   **Purpose:** Ensures that the failure or timeout of one function in a batch does not affect the execution or completion of the others.

-   **Message Schema:** Not applicable.

-   **Coupling & Dependencies:**
    -   **`./config.js`**, **`./logger.js`**, **`./error-tracker.js`**: Tightly coupled to the rest of the infrastructure layer for configuration, detailed logging of its state (retries, circuit breaker trips), and error reporting.
    -   **Application-wide Dependency**: A key dependency for any module performing potentially unreliable operations, such as `content.js` and the selector generators.

---

### `src/infrastructure/di-container.js`

-   **Architecture Layer:** Infrastructure
-   **Status:** **Unused.** While present, this DI container is not integrated into the application. All modules resolve their dependencies via direct ES6 `import` statements. This component may be legacy code or an unfulfilled architectural goal.

# System Reference

This document serves as a high-fidelity technical blueprint of the UI Comparison project.

## Critical Issues

*   **Missing Dependency:** The file `src/helpers/common-utils.js` is imported by both `src/domain/selectors/css-generator.js` and `src/domain/selectors/xpath-generator.js`, but it does not exist in the project structure. This is a fatal error that will prevent the core functionality of the extension (element extraction) from working.

## Sequence of Operations

## Sequence of Operations

1.  **User opens the extension popup:** `popup.html` is displayed.
2.  **`popup.js` initializes:**
    *   It loads any previously saved reports from `chrome.storage.local`.
    *   It queries the current tab's URL and displays it.
    *   It sets up event listeners for the "Extract Elements" and "Compare Reports" buttons, as well as the tab switching functionality.
3.  **User clicks "Extract Elements":**
    *   The `extractElements` function is called.
    *   A message `{ action: 'extractElements' }` is sent to the content script (`content.js`) running on the active tab.
    *   The content script traverses the DOM, gathers element data, and sends it back to `popup.js`.
    *   A new report is created, assigned a timestamp, and saved to `chrome.storage.local`.
    *   The UI is updated to display the new report.
4.  **User clicks "Compare Reports":**
    *   The `compareReports` function is called.
    *   It retrieves the two selected reports from the in-memory `reports` array.
    *   The `performComparison` function is called to identify added, removed, and modified elements based on their XPath.
    *   The `displayComparisonResults` function renders the comparison summary and differences in the UI.

## File-by-File Analysis

### `manifest.json`

*   **Architecture Layer:** Configuration
*   **State Ownership:** None. This file is purely declarative.
*   **Interface Contract:** None. It defines the extension's properties and capabilities.
*   **Message Schema:** None.
*   **Coupling & Dependencies:**
    *   `popup.html`: Declares the main UI for the extension's action.
    *   `content.js`: Declares the content script to be injected into web pages.
    *   `Images/icon16.png`, `Images/icon48.png`, `Images/icon128.png`: Declares the icons for the extension.
    *   **Permissions**:
        *   `activeTab`: Allows the extension to interact with the currently active tab.
        *   `storage`: Allows the extension to use `chrome.storage`.
        *   `scripting`: Allows the extension to execute scripts in the context of web pages.
    *   **Host Permissions**:
        *   `<all_urls>`: Allows the content script to run on all URLs.

### `src/presentation/popup.html`

*   **Architecture Layer:** UI
*   **State Ownership:** None. This file defines the static structure of the popup.
*   **Interface Contract:** This file defines the user interface for the extension. It includes:
    *   **Tabs:** "Extract Elements" and "Compare Reports".
    *   **Buttons:** "Extract Elements" and "Compare Reports".
    *   **Inputs:** A text input for the page URL (readonly), and two dropdowns to select reports for comparison.
    *   **Containers:**  `extract-status`, `reports-container`, `compare-status`, and `comparison-results` to display dynamic content.
*   **Message Schema:** None.
*   **Coupling & Dependencies:**
    *   `styles/popup.css`: Defines the styling for the popup.
    *   `libs/xlsx.full.min.js`: Includes the xlsx library for spreadsheet operations.
    *   `popup.js`: Contains the logic for the popup UI.

### `src/presentation/popup.js`

*   **Architecture Layer:** UI Logic, State Management
*   **State Ownership:**
    *   `reports` (in-memory): An array of report objects loaded from and saved to `chrome.storage.local`.
    *   `chrome.storage.local`: Persists the `reports` array.
*   **Interface Contract:**
    *   `loadCurrentPageUrl()`:
        *   **Signature:** `async function loadCurrentPageUrl()`
        *   **Purpose:** Gets the URL of the active tab and displays it in the `page-url` input field.
        *   **Input/Output:** None.
        *   **Side Effects:** Modifies the DOM.
    *   `setupTabs()`:
        *   **Signature:** `function setupTabs()`
        *   **Purpose:** Sets up the tab switching functionality.
        *   **Input/Output:** None.
        *   **Side Effects:** Modifies the DOM.
    *   `extractElements()`:
        *   **Signature:** `async function extractElements()`
        *   **Purpose:** Initiates the element extraction process.
        *   **Input/Output:** None.
        *   **Side Effects:** Modifies the DOM, sends a message to the content script, and saves a new report to `chrome.storage.local`.
    *   `loadReports()`:
        *   **Signature:** `async function loadReports()`
        *   **Purpose:** Loads reports from `chrome.storage.local` into the in-memory `reports` array.
        *   **Input/Output:** None.
        *   **Side Effects:** Modifies the in-memory `reports` array and the DOM.
    *   `saveReports()`:
        *   **Signature:** `async function saveReports()`
        *   **Purpose:** Saves the in-memory `reports` array to `chrome.storage.local`.
        *   **Input/Output:** None.
        *   **Side Effects:** Writes to `chrome.storage.local`.
    *   `displayReports()`:
        *   **Signature:** `function displayReports()`
        *   **Purpose:** Renders the list of saved reports in the UI.
        *   **Input/Output:** None.
        *   **Side Effects:** Modifies the DOM.
    *   `downloadReport(reportId)`:
        *   **Signature:** `function downloadReport(reportId)`
        *   **Purpose:** Downloads a report as an Excel file.
        *   **Input/Output:** `reportId` (string).
        *   **Side Effects:** Triggers a file download.
    *   `deleteReport(reportId)`:
        *   **Signature:** `async function deleteReport(reportId)`
        *   **Purpose:** Deletes a report from the in-memory `reports` array and `chrome.storage.local`.
        *   **Input/Output:** `reportId` (string).
        *   **Side Effects:** Modifies the in-memory `reports` array, writes to `chrome.storage.local`, and modifies the DOM.
    *   `populateReportSelectors()`:
        *   **Signature:** `function populateReportSelectors()`
        *   **Purpose:** Populates the report selection dropdowns.
        *   **Input/Output:** None.
        *   **Side Effects:** Modifies the DOM.
    *   `compareReports()`:
        *   **Signature:** `function compareReports()`
        *   **Purpose:** Initiates the report comparison process.
        *   **Input/Output:** None.
        *   **Side Effects:** Modifies the DOM.
    *   `performComparison(report1, report2)`:
        *   **Signature:** `function performComparison(report1, report2)`
        *   **Purpose:** Compares two reports and identifies differences.
        *   **Input/Output:** `report1` (object), `report2` (object). Returns an object with `added`, `removed`, and `modified` arrays.
        *   **Side Effects:** None.
    *   `findElementDifferences(el1, el2)`:
        *   **Signature:** `function findElementDifferences(el1, el2)`
        *   **Purpose:** Compares two element objects and identifies differences.
        *   **Input/Output:** `el1` (object), `el2` (object). Returns an array of difference objects.
        *   **Side Effects:** None.
    *   `displayComparisonResults(comparison, report1, report2)`:
        *   **Signature:** `function displayComparisonResults(comparison, report1, report2)`
        *   **Purpose:** Renders the comparison results in the UI.
        *   **Input/Output:** `comparison` (object), `report1` (object), `report2` (object).
        *   **Side Effects:** Modifies the DOM.
*   **Message Schema:**
    *   **Sent to `content.js`:** `{ action: 'extractElements' }`
*   **Coupling & Dependencies:**
    *   `chrome.tabs`: To query for the active tab.
    *   `chrome.scripting`: To execute the content script.
    *   `chrome.storage`: To persist reports.
    *   `chrome.runtime`: To send messages to the content script.
    *   `content.js`: Expects `content.js` to be available to respond to the `extractElements` message.
    *   `libs/xlsx.full.min.js`: For downloading reports as Excel files.

### `src/presentation/content.js`

*   **Architecture Layer:** Data Extraction
*   **State Ownership:** None. This script is stateless and executes on demand.
*   **Interface Contract:**
    *   **Listens for Messages:**
        *   `{ action: 'extractElements' }`: Triggers the element extraction process.
        *   `{ action: 'ping' }`: Responds with `{ success: true }` to indicate the script is loaded.
    *   `extractAllElements()`:
        *   **Signature:** `function extractAllElements()`
        *   **Purpose:** Traverses the entire DOM, extracts data from each element, and returns a comprehensive report object.
        *   **Input/Output:** None. Returns a report object containing the URL, title, timestamp, total number of elements, and an array of element data.
        *   **Side Effects:** Reads from the DOM.
*   **Message Schema:**
    *   **Received from `popup.js`:** `{ action: 'extractElements' }`
    *   **Sent to `popup.js` (Success):** `{ success: true, data: <reportObject> }`
    *   **Sent to `popup.js` (Error):** `{ success: false, error: <errorMessage> }`
*   **Coupling & Dependencies:**
    *   `../domain/selectors/css-generator.js`: To generate CSS selectors for elements.
    *   `../domain/selectors/xpath-generator.js`: To generate XPath selectors for elements.
    *   `chrome.runtime`: To listen for and respond to messages from `popup.js`.
    *   **DOM:** Heavily coupled to the structure and properties of the web page it's running on.

### `src/domain/selectors/css-generator.js`

*   **Architecture Layer:** Domain Logic (Selector Generation)
*   **State Ownership:** None. This is a pure utility module with no internal state.
*   **Interface Contract:**
    *   `generateBestCSS(element)`:
        *   **Signature:** `function generateBestCSS(element)`
        *   **Purpose:** To generate the most stable and unique CSS selector for a given DOM element by trying a cascade of 10 different strategies.
        *   **Input/Output:** `element` (DOM element). Returns a string containing the best CSS selector, or `null` if no unique selector can be found.
        *   **Side Effects:** Reads from the DOM to validate selector uniqueness.
*   **Message Schema:** None.
*   **Coupling & Dependencies:**
    *   `../../helpers/common-utils.js`: Imports utility functions `isStableId` and `walkUpTree`.
    *   **DOM:** Interacts heavily with the DOM to check for selector uniqueness using `document.querySelectorAll`.

### `src/domain/selectors/xpath-generator.js`

*   **Architecture Layer:** Domain Logic (Selector Generation)
*   **State Ownership:** None. This is a pure utility module with no internal state.
*   **Interface Contract:**
    *   `generateBestXPath(element)`:
        *   **Signature:** `function generateBestXPath(element)`
        *   **Purpose:** To generate the most stable and unique XPath for a given DOM element by running a "tournament" of 22 different strategies in a prioritized order.
        *   **Input/Output:** `element` (DOM element). Returns a string containing the best XPath selector, or `null` if no unique selector can be found within a 100ms timeout.
        *   **Side Effects:** Reads from the DOM extensively to validate XPath uniqueness and correctness.
*   **Message Schema:** None.
*   **Coupling & Dependencies:**
    *   `../../helpers/common-utils.js`: Imports a large number of utility functions for attribute and text analysis.
    *   **DOM:** Interacts heavily with the DOM to evaluate XPath expressions (`document.evaluate`) and analyze element properties.

### `src/styles/popup.css`

*   **Architecture Layer:** UI (Styling)
*   **State Ownership:** None. This is a static asset.
*   **Interface Contract:** None. This file provides styling for the `popup.html` UI.
*   **Message Schema:** None.
*   **Coupling & Dependencies:**
    *   `popup.html`: This stylesheet is directly referenced by `popup.html` and provides all the visual styling for the extension's user interface.

## Complexity Notes

*   **`extractAllElements()` in `src/presentation/content.js`:** This function uses `document.querySelectorAll('*')` to select every element on the page. It then iterates over this collection. This is an O(n) operation where 'n' is the number of DOM elements. For very large and complex pages, this could lead to performance issues and a noticeable delay in the UI.
*   **`performComparison()` in `src/presentation/popup.js`:** This function uses `Map` for efficient lookups (O(1) on average), which is good. However, it still involves multiple iterations over the element lists, making the overall complexity roughly O(n + m), where 'n' and 'm' are the number of elements in each report. This should be acceptable for most use cases.
*   **`generateBestXPath()` in `src/domain/selectors/xpath-generator.js`:** This function is highly complex, employing a 22-tier "tournament" of strategies. Each strategy may involve DOM traversal and evaluation. The function has a built-in 100ms timeout to prevent excessive blocking, but it still represents a significant computational cost for each element processed by `extractAllElements()`. The total time for an extraction is `O(n * k)` where `n` is the number of elements and `k` is the average time per element for XPath generation. This is the most computationally intensive part of the application.
/**
 * Promise wrappers around Chrome's tab, scripting, and navigation APIs.
 * Runs in the MV3 service worker only.
 * Failure mode contained here: divergent error contracts — all methods return a
 * zero-value (null / []) on failure except executeScript, which rethrows so callers
 * can distinguish an injection error from a legitimately empty result.
 * Callers: compare-workflow.js, visual-workflow.js, chrome-messaging.js.
 */
import logger from './logger.js';

/**
 * Chrome tab API helpers. Does not maintain any tab state — each method is stateless.
 * Invariant: a null or [] return always means the Chrome API call failed; it is never
 * a legitimate empty result (check logs for details).
 */
export const TabAdapter = {

  /**
   * Returns the currently focused tab in the current window.
   * Scoped to `currentWindow` — will not return a tab from a different Chrome window
   * even if it was the last one the user interacted with.
   * @returns {Promise<chrome.tabs.Tab|null>} Null on error or if no active tab exists.
   */
  async getActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    } catch (error) {
      logger.error('Failed to get active tab', { error: error.message });
      return null;
    }
  },

  /**
   * Opens a new tab and resolves once the page finishes loading (`status === 'complete'`).
   * The resolved value is the tab snapshot from `tabs.create`, not the post-load state.
   * Call `TabAdapter.get(tab.id)` afterwards if you need updated tab properties.
   *
   * Known race: if the page reaches 'complete' before the `onUpdated` listener is
   * registered (e.g. chrome://newtab loads instantly), the event is missed and the
   * promise hangs until `timeoutMs`. This is a Chrome API limitation with no clean fix.
   *
   * @param {string} url
   * @param {boolean} [active=false] - False by default so comparison tabs do not
   *   steal focus from the popup that is controlling the workflow.
   * @param {number} [timeoutMs=30000]
   * @returns {Promise<chrome.tabs.Tab>}
   */
  async createTab(url, active = false, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      let listener;
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Tab creation timeout'));
      }, timeoutMs);

      chrome.tabs.create({ url, active }, (tab) => {
        if (chrome.runtime.lastError) {
          clearTimeout(timeout);
          return reject(new Error(chrome.runtime.lastError.message));
        }

        listener = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve(tab);
          }
        };

        chrome.tabs.onUpdated.addListener(listener);
      });
    });
  },

  /**
   * Closes a tab by ID. Errors are logged and swallowed — do not use the return
   * value as a cleanup gate because the tab may still be open if the call fails.
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async removeTab(tabId) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (error) {
      logger.warn('Failed to remove tab', { tabId, error: error.message });
    }
  },

  /**
   * Injects script files into a tab and returns the injection results.
   * Unlike every other method on this object, this rethrows on failure —
   * an empty results array and an injection error are otherwise indistinguishable.
   *
   * @param {number} tabId
   * @param {string[]} files - Extension-relative paths to the scripts to inject.
   * @returns {Promise<chrome.scripting.InjectionResult[]>}
   * @throws {Error} If injection fails, e.g. due to a missing host permission.
   */
  async executeScript(tabId, files) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        files
      });
      return results;
    } catch (error) {
      logger.error('Script execution failed', { tabId, files, error: error.message });
      throw error;
    }
  },

  /**
   * Sends a message to a content script in a tab and waits for a reply.
   * The synchronous `try/catch` around `chrome.tabs.sendMessage` is intentional —
   * Chrome throws synchronously (not via `lastError`) when the content script is not
   * yet injected, so both paths must be handled.
   *
   * @param {number} tabId
   * @param {Object} message
   * @param {number} [timeoutMs=60000]
   * @returns {Promise<*>} Rejects on timeout, `lastError`, or a synchronous throw.
   */
  async sendMessage(tabId, message, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Tab message timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          clearTimeout(timer);

          if (chrome.runtime.lastError) {
            const errorMsg = chrome.runtime.lastError.message || 'Tab message failed';
            return reject(new Error(errorMsg));
          }

          resolve(response);
        });
      } catch (error) {
        clearTimeout(timer);
        const errorMsg = error.message || String(error);
        reject(new Error(`Failed to send message to tab ${tabId}: ${errorMsg}`));
      }
    });
  },

  /**
   * Returns all tabs matching the given query criteria.
   * @param {chrome.tabs.QueryInfo} queryInfo
   * @returns {Promise<chrome.tabs.Tab[]>} Empty array on error.
   */
  async query(queryInfo) {
    try {
      return await chrome.tabs.query(queryInfo);
    } catch (error) {
      logger.error('Tab query failed', { queryInfo, error: error.message });
      return [];
    }
  },

  /**
   * Returns a single tab by ID.
   * @param {number} tabId
   * @returns {Promise<chrome.tabs.Tab|null>} Null if the tab no longer exists or on error.
   */
  async get(tabId) {
    try {
      return await chrome.tabs.get(tabId);
    } catch (error) {
      logger.warn('Failed to get tab', { tabId, error: error.message });
      return null;
    }
  },

  /**
   * Returns all frames in a tab, including iframes. Used to target specific
   * frames for CDP commands during visual capture.
   * @param {number} tabId
   * @returns {Promise<chrome.webNavigation.GetAllFramesCallbackDetails[]>}
   *   Empty array if the tab has no frames or on error.
   */
  async getFrames(tabId) {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return frames ?? [];
    } catch (error) {
      logger.warn('Failed to get frames', { tabId, error: error.message });
      return [];
    }
  }
};
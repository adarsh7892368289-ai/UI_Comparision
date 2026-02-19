/**
 * WEEK 7: Chrome Tabs Adapter
 * 
 * Ports & Adapters pattern - all chrome.tabs.* calls isolated here.
 * Application layer imports this adapter, never chrome APIs directly.
 * 
 * Benefits:
 * - Single source of truth for tab operations
 * - Consistent error handling and timeouts
 * - Mockable for testing (application layer can inject mock adapter)
 * - Graceful degradation if APIs are unavailable
 */

import logger from './logger.js';

export const TabAdapter = {
  /**
   * Get the currently active tab in the current window.
   * @returns {Promise<chrome.tabs.Tab | null>}
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
   * Create a new tab and wait for it to finish loading.
   * @param {string} url 
   * @param {boolean} active 
   * @param {number} timeoutMs 
   * @returns {Promise<chrome.tabs.Tab>}
   */
  async createTab(url, active = false, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Tab creation timeout'));
      }, timeoutMs);

      chrome.tabs.create({ url, active }, (tab) => {
        if (chrome.runtime.lastError) {
          clearTimeout(timeout);
          return reject(new Error(chrome.runtime.lastError.message));
        }

        const listener = (tabId, changeInfo) => {
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
   * Remove a tab by ID.
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
   * Execute script files in a tab.
   * @param {number} tabId 
   * @param {string[]} files 
   * @returns {Promise<any[]>}
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
   * Send a message to a tab and wait for response with timeout.
   * @param {number} tabId 
   * @param {object} message 
   * @param {number} timeoutMs 
   * @returns {Promise<any>}
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
   * Query tabs matching criteria.
   * @param {chrome.tabs.QueryInfo} queryInfo 
   * @returns {Promise<chrome.tabs.Tab[]>}
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
   * Get a tab by ID.
   * @param {number} tabId 
   * @returns {Promise<chrome.tabs.Tab | null>}
   */
  async get(tabId) {
    try {
      return await chrome.tabs.get(tabId);
    } catch (error) {
      logger.warn('Failed to get tab', { tabId, error: error.message });
      return null;
    }
  }
};
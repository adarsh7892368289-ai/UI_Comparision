import { get } from '../config/defaults.js';
import { errorTracker, ERROR_CODES } from './error-tracker.js';
import logger from './logger.js';

const DB_NAME            = 'ui_comparison_db';
const DB_VERSION         = 4;
const STORE_REPORTS      = 'reports';
const STORE_ELEMENTS     = 'elements';
const STORE_COMPARISONS  = 'comparisons';
const STORE_COMP_DIFFS   = 'comparison_diffs';
const STORE_COMP_SUMMARY = 'comparison_summary';
const STORE_VISUAL_BLOBS = 'visual_blobs';
const STORE_OP_LOG       = 'operation_log';
const MAX_COMPARISONS    = 20;
const OP_STATUS_PENDING  = 'PENDING';
const OP_STATUS_COMPLETE = 'COMPLETE';

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

function transactionToPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

function buildPairKey(baselineId, compareId, mode) {
  return `${baselineId}_${compareId}_${mode}`;
}

function trackError(code, message, context = {}) {
  errorTracker.track({ code, message, context });
}

function runUpgrade(db, oldVersion) {
  if (oldVersion < 1) {
    const reportStore = db.createObjectStore(STORE_REPORTS, { keyPath: 'id' });
    reportStore.createIndex('by_timestamp', 'timestamp',          { unique: false });
    reportStore.createIndex('by_url',       'url',                { unique: false });
    reportStore.createIndex('by_url_ts',    ['url', 'timestamp'], { unique: false });
    db.createObjectStore(STORE_ELEMENTS, { keyPath: 'reportId' });
  }

  if (oldVersion < 2) {
    const compStore = db.createObjectStore(STORE_COMPARISONS, { keyPath: 'id' });
    compStore.createIndex('by_pair',      'pairKey',    { unique: true  });
    compStore.createIndex('by_timestamp', 'timestamp',  { unique: false });
    compStore.createIndex('by_baseline',  'baselineId', { unique: false });
    compStore.createIndex('by_compare',   'compareId',  { unique: false });
    db.createObjectStore(STORE_COMP_DIFFS, { keyPath: 'comparisonId' });
  }

  if (oldVersion < 4) {
    const summaryStore = db.createObjectStore(STORE_COMP_SUMMARY, { keyPath: 'comparisonId' });
    summaryStore.createIndex('by_timestamp', 'timestamp', { unique: false });

    const blobStore = db.createObjectStore(STORE_VISUAL_BLOBS, { keyPath: 'key' });
    blobStore.createIndex('by_comparisonId', 'comparisonId', { unique: false });
    blobStore.createIndex('by_timestamp',    'timestamp',    { unique: false });

    const logStore = db.createObjectStore(STORE_OP_LOG, { keyPath: 'id' });
    logStore.createIndex('by_status',    'status',    { unique: false });
    logStore.createIndex('by_timestamp', 'timestamp', { unique: false });
  }
}

class IDBRepository {
  #db;
  #opening;
  #writeQueue;

  constructor() {
    this.#db = null;
    this.#opening = null;
    this.#writeQueue = Promise.resolve();
  }

  #enqueue(fn) {
    const result = this.#writeQueue.then(fn);
    this.#writeQueue = result.catch(() => {});
    return result;
  }

  #getDB() {
    if (this.#db) {
      return Promise.resolve(this.#db);
    }
    if (this.#opening) {
      return this.#opening;
    }

    this.#opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        runUpgrade(event.target.result, event.oldVersion);
      };

      request.onsuccess = (event) => {
        const db = event.target.result;

        db.onversionchange = () => {
          db.close();
          this.#db = null;
        };

        db.onerror = (dbEvent) => {
          trackError(ERROR_CODES.STORAGE_READ_FAILED, dbEvent.target.error?.message ?? 'IDB error');
        };

        this.#db = db;
        this.#opening = null;
        resolve(db);
      };

      request.onerror = (event) => {
        this.#opening = null;
        reject(new Error(`IDB open failed: ${event.target.error?.message}`));
      };

      request.onblocked = () => {
        this.#opening = null;
        reject(new Error('IDB open blocked — close other extension tabs and retry'));
      };
    });

    return this.#opening;
  }

  saveReport(report) {
    return this.#enqueue(() => this.#saveReportInner(report));
  }

  async #saveReportInner(report) {
    const maxReports = get('storage.maxReports');
    const { elements, ...meta } = report;

    try {
      const db = await this.#getDB();

      await new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_REPORTS, STORE_ELEMENTS], 'readwrite');
        const reportStore  = tx.objectStore(STORE_REPORTS);
        const elementStore = tx.objectStore(STORE_ELEMENTS);

        transactionToPromise(tx).then(resolve).catch(reject);

        const countReq = reportStore.count();
        countReq.onsuccess = () => {
          const excess = countReq.result - maxReports + 1;
          if (excess <= 0) {
            reportStore.put(meta);
            if (elements?.length) {
              elementStore.put({ reportId: report.id, data: elements });
            }
            return;
          }

          const cursorReq = reportStore.index('by_timestamp').openCursor(null, 'next');
          let deleted = 0;

          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor && deleted < excess) {
              reportStore.delete(cursor.primaryKey);
              elementStore.delete(cursor.primaryKey);
              deleted++;
              cursor.continue();
            } else {
              reportStore.put(meta);
              if (elements?.length) {
                elementStore.put({ reportId: report.id, data: elements });
              }
            }
          };

          cursorReq.onerror = () => tx.abort();
        };

        countReq.onerror = () => tx.abort();
      });

      return { success: true, id: report.id };
    } catch (error) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, error.message, { id: report.id });
      return { success: false, error: error.message };
    }
  }

  async loadReports() {
    try {
      const db = await this.#getDB();
      const tx = db.transaction(STORE_REPORTS, 'readonly');
      const all = await requestToPromise(tx.objectStore(STORE_REPORTS).getAll());
      return (all ?? []).sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
    } catch (error) {
      trackError(ERROR_CODES.STORAGE_READ_FAILED, error.message);
      return [];
    }
  }

  async loadReportElements(reportId) {
    try {
      const db = await this.#getDB();
      const tx = db.transaction(STORE_ELEMENTS, 'readonly');
      const record = await requestToPromise(tx.objectStore(STORE_ELEMENTS).get(reportId));
      return record?.data ?? [];
    } catch (error) {
      trackError(ERROR_CODES.STORAGE_READ_FAILED, error.message, { reportId });
      return [];
    }
  }

  deleteReport(id) {
    return this.#enqueue(() => this.#deleteReportInner(id));
  }

  async #deleteReportInner(id) {
    try {
      const db = await this.#getDB();
      const compIdsToDelete = await this.#getComparisonIdsByReportId(db, id);

      const stores = [STORE_REPORTS, STORE_ELEMENTS, STORE_COMPARISONS, STORE_COMP_DIFFS, STORE_COMP_SUMMARY];
      const tx = db.transaction(stores, 'readwrite');

      tx.objectStore(STORE_REPORTS).delete(id);
      tx.objectStore(STORE_ELEMENTS).delete(id);

      for (const compId of compIdsToDelete) {
        tx.objectStore(STORE_COMPARISONS).delete(compId);
        tx.objectStore(STORE_COMP_DIFFS).delete(compId);
        tx.objectStore(STORE_COMP_SUMMARY).delete(compId);
      }

      await transactionToPromise(tx);
      return { success: true };
    } catch (error) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, error.message, { id });
      return { success: false, error: error.message };
    }
  }

  async #getComparisonIdsByReportId(db, reportId) {
    try {
      const tx = db.transaction(STORE_COMPARISONS, 'readonly');
      const store = tx.objectStore(STORE_COMPARISONS);
      const range = IDBKeyRange.only(reportId);

      const [baselineKeys, compareKeys] = await Promise.all([
        requestToPromise(store.index('by_baseline').getAllKeys(range)),
        requestToPromise(store.index('by_compare').getAllKeys(range))
      ]);

      return [...new Set([...(baselineKeys ?? []), ...(compareKeys ?? [])])];
    } catch {
      return [];
    }
  }

  deleteAllReports() {
    return this.#enqueue(() => this.#deleteAllInner());
  }

  async #deleteAllInner() {
    try {
      const db = await this.#getDB();
      const stores = [STORE_REPORTS, STORE_ELEMENTS, STORE_COMPARISONS, STORE_COMP_DIFFS, STORE_COMP_SUMMARY, STORE_VISUAL_BLOBS];
      const tx = db.transaction(stores, 'readwrite');

      for (const storeName of stores) {
        tx.objectStore(storeName).clear();
      }

      await transactionToPromise(tx);
      return { success: true };
    } catch (error) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, error.message);
      return { success: false, error: error.message };
    }
  }

  saveComparison(meta, slimResults) {
    return this.#enqueue(() => this.#saveComparisonInner(meta, slimResults));
  }

  async #saveComparisonInner(meta, slimResults) {
    const logId = crypto.randomUUID();
    try {
      const db = await this.#getDB();

      await this.#writeWalEntry(db, logId, 'SAVE_COMPARISON', { comparisonId: meta.id });

      await new Promise((resolve, reject) => {
        const stores = [STORE_COMPARISONS, STORE_COMP_DIFFS, STORE_COMP_SUMMARY];
        const tx = db.transaction(stores, 'readwrite');
        const compStore    = tx.objectStore(STORE_COMPARISONS);
        const diffStore    = tx.objectStore(STORE_COMP_DIFFS);
        const summaryStore = tx.objectStore(STORE_COMP_SUMMARY);

        transactionToPromise(tx).then(resolve).catch(reject);

        const pairReq = compStore.index('by_pair').get(meta.pairKey);

        pairReq.onsuccess = () => {
          const existing = pairReq.result;
          if (existing) {
            compStore.delete(existing.id);
            diffStore.delete(existing.id);
            summaryStore.delete(existing.id);
          }
          this.#evictAndWrite(compStore, diffStore, summaryStore, meta, slimResults);
        };

        pairReq.onerror = () => tx.abort();
      });

      await this.#completeWalEntry(db, logId);
      return { success: true, id: meta.id };
    } catch (error) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, error.message);
      return { success: false, error: error.message };
    }
  }

  #evictAndWrite(compStore, diffStore, summaryStore, meta, slimResults) {
    const writeAll = () => {
      compStore.put(meta);
      diffStore.put({ comparisonId: meta.id, results: slimResults });
      summaryStore.put({ comparisonId: meta.id, timestamp: meta.timestamp, pairKey: meta.pairKey });
    };

    const countReq = compStore.count();
    countReq.onsuccess = () => {
      if (countReq.result < MAX_COMPARISONS) {
        writeAll();
        return;
      }
      const cursorReq = compStore.index('by_timestamp').openCursor(null, 'next');
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          compStore.delete(cursor.primaryKey);
          diffStore.delete(cursor.primaryKey);
          summaryStore.delete(cursor.primaryKey);
        }
        writeAll();
      };
    };
  }

  async #writeWalEntry(db, id, operation, payload) {
    const tx = db.transaction(STORE_OP_LOG, 'readwrite');
    tx.objectStore(STORE_OP_LOG).put({
      id,
      operation,
      payload,
      status:    OP_STATUS_PENDING,
      timestamp: new Date().toISOString()
    });
    await transactionToPromise(tx);
  }

  async #completeWalEntry(db, id) {
    const tx = db.transaction(STORE_OP_LOG, 'readwrite');
    const store = tx.objectStore(STORE_OP_LOG);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      if (getReq.result) {
        store.put({ ...getReq.result, status: OP_STATUS_COMPLETE });
      }
    };
    await transactionToPromise(tx);
  }

  async applyPendingOperations() {
    try {
      const db = await this.#getDB();
      const tx = db.transaction(STORE_OP_LOG, 'readonly');
      const pending = await requestToPromise(
        tx.objectStore(STORE_OP_LOG).index('by_status').getAll(IDBKeyRange.only(OP_STATUS_PENDING))
      );
      if (pending?.length) {
        errorTracker.track({
          code:    ERROR_CODES.STORAGE_VERSION_CONFLICT,
          message: `WAL replay: ${pending.length} pending operations found on startup`
        });
      }
    } catch (err) {
      logger.warn('WAL replay check failed', { error: err.message });
    }
  }

  async loadComparisonByPair(baselineId, compareId, mode) {
    try {
      const db = await this.#getDB();
      const pairKey = buildPairKey(baselineId, compareId, mode);
      const tx = db.transaction(STORE_COMPARISONS, 'readonly');
      const record = await requestToPromise(
        tx.objectStore(STORE_COMPARISONS).index('by_pair').get(pairKey)
      );
      return record ?? null;
    } catch (error) {
      trackError(ERROR_CODES.STORAGE_READ_FAILED, error.message);
      return null;
    }
  }

  async loadComparisonDiffs(comparisonId) {
    try {
      const db = await this.#getDB();
      const tx = db.transaction(STORE_COMP_DIFFS, 'readonly');
      const record = await requestToPromise(tx.objectStore(STORE_COMP_DIFFS).get(comparisonId));
      return record?.results ?? [];
    } catch (error) {
      trackError(ERROR_CODES.STORAGE_READ_FAILED, error.message);
      return [];
    }
  }

  saveVisualBlob(key, blob, comparisonId) {
    return this.#enqueue(() => this.#saveVisualBlobInner(key, blob, comparisonId));
  }

  async #saveVisualBlobInner(key, blob, comparisonId) {
    try {
      const db = await this.#getDB();
      const tx = db.transaction(STORE_VISUAL_BLOBS, 'readwrite');
      tx.objectStore(STORE_VISUAL_BLOBS).put({ key, blob, comparisonId, timestamp: new Date().toISOString() });
      await transactionToPromise(tx);
      return { success: true };
    } catch (error) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, error.message);
      return { success: false, error: error.message };
    }
  }

  async loadVisualBlob(key) {
    try {
      const db = await this.#getDB();
      const tx = db.transaction(STORE_VISUAL_BLOBS, 'readonly');
      const record = await requestToPromise(tx.objectStore(STORE_VISUAL_BLOBS).get(key));
      return record?.blob ?? null;
    } catch (error) {
      trackError(ERROR_CODES.STORAGE_READ_FAILED, error.message);
      return null;
    }
  }

  deleteVisualBlobsByComparisonId(comparisonId) {
    return this.#enqueue(() => this.#deleteVisualBlobsInner(comparisonId));
  }

  async #deleteVisualBlobsInner(comparisonId) {
    try {
      const db = await this.#getDB();
      const readTx = db.transaction(STORE_VISUAL_BLOBS, 'readonly');
      const keys = await requestToPromise(
        readTx.objectStore(STORE_VISUAL_BLOBS).index('by_comparisonId').getAllKeys(IDBKeyRange.only(comparisonId))
      );

      if (!keys?.length) {
        return { success: true };
      }

      const writeTx = db.transaction(STORE_VISUAL_BLOBS, 'readwrite');
      const store = writeTx.objectStore(STORE_VISUAL_BLOBS);
      for (const key of keys) {
        store.delete(key);
      }
      await transactionToPromise(writeTx);
      return { success: true };
    } catch (error) {
      trackError(ERROR_CODES.STORAGE_WRITE_FAILED, error.message);
      return { success: false, error: error.message };
    }
  }

  async checkQuota() {
    try {
      if (!navigator.storage?.estimate) {
        return { bytesInUse: 0, quota: 0, percentUsed: 0, available: 0 };
      }
      const { usage, quota } = await navigator.storage.estimate();
      const percentUsed = quota > 0 ? (usage / quota) * 100 : 0;
      return { bytesInUse: usage, quota, percentUsed, available: quota - usage };
    } catch {
      return null;
    }
  }
}

export { IDBRepository, buildPairKey };
import { get } from '../config/defaults.js';
import { errorTracker, ERROR_CODES } from './error-tracker.js';

const DB_NAME           = 'ui_comparison_db';
const DB_VERSION        = 2;
const STORE_REPORTS     = 'reports';
const STORE_ELEMENTS    = 'elements';
const STORE_COMPARISONS = 'comparisons';
const STORE_COMP_DIFFS  = 'comparison_diffs';
const MAX_COMPARISONS   = 20;

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

class IDBRepository {
  constructor() {
    this._db         = null;
    this._opening    = null;
    this._writeQueue = Promise.resolve();
  }

  _enqueue(fn) {
    this._writeQueue = this._writeQueue.then(fn, fn);
    return this._writeQueue;
  }

  _getDB() {
    if (this._db) return Promise.resolve(this._db);
    if (this._opening) return this._opening;

    this._opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db         = event.target.result;
        const oldVersion = event.oldVersion;

        if (oldVersion < 1) {
          const reportStore = db.createObjectStore(STORE_REPORTS, { keyPath: 'id' });
          reportStore.createIndex('by_timestamp', 'timestamp', { unique: false });
          reportStore.createIndex('by_url',       'url',       { unique: false });
          db.createObjectStore(STORE_ELEMENTS, { keyPath: 'reportId' });
        }

        if (oldVersion < 2) {
          const compStore = db.createObjectStore(STORE_COMPARISONS, { keyPath: 'id' });
          compStore.createIndex('by_timestamp', 'timestamp', { unique: false });
          compStore.createIndex('by_pair',      'pairKey',   { unique: true  });
          db.createObjectStore(STORE_COMP_DIFFS, { keyPath: 'comparisonId' });
        }
      };

      request.onsuccess = (event) => {
        const db = event.target.result;

        db.onversionchange = () => {
          db.close();
          this._db = null;
        };

        db.onerror = (event) => {
          errorTracker.track({
            code:    ERROR_CODES.STORAGE_READ_FAILED,
            message: event.target.error?.message ?? 'IDB error',
          });
        };

        this._db      = db;
        this._opening = null;
        resolve(db);
      };

      request.onerror = (event) => {
        this._opening = null;
        reject(new Error(`IDB open failed: ${event.target.error?.message}`));
      };

      request.onblocked = () => {
        this._opening = null;
        reject(new Error('IDB open blocked — close other extension tabs and retry'));
      };
    });

    return this._opening;
  }

  async saveReport(report) {
    return this._enqueue(() => this._saveReportInner(report));
  }

  async _saveReportInner(report) {
    const maxReports         = get('storage.maxReports');
    const { elements, ...meta } = report;

    try {
      const db = await this._getDB();

      await new Promise((resolve, reject) => {
        const tx           = db.transaction([STORE_REPORTS, STORE_ELEMENTS], 'readwrite');
        const reportStore  = tx.objectStore(STORE_REPORTS);
        const elementStore = tx.objectStore(STORE_ELEMENTS);

        transactionToPromise(tx).then(resolve).catch(reject);

        const getAllReq = reportStore.getAll();

        getAllReq.onsuccess = () => {
          const existing = getAllReq.result ?? [];

          if (existing.length >= maxReports) {
            const sorted  = existing.slice().sort(
              (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );
            const surplus = existing.length - maxReports + 1;
            for (const evicted of sorted.slice(0, surplus)) {
              reportStore.delete(evicted.id);
              elementStore.delete(evicted.id);
            }
          }

          reportStore.put(meta);

          if (elements?.length) {
            elementStore.put({ reportId: report.id, data: elements });
          }
        };

        getAllReq.onerror = () => tx.abort();
      });

      return { success: true, id: report.id };
    } catch (error) {
      errorTracker.track({
        code:    ERROR_CODES.STORAGE_WRITE_FAILED,
        message: error.message,
        context: { id: report.id },
      });
      return { success: false, error: error.message };
    }
  }

  async loadReports() {
    try {
      const db  = await this._getDB();
      const tx  = db.transaction(STORE_REPORTS, 'readonly');
      const all = await requestToPromise(tx.objectStore(STORE_REPORTS).getAll());
      return (all ?? []).sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
    } catch (error) {
      errorTracker.track({ code: ERROR_CODES.STORAGE_READ_FAILED, message: error.message });
      return [];
    }
  }

  async loadReportElements(reportId) {
    try {
      const db     = await this._getDB();
      const tx     = db.transaction(STORE_ELEMENTS, 'readonly');
      const record = await requestToPromise(tx.objectStore(STORE_ELEMENTS).get(reportId));
      return record?.data ?? [];
    } catch (error) {
      errorTracker.track({
        code:    ERROR_CODES.STORAGE_READ_FAILED,
        message: error.message,
        context: { reportId },
      });
      return [];
    }
  }

  async deleteReport(id) {
    return this._enqueue(() => this._deleteReportInner(id));
  }

  async _deleteReportInner(id) {
    try {
      const db              = await this._getDB();
      const compIdsToDelete = await this._getComparisonIdsByReportId(db, id);

      const tx = db.transaction(
        [STORE_REPORTS, STORE_ELEMENTS, STORE_COMPARISONS, STORE_COMP_DIFFS],
        'readwrite'
      );

      tx.objectStore(STORE_REPORTS).delete(id);
      tx.objectStore(STORE_ELEMENTS).delete(id);

      for (const compId of compIdsToDelete) {
        tx.objectStore(STORE_COMPARISONS).delete(compId);
        tx.objectStore(STORE_COMP_DIFFS).delete(compId);
      }

      await transactionToPromise(tx);
      return { success: true };
    } catch (error) {
      errorTracker.track({
        code:    ERROR_CODES.STORAGE_WRITE_FAILED,
        message: error.message,
        context: { id },
      });
      return { success: false, error: error.message };
    }
  }

  async _getComparisonIdsByReportId(db, reportId) {
    try {
      const tx  = db.transaction(STORE_COMPARISONS, 'readonly');
      const all = await requestToPromise(tx.objectStore(STORE_COMPARISONS).getAll());
      return (all ?? [])
        .filter(c => c.baselineId === reportId || c.compareId === reportId)
        .map(c => c.id);
    } catch {
      return [];
    }
  }

  async deleteAllReports() {
    return this._enqueue(() => this._deleteAllInner());
  }

  async _deleteAllInner() {
    try {
      const db = await this._getDB();
      const tx = db.transaction(
        [STORE_REPORTS, STORE_ELEMENTS, STORE_COMPARISONS, STORE_COMP_DIFFS],
        'readwrite'
      );

      tx.objectStore(STORE_REPORTS).clear();
      tx.objectStore(STORE_ELEMENTS).clear();
      tx.objectStore(STORE_COMPARISONS).clear();
      tx.objectStore(STORE_COMP_DIFFS).clear();

      await transactionToPromise(tx);
      return { success: true };
    } catch (error) {
      errorTracker.track({ code: ERROR_CODES.STORAGE_WRITE_FAILED, message: error.message });
      return { success: false, error: error.message };
    }
  }

  async saveComparison(meta, slimResults) {
    return this._enqueue(() => this._saveComparisonInner(meta, slimResults));
  }

  async _saveComparisonInner(meta, slimResults) {
    try {
      const db = await this._getDB();

      await new Promise((resolve, reject) => {
        const tx        = db.transaction([STORE_COMPARISONS, STORE_COMP_DIFFS], 'readwrite');
        const compStore = tx.objectStore(STORE_COMPARISONS);
        const diffStore = tx.objectStore(STORE_COMP_DIFFS);

        transactionToPromise(tx).then(resolve).catch(reject);

        const pairReq = compStore.index('by_pair').get(meta.pairKey);

        pairReq.onsuccess = () => {
          const existing = pairReq.result;
          if (existing) {
            compStore.delete(existing.id);
            diffStore.delete(existing.id);
          }

          const countReq = compStore.getAll();
          countReq.onsuccess = () => {
            const all = countReq.result ?? [];
            if (all.length >= MAX_COMPARISONS) {
              const oldest = all.slice().sort(
                (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
              )[0];
              compStore.delete(oldest.id);
              diffStore.delete(oldest.id);
            }
            compStore.put(meta);
            diffStore.put({ comparisonId: meta.id, results: slimResults });
          };

          countReq.onerror = () => tx.abort();
        };

        pairReq.onerror = () => tx.abort();
      });

      return { success: true, id: meta.id };
    } catch (error) {
      errorTracker.track({ code: ERROR_CODES.STORAGE_WRITE_FAILED, message: error.message });
      return { success: false, error: error.message };
    }
  }

  async loadComparisonByPair(baselineId, compareId, mode) {
    try {
      const db      = await this._getDB();
      const pairKey = buildPairKey(baselineId, compareId, mode);
      const tx      = db.transaction(STORE_COMPARISONS, 'readonly');
      const record  = await requestToPromise(
        tx.objectStore(STORE_COMPARISONS).index('by_pair').get(pairKey)
      );
      return record ?? null;
    } catch (error) {
      errorTracker.track({ code: ERROR_CODES.STORAGE_READ_FAILED, message: error.message });
      return null;
    }
  }

  async loadComparisonDiffs(comparisonId) {
    try {
      const db     = await this._getDB();
      const tx     = db.transaction(STORE_COMP_DIFFS, 'readonly');
      const record = await requestToPromise(tx.objectStore(STORE_COMP_DIFFS).get(comparisonId));
      return record?.results ?? [];
    } catch (error) {
      errorTracker.track({ code: ERROR_CODES.STORAGE_READ_FAILED, message: error.message });
      return [];
    }
  }

  async checkQuota() {
    try {
      if (!navigator.storage?.estimate) {
        return { bytesInUse: 0, quota: 0, percentUsed: 0, available: 0 };
      }
      const { usage, quota } = await navigator.storage.estimate();
      const percentUsed      = quota > 0 ? (usage / quota) * 100 : 0;
      return { bytesInUse: usage, quota, percentUsed, available: quota - usage };
    } catch {
      return null;
    }
  }
}

export { IDBRepository, buildPairKey };
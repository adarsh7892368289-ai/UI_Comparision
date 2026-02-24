import { IDBRepository } from './idb-repository.js';

class Storage {
  #repo;
  #initialized;

  constructor(repo = new IDBRepository()) {
    this.#repo = repo;
    this.#initialized = false;
  }

  init() {
    if (this.#initialized) {
      return this;
    }
    this.#initialized = true;
    this.#repo.applyPendingOperations();
    return this;
  }

  saveReport(report) {
    return this.#repo.saveReport(report);
  }

  loadReports() {
    return this.#repo.loadReports();
  }

  loadReportElements(reportId) {
    return this.#repo.loadReportElements(reportId);
  }

  deleteReport(id) {
    return this.#repo.deleteReport(id);
  }

  deleteAllReports() {
    return this.#repo.deleteAllReports();
  }

  saveComparison(meta, slimResults) {
    return this.#repo.saveComparison(meta, slimResults);
  }

  loadComparisonByPair(baselineId, compareId, mode) {
    return this.#repo.loadComparisonByPair(baselineId, compareId, mode);
  }

  loadComparisonDiffs(comparisonId) {
    return this.#repo.loadComparisonDiffs(comparisonId);
  }

  saveVisualBlob(key, blob, comparisonId) {
    return this.#repo.saveVisualBlob(key, blob, comparisonId);
  }

  loadVisualBlob(key) {
    return this.#repo.loadVisualBlob(key);
  }

  deleteVisualBlobsByComparisonId(comparisonId) {
    return this.#repo.deleteVisualBlobsByComparisonId(comparisonId);
  }

  checkQuota() {
    return this.#repo.checkQuota();
  }
}

const storage = new Storage();
export default storage;
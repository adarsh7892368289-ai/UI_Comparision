import { IDBRepository } from './idb-repository.js';

class Storage {
  constructor() {
    this._repo       = new IDBRepository();
    this.initialized = false;
  }

  init() {
    if (this.initialized) return this;
    this.initialized = true;
    return this;
  }

  saveReport(report) {
    return this._repo.saveReport(report);
  }

  loadReports() {
    return this._repo.loadReports();
  }

  loadReportElements(reportId) {
    return this._repo.loadReportElements(reportId);
  }

  deleteReport(id) {
    return this._repo.deleteReport(id);
  }

  deleteAllReports() {
    return this._repo.deleteAllReports();
  }

  saveComparison(meta, slimResults) {
    return this._repo.saveComparison(meta, slimResults);
  }

  loadComparisonByPair(baselineId, compareId, mode) {
    return this._repo.loadComparisonByPair(baselineId, compareId, mode);
  }

  loadComparisonDiffs(comparisonId) {
    return this._repo.loadComparisonDiffs(comparisonId);
  }

  checkQuota() {
    return this._repo.checkQuota();
  }
}

const storage = new Storage();
export default storage;
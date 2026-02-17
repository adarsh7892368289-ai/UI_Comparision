import logger from '../infrastructure/logger.js';
import { errorTracker } from '../infrastructure/error-tracker.js';
import storage from '../infrastructure/storage.js';
import { extractFromActiveTab } from '../application/extract-workflow.js';
import {
  loadAllReports,
  deleteReport,
  exportReportAsJson,
  exportReportAsCsv,
  deleteAllReports,
  exportAllReportsAsJson,
  exportAllReportsAsCsv,
  getStorageStats,
  searchReports
} from '../application/report-manager.js';
import { compareReports } from '../application/compare-workflow.js';
import { ExportManager, EXPORT_FORMATS } from '../core/export/export-manager.js';

logger.init();
errorTracker.init();
storage.init();

logger.setContext({ script: 'popup' });

let reports = [];
let currentComparisonResult = null;
const exportManager = new ExportManager();

document.addEventListener('DOMContentLoaded', async () => {
  logger.info('Popup opened');
  await initializeUI();
  setupEventListeners();
  await loadReports();
});

function sanitize(value) {
  const el = document.createElement('span');
  el.textContent = String(value ?? '');
  return el.innerHTML;
}

function showStatus(element, type, message) {
  if (!element) return;
  element.className = `status ${type}`;
  element.textContent = message;
  element.style.display = 'block';
}

function setLoading(button, isLoading, text) {
  if (!button) return;
  button.disabled = isLoading;
  if (isLoading) {
    button.setAttribute('data-original-text', button.textContent);
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    button.textContent = '';
    button.appendChild(spinner);
    button.appendChild(document.createTextNode(` ${text}`));
  } else {
    button.textContent = text || button.getAttribute('data-original-text') || 'Submit';
    button.removeAttribute('data-original-text');
  }
}

function armTwoStepConfirm(button, onConfirm) {
  if (button.dataset.confirmArmed === 'true') {
    clearTimeout(button._confirmTimer);
    button.dataset.confirmArmed = 'false';
    button.textContent = button.dataset.originalLabel;
    onConfirm();
    return;
  }
  button.dataset.originalLabel = button.textContent;
  button.dataset.confirmArmed = 'true';
  button.textContent = 'Confirm?';
  button._confirmTimer = setTimeout(() => {
    button.dataset.confirmArmed = 'false';
    button.textContent = button.dataset.originalLabel;
  }, 3000);
}

async function initializeUI() {
  setupTabs();
  await loadCurrentPageInfo();
}

function setupTabs() {
  document.querySelectorAll('.tab-button').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
      button.classList.add('active');
      document.getElementById(`${button.dataset.tab}-tab`).classList.add('active');
      logger.debug('Tab switched', { tab: button.dataset.tab });
    });
  });
}

async function loadCurrentPageInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      const urlElement = document.getElementById('current-url');
      if (urlElement) urlElement.textContent = tab.url;
    }
  } catch (error) {
    logger.error('Failed to get current tab info', { error: error.message });
  }
}

function setupEventListeners() {
  document.getElementById('extract-btn')?.addEventListener('click', handleExtraction);
  document.getElementById('compare-btn')?.addEventListener('click', handleComparison);

  const deleteAllBtn = document.getElementById('delete-all-btn');
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener('click', () => {
      armTwoStepConfirm(deleteAllBtn, handleDeleteAll);
    });
  }

  document.getElementById('export-all-btn')?.addEventListener('click', handleExportAll);

  const searchInput = document.getElementById('search-reports');
  if (searchInput) {
    let debounceTimer;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => handleSearch(e.target.value), 300);
    });
  }
}

async function handleExtraction() {
  const statusDiv = document.getElementById('extract-status');
  const extractBtn = document.getElementById('extract-btn');

  try {
    setLoading(extractBtn, true, 'Extracting...');
    showStatus(statusDiv, 'info', 'Extracting elements from the page...');
    logger.info('Starting extraction');

    const startTime = performance.now();
    const filters = getFilters();
    const report = await extractFromActiveTab(filters);
    const duration = performance.now() - startTime;

    logger.info('Extraction completed', { totalElements: report.totalElements, duration: Math.round(duration) });
    await loadReports();
    showStatus(statusDiv, 'success', `✓ Extracted ${report.totalElements} elements in ${Math.round(duration)}ms`);
  } catch (error) {
    logger.error('Extraction failed', { error: error.message });
    showStatus(statusDiv, 'error', `✗ Extraction failed: ${error.message}`);
  } finally {
    setLoading(extractBtn, false, 'Extract Elements');
  }
}

function getFilters() {
  const filters = {};
  const classVal = document.getElementById('filter-class')?.value.trim();
  const idVal = document.getElementById('filter-id')?.value.trim();
  const tagVal = document.getElementById('filter-tag')?.value.trim();
  if (classVal) filters.class = classVal;
  if (idVal) filters.id = idVal;
  if (tagVal) filters.tag = tagVal;
  return Object.keys(filters).length > 0 ? filters : null;
}

async function loadReports() {
  try {
    reports = await loadAllReports();
    displayReports();
    populateReportSelectors();
    await displayStorageStats();
  } catch (error) {
    logger.error('Failed to load reports', { error: error.message });
  }
}

function displayReports() {
  const container = document.getElementById('reports-list');
  if (!container) return;

  if (reports.length === 0) {
    container.textContent = '';
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No reports yet. Extract elements from a page to create your first report.';
    container.appendChild(empty);
    return;
  }

  container.textContent = '';

  for (const report of reports) {
    const item = document.createElement('div');
    item.className = 'report-item';
    item.dataset.id = report.id;

    const info = document.createElement('div');
    info.className = 'report-info';

    const title = document.createElement('div');
    title.className = 'report-title';
    title.textContent = report.title || 'Untitled';

    const meta = document.createElement('div');
    meta.className = 'report-meta';
    meta.textContent = `${report.totalElements} elements • ${new Date(report.timestamp).toLocaleString()}`;

    const url = document.createElement('div');
    url.className = 'report-url';
    url.textContent = report.url;

    info.appendChild(title);
    info.appendChild(meta);
    info.appendChild(url);

    const actions = document.createElement('div');
    actions.className = 'report-actions';

    const jsonBtn = document.createElement('button');
    jsonBtn.className = 'btn-icon export-json-btn';
    jsonBtn.title = 'Export as JSON';
    jsonBtn.textContent = '📋';
    jsonBtn.addEventListener('click', async () => {
      const r = reports.find(x => x.id === report.id);
      if (!r) return;
      try {
        jsonBtn.disabled = true;
        await exportReportAsJson(r);
      } catch (err) {
        const statusDiv = document.getElementById('extract-status');
        showStatus(statusDiv, 'error', `JSON export failed: ${err.message}`);
      } finally {
        jsonBtn.disabled = false;
      }
    });

    const csvBtn = document.createElement('button');
    csvBtn.className = 'btn-icon export-csv-btn';
    csvBtn.title = 'Export as CSV';
    csvBtn.textContent = '📊';
    csvBtn.addEventListener('click', async () => {
      const r = reports.find(x => x.id === report.id);
      if (!r) return;
      try {
        csvBtn.disabled = true;
        await exportReportAsCsv(r);
      } catch (err) {
        const statusDiv = document.getElementById('extract-status');
        showStatus(statusDiv, 'error', `CSV export failed: ${err.message}`);
      } finally {
        csvBtn.disabled = false;
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-icon delete-btn';
    deleteBtn.title = 'Delete';
    deleteBtn.textContent = '🗑️';
    deleteBtn.addEventListener('click', () => {
      armTwoStepConfirm(deleteBtn, async () => {
        await deleteReport(report.id);
        await loadReports();
      });
    });

    actions.appendChild(jsonBtn);
    actions.appendChild(csvBtn);
    actions.appendChild(deleteBtn);

    item.appendChild(info);
    item.appendChild(actions);
    container.appendChild(item);
  }
}

function populateReportSelectors() {
  const baselineSelect = document.getElementById('baseline-report');
  const compareSelect = document.getElementById('compare-report');
  if (!baselineSelect || !compareSelect) return;

  const emptyOption = () => {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Select report...';
    return opt;
  };

  baselineSelect.textContent = '';
  compareSelect.textContent = '';
  baselineSelect.appendChild(emptyOption());
  compareSelect.appendChild(emptyOption());

  for (const report of reports) {
    const makeOption = () => {
      const opt = document.createElement('option');
      opt.value = report.id;
      opt.textContent = `${report.title || 'Untitled'} (${report.totalElements} elements)`;
      return opt;
    };
    baselineSelect.appendChild(makeOption());
    compareSelect.appendChild(makeOption());
  }
}

async function handleComparison() {
  const statusDiv = document.getElementById('compare-status');
  const compareBtn = document.getElementById('compare-btn');
  const resultsDiv = document.getElementById('compare-results');

  try {
    const baselineId = document.getElementById('baseline-report')?.value;
    const compareId = document.getElementById('compare-report')?.value;

    if (!baselineId || !compareId) {
      showStatus(statusDiv, 'error', '✗ Please select both baseline and compare reports');
      return;
    }

    if (baselineId === compareId) {
      showStatus(statusDiv, 'error', '✗ Please select different reports');
      return;
    }

    setLoading(compareBtn, true, 'Comparing...');
    showStatus(statusDiv, 'info', 'Comparing reports...');

    const mode = document.querySelector('input[name="compare-mode"]:checked')?.value || 'static';
    const results = await compareReports(baselineId, compareId, mode);
    currentComparisonResult = results;

    displayComparisonResults(resultsDiv, results);
    showStatus(statusDiv, 'success', '✓ Comparison completed');
  } catch (error) {
    logger.error('Comparison failed', { error: error.message });
    showStatus(statusDiv, 'error', `✗ Comparison failed: ${error.message}`);
  } finally {
    setLoading(compareBtn, false, 'Compare Reports');
  }
}

function displayComparisonResults(container, results) {
  if (!container) return;

  const { baseline, matching, comparison } = results;
  const { severityCounts } = comparison.summary;
  const { critical, high, medium, low } = severityCounts;
  const total = comparison.summary.totalDifferences;

  let headerClass = 'info';
  if (critical > 0) headerClass = 'error';
  else if (high > 0) headerClass = 'warning';

  const severityBar = (label, count) => {
    if (!count) return '';
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : 0;
    return `
      <div class="severity-bar ${label.toLowerCase()}">
        <span class="severity-label">${sanitize(label)}</span>
        <div class="severity-progress">
          <div class="severity-fill" style="width:${pct}%"></div>
        </div>
        <span class="severity-count">${count}</span>
      </div>`;
  };

  container.innerHTML = `
    <div class="comparison-results">
      <div class="comparison-header ${headerClass}">
        <h3>Comparison Results</h3>
        <div class="comparison-meta">
          <span>Mode: ${sanitize(results.mode)}</span>
          <span>Duration: ${results.duration}ms</span>
        </div>
      </div>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Match Rate</div>
          <div class="stat-value">${matching.matchRate}%</div>
          <div class="stat-detail">${matching.totalMatched} / ${baseline.totalElements} elements</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Modified Elements</div>
          <div class="stat-value">${comparison.summary.modifiedElements}</div>
          <div class="stat-detail">${total} total differences</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Unchanged</div>
          <div class="stat-value">${comparison.summary.unchangedElements}</div>
          <div class="stat-detail">No differences detected</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Unmatched</div>
          <div class="stat-value">${matching.unmatchedBaseline + matching.unmatchedCompare}</div>
          <div class="stat-detail">${matching.unmatchedBaseline} removed, ${matching.unmatchedCompare} added</div>
        </div>
      </div>
      ${total > 0 ? `
        <div class="severity-breakdown">
          <h4>Severity Breakdown</h4>
          <div class="severity-bars">
            ${severityBar('Critical', critical)}
            ${severityBar('High', high)}
            ${severityBar('Medium', medium)}
            ${severityBar('Low', low)}
          </div>
        </div>` : ''}
      <div class="comparison-actions">
        <div class="export-picker-row">
          <select id="export-format-select" class="select-input" aria-label="Export format">
            <option value="excel">Excel (.xlsx)</option>
            <option value="csv">CSV (.csv)</option>
            <option value="html">HTML (.html)</option>
            <option value="json">JSON (.json)</option>
          </select>
          <button id="export-comparison-btn" class="btn-secondary">Export Results</button>
        </div>
        <button id="view-details-btn" class="btn-primary">View Detailed Report</button>
      </div>
    </div>`;

  container.querySelector('#export-comparison-btn')
    ?.addEventListener('click', () => exportComparisonResults(results));

  container.querySelector('#view-details-btn')
    ?.addEventListener('click', () => exportManager.export(results, EXPORT_FORMATS.HTML));
}

async function exportComparisonResults(results) {
  if (!currentComparisonResult) {
    const statusDiv = document.getElementById('compare-status');
    showStatus(statusDiv, 'error', '✗ No comparison result available');
    return;
  }

  const formatSelect = document.getElementById('export-format-select');
  const selectedFormat = formatSelect?.value ?? EXPORT_FORMATS.EXCEL;
  const statusDiv = document.getElementById('compare-status');

  const result = await exportManager.export(currentComparisonResult, selectedFormat);
  if (result.success) {
    logger.info('Export successful', { format: selectedFormat });
    showStatus(statusDiv, 'success', `✓ Exported as ${selectedFormat.toUpperCase()}`);
  } else {
    showStatus(statusDiv, 'error', `✗ Export failed: ${result.error}`);
  }
}

async function displayStorageStats() {
  const statsDiv = document.getElementById('storage-stats');
  if (!statsDiv) return;

  try {
    const stats = await getStorageStats();
    if (!stats) return;

    const percentUsed = stats.quota.percentUsed.toFixed(1);
    const bytesUsedMB = (stats.quota.bytesInUse / (1024 * 1024)).toFixed(2);
    const quotaMB = (stats.quota.quota / (1024 * 1024)).toFixed(2);

    let statusClass = 'info';
    if (stats.quota.percentUsed > 80) statusClass = 'warning';
    if (stats.quota.percentUsed > 95) statusClass = 'error';

    statsDiv.innerHTML = `
      <div class="stats-grid">
        <div class="stat-item">
          <span class="stat-label">Reports:</span>
          <span class="stat-value">${stats.reportsCount}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Total Elements:</span>
          <span class="stat-value">${stats.totalElements.toLocaleString()}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Avg Elements:</span>
          <span class="stat-value">${stats.avgElements}</span>
        </div>
        <div class="stat-item ${statusClass}">
          <span class="stat-label">Storage:</span>
          <span class="stat-value">${bytesUsedMB} / ${quotaMB} MB (${percentUsed}%)</span>
        </div>
      </div>`;
  } catch (error) {
    logger.error('Failed to display storage stats', { error: error.message });
  }
}

async function handleDeleteAll() {
  try {
    const result = await deleteAllReports();
    if (result.success) {
      logger.info('All reports deleted', { count: result.count });
      await loadReports();
    }
  } catch (error) {
    logger.error('Failed to delete all reports', { error: error.message });
  }
}

async function handleExportAll() {
  const statusDiv = document.getElementById('extract-status');
  const formatSelect = document.getElementById('export-all-format');
  const format = formatSelect?.value ?? 'csv';

  try {
    const result = format === 'csv'
      ? await exportAllReportsAsCsv()
      : await exportAllReportsAsJson();

    if (result.success) {
      showStatus(statusDiv, 'success', `✓ Exported ${result.count} reports as ${format.toUpperCase()}`);
      logger.info('All reports exported', { format, count: result.count });
    } else {
      showStatus(statusDiv, 'error', `✗ Export failed: ${result.error}`);
    }
  } catch (error) {
    logger.error('Export all reports failed', { error: error.message });
    showStatus(statusDiv, 'error', `✗ Export failed: ${error.message}`);
  }
}

async function handleSearch(query) {
  if (!query || query.trim() === '') {
    reports = await loadAllReports();
  } else {
    reports = await searchReports(query.trim());
  }
  displayReports();
}

logger.info('Popup script initialized');
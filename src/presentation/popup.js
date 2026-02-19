import logger from '../infrastructure/logger.js';
import { errorTracker } from '../infrastructure/error-tracker.js';
import storage from '../infrastructure/storage.js';
import { popupState } from './popup-state.js';
import { TabAdapter } from '../infrastructure/chrome-tabs.js';
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

const exportManager = new ExportManager();

document.addEventListener('DOMContentLoaded', async () => {
  logger.info('Popup opened');
  await initializeUI();
  setupEventListeners();
  setupStateSubscription();
  await loadReportsFromStorage();
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
      popupState.dispatch('TAB_CHANGED', { tab: button.dataset.tab });
    });
  });
}

async function loadCurrentPageInfo() {
  try {
    const tab = await TabAdapter.getActiveTab();
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
      debounceTimer = setTimeout(() => {
        popupState.dispatch('SEARCH_CHANGED', { query: e.target.value });
      }, 300);
    });
  }

  const baselineSelect = document.getElementById('baseline-report');
  const compareSelect = document.getElementById('compare-report');
  
  if (baselineSelect) {
    baselineSelect.addEventListener('change', (e) => {
      popupState.dispatch('BASELINE_SELECTED', { id: e.target.value });
    });
  }
  
  if (compareSelect) {
    compareSelect.addEventListener('change', (e) => {
      popupState.dispatch('COMPARE_SELECTED', { id: e.target.value });
    });
  }

  document.querySelectorAll('input[name="compare-mode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      if (e.target.checked) {
        popupState.dispatch('MODE_CHANGED', { mode: e.target.value });
      }
    });
  });
}

function setupStateSubscription() {
  popupState.subscribe((state, type) => {
    updateUIFromState(state, type);
  });
}

function updateUIFromState(state, transitionType) {
  if (transitionType === 'TAB_CHANGED') {
    document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    const activeTab = document.querySelector(`[data-tab="${state.activeTab}"]`);
    if (activeTab) activeTab.classList.add('active');
    
    const activeContent = document.getElementById(`${state.activeTab}-tab`);
    if (activeContent) activeContent.classList.add('active');
  }

  if (transitionType === 'REPORTS_LOADED' || transitionType === 'REPORT_DELETED') {
    displayReports(state.reports, state.search);
    populateReportSelectors(state.reports);
  }

  if (transitionType === 'SEARCH_CHANGED') {
    displayReports(state.reports, state.search);
  }

  if (transitionType === 'STORAGE_STATS_LOADED') {
    displayStorageStats(state.storageStats);
  }

  if (transitionType === 'EXTRACTION_STARTED' || transitionType === 'EXTRACTION_COMPLETE' || 
      transitionType === 'EXTRACTION_FAILED' || transitionType === 'EXTRACTION_PROGRESS') {
    updateExtractionUI(state);
  }

  if (transitionType === 'COMPARISON_STARTED' || transitionType === 'COMPARISON_COMPLETE' || 
      transitionType === 'COMPARISON_FAILED' || transitionType === 'COMPARISON_PROGRESS') {
    updateComparisonUI(state);
  }

  if (transitionType === 'COMPARISON_COMPLETE') {
    displayComparisonResults(state.comparisonResult);
  }
}

function updateExtractionUI(state) {
  const statusDiv = document.getElementById('extract-status');
  const extractBtn = document.getElementById('extract-btn');

  setLoading(extractBtn, state.isExtracting, state.extractionLabel || 'Extracting...');

  if (state.isExtracting) {
    showStatus(statusDiv, 'info', state.extractionLabel);
  } else if (state.error && state.error.includes('Extract')) {
    showStatus(statusDiv, 'error', `✗ ${state.error}`);
  }
}

function updateComparisonUI(state) {
  const statusDiv = document.getElementById('compare-status');
  const compareBtn = document.getElementById('compare-btn');

  setLoading(compareBtn, state.isComparing, state.comparisonLabel || 'Comparing...');

  if (state.isComparing) {
    showStatus(statusDiv, 'info', state.comparisonLabel);
  } else if (state.error && state.error.includes('Comparison')) {
    showStatus(statusDiv, 'error', `✗ ${state.error}`);
  }
}

async function handleExtraction() {
  popupState.dispatch('EXTRACTION_STARTED');

  try {
    const filters = getFilters();
    const report = await extractFromActiveTab(filters);
    
    popupState.dispatch('EXTRACTION_COMPLETE', { report });
    await loadReportsFromStorage();
    
    const statusDiv = document.getElementById('extract-status');
    showStatus(statusDiv, 'success', `✓ Extracted ${report.totalElements} elements`);
  } catch (error) {
    const errorMsg = error.message || String(error);
    popupState.dispatch('EXTRACTION_FAILED', { error: errorMsg });
    logger.error('Extraction failed', { error: errorMsg });
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

async function loadReportsFromStorage() {
  try {
    const reports = await loadAllReports();
    popupState.dispatch('REPORTS_LOADED', { reports });
    
    const stats = await getStorageStats();
    if (stats) {
      popupState.dispatch('STORAGE_STATS_LOADED', { stats });
    }
  } catch (error) {
    logger.error('Failed to load reports', { error: error.message });
  }
}

function displayReports(reports, searchQuery) {
  const container = document.getElementById('reports-list');
  if (!container) return;

  const filteredReports = searchQuery
    ? reports.filter(r => 
        (r.title || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (r.url || '').toLowerCase().includes(searchQuery.toLowerCase())
      )
    : reports;

  if (filteredReports.length === 0) {
    container.textContent = '';
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = searchQuery 
      ? 'No reports match your search.'
      : 'No reports yet. Extract elements from a page to create your first report.';
    container.appendChild(empty);
    return;
  }

  container.textContent = '';

  for (const report of filteredReports) {
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

    const jsonBtn = createActionButton('📋', 'Export as JSON', async () => {
      try {
        await exportReportAsJson(report);
      } catch (err) {
        showStatus(document.getElementById('extract-status'), 'error', `✗ Export failed: ${err.message}`);
      }
    });

    const csvBtn = createActionButton('📊', 'Export as CSV', async () => {
      try {
        await exportReportAsCsv(report);
      } catch (err) {
        showStatus(document.getElementById('extract-status'), 'error', `✗ Export failed: ${err.message}`);
      }
    });

    const deleteBtn = createActionButton('🗑️', 'Delete', () => {
      armTwoStepConfirm(deleteBtn, async () => {
        await deleteReport(report.id);
        popupState.dispatch('REPORT_DELETED', { id: report.id });
        await loadReportsFromStorage();
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

function createActionButton(icon, title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'btn-icon';
  btn.title = title;
  btn.textContent = icon;
  btn.addEventListener('click', onClick);
  return btn;
}

function populateReportSelectors(reports) {
  const baselineSelect = document.getElementById('baseline-report');
  const compareSelect = document.getElementById('compare-report');
  
  if (!baselineSelect || !compareSelect) return;

  const createOptions = () => {
    const fragment = document.createDocumentFragment();
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = 'Select report...';
    fragment.appendChild(emptyOpt);

    for (const report of reports) {
      const opt = document.createElement('option');
      opt.value = report.id;
      opt.textContent = `${report.title || 'Untitled'} (${report.totalElements} elements)`;
      fragment.appendChild(opt);
    }
    
    return fragment;
  };

  baselineSelect.textContent = '';
  compareSelect.textContent = '';
  baselineSelect.appendChild(createOptions());
  compareSelect.appendChild(createOptions());
}

async function handleComparison() {
  const state = popupState.get();
  const statusDiv = document.getElementById('compare-status');

  if (!state.selectedBaseline || !state.selectedCompare) {
    showStatus(statusDiv, 'error', '✗ Please select both baseline and compare reports');
    return;
  }

  if (state.selectedBaseline === state.selectedCompare) {
    showStatus(statusDiv, 'error', '✗ Please select different reports');
    return;
  }

  popupState.dispatch('COMPARISON_STARTED');

  try {
    const result = await compareReports(
      state.selectedBaseline, 
      state.selectedCompare, 
      state.compareMode
    );
    
    popupState.dispatch('COMPARISON_COMPLETE', { result });
    showStatus(statusDiv, 'success', '✓ Comparison completed');
  } catch (error) {
    const errorMsg = error.message || String(error);
    popupState.dispatch('COMPARISON_FAILED', { error: errorMsg });
    showStatus(statusDiv, 'error', `✗ ${errorMsg}`);
  }
}

function displayComparisonResults(result) {
  const container = document.getElementById('compare-results');
  if (!container || !result) return;

  const { baseline, matching, comparison } = result;
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
          <span>Mode: ${sanitize(result.mode)}</span>
          <span>Duration: ${result.duration}ms</span>
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
    ?.addEventListener('click', () => exportComparisonResults());

  container.querySelector('#view-details-btn')
    ?.addEventListener('click', () => exportManager.export(result, EXPORT_FORMATS.HTML));
}

async function exportComparisonResults() {
  const state = popupState.get();
  const result = state.comparisonResult;
  
  if (!result) {
    showStatus(document.getElementById('compare-status'), 'error', '✗ No comparison result available');
    return;
  }

  const formatSelect = document.getElementById('export-format-select');
  const selectedFormat = formatSelect?.value ?? EXPORT_FORMATS.EXCEL;
  const statusDiv = document.getElementById('compare-status');

  const exportResult = await exportManager.export(result, selectedFormat);
  if (exportResult.success) {
    showStatus(statusDiv, 'success', `✓ Exported as ${selectedFormat.toUpperCase()}`);
  } else {
    showStatus(statusDiv, 'error', `✗ Export failed: ${exportResult.error}`);
  }
}

function displayStorageStats(stats) {
  const statsDiv = document.getElementById('storage-stats');
  if (!statsDiv || !stats) return;

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
}

async function handleDeleteAll() {
  try {
    const result = await deleteAllReports();
    if (result.success) {
      popupState.dispatch('REPORTS_LOADED', { reports: [] });
      await loadReportsFromStorage();
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
    } else {
      showStatus(statusDiv, 'error', `✗ Export failed: ${result.error}`);
    }
  } catch (error) {
    showStatus(statusDiv, 'error', `✗ Export failed: ${error.message}`);
  }
}

logger.info('Popup script initialized');
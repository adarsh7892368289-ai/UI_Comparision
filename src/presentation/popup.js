import logger from '../infrastructure/logger.js';
import { errorTracker } from '../infrastructure/error-tracker.js';
import storage from '../infrastructure/storage.js';
import { extractFromActiveTab } from '../application/extract-workflow.js';
import { 
  loadAllReports, 
  deleteReport, 
  exportReportAsJson,
  deleteAllReports,
  exportAllReportsAsJson,
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

async function initializeUI() {
  setupTabs();
  await loadCurrentPageInfo();
}

function setupTabs() {
  const tabButtons = document.querySelectorAll('.tab-button');
  
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab-button').forEach(btn => 
        btn.classList.remove('active')
      );
      document.querySelectorAll('.tab-content').forEach(content => 
        content.classList.remove('active')
      );
      
      button.classList.add('active');
      const tabName = button.dataset.tab;
      document.getElementById(`${tabName}-tab`).classList.add('active');
      
      logger.debug('Tab switched', { tab: tabName });
    });
  });
}

async function loadCurrentPageInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      const urlElement = document.getElementById('current-url');
      if (urlElement) {
        urlElement.textContent = tab.url;
      }
    }
  } catch (error) {
    logger.error('Failed to get current tab info', { error: error.message });
  }
}

function setupEventListeners() {
  const extractBtn = document.getElementById('extract-btn');
  const compareBtn = document.getElementById('compare-btn');
  const deleteAllBtn = document.getElementById('delete-all-btn');
  const exportAllBtn = document.getElementById('export-all-btn');
  const searchInput = document.getElementById('search-reports');
  
  if (extractBtn) {
    extractBtn.addEventListener('click', handleExtraction);
  }
  
  if (compareBtn) {
    compareBtn.addEventListener('click', handleComparison);
  }
  
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener('click', handleDeleteAll);
  }
  
  if (exportAllBtn) {
    exportAllBtn.addEventListener('click', handleExportAll);
  }
  
  if (searchInput) {
    let searchTimeout;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        handleSearch(e.target.value);
      }, 300);
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
    logger.info('Extraction completed', { 
      totalElements: report.totalElements,
      duration: Math.round(duration)
    });
    
    await loadReports();
    
    showStatus(statusDiv, 'success', 
      `✓ Extracted ${report.totalElements} elements in ${Math.round(duration)}ms`
    );
    
  } catch (error) {
    logger.error('Extraction failed', { error: error.message });
    showStatus(statusDiv, 'error', `✗ Extraction failed: ${error.message}`);
  } finally {
    setLoading(extractBtn, false, 'Extract Elements');
  }
}

function getFilters() {
  const classFilter = document.getElementById('filter-class')?.value.trim();
  const idFilter = document.getElementById('filter-id')?.value.trim();
  const tagFilter = document.getElementById('filter-tag')?.value.trim();
  
  const filters = {};
  if (classFilter) filters.class = classFilter;
  if (idFilter) filters.id = idFilter;
  if (tagFilter) filters.tag = tagFilter;
  
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
    container.innerHTML = '<p class="empty-state">No reports yet. Extract elements from a page to create your first report.</p>';
    return;
  }
  
  container.innerHTML = reports.map(report => `
    <div class="report-item" data-id="${report.id}">
      <div class="report-info">
        <div class="report-title">${report.title || 'Untitled'}</div>
        <div class="report-meta">
          ${report.totalElements} elements • ${new Date(report.timestamp).toLocaleString()}
        </div>
        <div class="report-url">${report.url}</div>
      </div>
      <div class="report-actions">
        <button class="btn-icon export-btn" data-id="${report.id}" title="Export as JSON">
          📥
        </button>
        <button class="btn-icon delete-btn" data-id="${report.id}" title="Delete">
          🗑️
        </button>
      </div>
    </div>
  `).join('');
  
  container.querySelectorAll('.export-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const reportId = e.target.dataset.id;
      const report = reports.find(r => r.id === reportId);
      if (report) {
        exportReportAsJson(report);
      }
    });
  });
  
  container.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const reportId = e.target.dataset.id;
      if (confirm('Delete this report?')) {
        await deleteReport(reportId);
        await loadReports();
      }
    });
  });
}

function populateReportSelectors() {
  const baselineSelect = document.getElementById('baseline-report');
  const compareSelect = document.getElementById('compare-report');
  
  if (!baselineSelect || !compareSelect) return;
  
  const options = reports.map(report => 
    `<option value="${report.id}">${report.title || 'Untitled'} (${report.totalElements} elements)</option>`
  ).join('');
  
  baselineSelect.innerHTML = '<option value="">Select baseline report...</option>' + options;
  compareSelect.innerHTML = '<option value="">Select compare report...</option>' + options;
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
  
  const { baseline, compare, matching, comparison, unmatchedElements } = results;
  
  const criticalCount = comparison.summary.severityCounts.critical;
  const highCount = comparison.summary.severityCounts.high;
  const mediumCount = comparison.summary.severityCounts.medium;
  const lowCount = comparison.summary.severityCounts.low;
  
  let alertClass = 'info';
  if (criticalCount > 0) alertClass = 'error';
  else if (highCount > 0) alertClass = 'warning';
  
  container.innerHTML = `
    <div class="comparison-results">
      <div class="comparison-header ${alertClass}">
        <h3>Comparison Results</h3>
        <div class="comparison-meta">
          <span>Mode: ${results.mode}</span>
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
          <div class="stat-detail">${comparison.summary.totalDifferences} total differences</div>
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

      ${criticalCount + highCount + mediumCount + lowCount > 0 ? `
        <div class="severity-breakdown">
          <h4>Severity Breakdown</h4>
          <div class="severity-bars">
            ${criticalCount > 0 ? `
              <div class="severity-bar critical">
                <span class="severity-label">Critical</span>
                <div class="severity-progress">
                  <div class="severity-fill" style="width: ${(criticalCount / comparison.summary.totalDifferences * 100).toFixed(1)}%"></div>
                </div>
                <span class="severity-count">${criticalCount}</span>
              </div>
            ` : ''}
            ${highCount > 0 ? `
              <div class="severity-bar high">
                <span class="severity-label">High</span>
                <div class="severity-progress">
                  <div class="severity-fill" style="width: ${(highCount / comparison.summary.totalDifferences * 100).toFixed(1)}%"></div>
                </div>
                <span class="severity-count">${highCount}</span>
              </div>
            ` : ''}
            ${mediumCount > 0 ? `
              <div class="severity-bar medium">
                <span class="severity-label">Medium</span>
                <div class="severity-progress">
                  <div class="severity-fill" style="width: ${(mediumCount / comparison.summary.totalDifferences * 100).toFixed(1)}%"></div>
                </div>
                <span class="severity-count">${mediumCount}</span>
              </div>
            ` : ''}
            ${lowCount > 0 ? `
              <div class="severity-bar low">
                <span class="severity-label">Low</span>
                <div class="severity-progress">
                  <div class="severity-fill" style="width: ${(lowCount / comparison.summary.totalDifferences * 100).toFixed(1)}%"></div>
                </div>
                <span class="severity-count">${lowCount}</span>
              </div>
            ` : ''}
          </div>
        </div>
      ` : ''}

      <div class="comparison-actions">
        <button id="export-comparison-btn" class="btn-secondary">Export Results</button>
        <button id="view-details-btn" class="btn-primary">View Detailed Report</button>
      </div>
    </div>
  `;
  
  const exportBtn = container.querySelector('#export-comparison-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => exportComparisonResults(results));
  }
  
  const detailsBtn = container.querySelector('#view-details-btn');
  if (detailsBtn) {
    detailsBtn.addEventListener('click', () => displayDetailedResults(results));
  }
}

function exportComparisonResults(results) {
  if (!currentComparisonResult) {
    alert('No comparison result available to export');
    return;
  }

  const format = prompt(
    'Select export format:\n' +
    '1 - Excel (.xlsx)\n' +
    '2 - CSV (.csv)\n' +
    '3 - HTML (.html)\n' +
    '4 - JSON (.json)',
    '1'
  );

  let selectedFormat;
  switch (format) {
    case '1':
      selectedFormat = EXPORT_FORMATS.EXCEL;
      break;
    case '2':
      selectedFormat = EXPORT_FORMATS.CSV;
      break;
    case '3':
      selectedFormat = EXPORT_FORMATS.HTML;
      break;
    case '4':
      selectedFormat = EXPORT_FORMATS.JSON;
      break;
    default:
      return;
  }

  exportManager.export(currentComparisonResult, selectedFormat)
    .then(result => {
      if (result.success) {
        logger.info('Export successful', { format: selectedFormat });
      } else {
        alert(`Export failed: ${result.error}`);
      }
    });
}

function displayDetailedResults(results) {
  logger.info('Displaying detailed results', { 
    totalMatches: results.comparison.results.length 
  });

  exportManager.export(results, EXPORT_FORMATS.HTML);
}

function showStatus(element, type, message) {
  if (!element) return;
  
  element.className = `status ${type}`;
  element.textContent = message;
  element.style.display = 'block';
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
      </div>
    `;
  } catch (error) {
    logger.error('Failed to display storage stats', { error: error.message });
  }
}

async function handleDeleteAll() {
  if (!confirm('Delete ALL reports? This cannot be undone.')) {
    return;
  }
  
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
  try {
    const result = await exportAllReportsAsJson();
    if (result.success) {
      logger.info('All reports exported', { count: result.count });
    }
  } catch (error) {
    logger.error('Failed to export all reports', { error: error.message });
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

function setLoading(button, isLoading, text) {
  if (!button) return;
  
  button.disabled = isLoading;
  
  if (isLoading) {
    button.setAttribute('data-original-text', button.textContent);
    button.innerHTML = `<span class="spinner"></span> ${text}`;
  } else {
    button.textContent = text || button.getAttribute('data-original-text') || 'Submit';
    button.removeAttribute('data-original-text');
  }
}

logger.info('Popup script initialized');
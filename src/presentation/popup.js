//Popup Script - Extension UI controller
//Handles report management, extraction orchestration, and comparison

import config from '../infrastructure/config.js';
import logger from '../infrastructure/logger.js';
import errorTracker, { ErrorCodes } from '../infrastructure/error-tracker.js';
import { NormalizerEngine } from '../domain/engines/normalizer-engine.js';

let reports = [];

// Initialize infrastructure
config.init();
logger.init();
errorTracker.init();

logger.setContext({ script: 'popup' });

// Initialize normalizer engine
const normalizerEngine = new NormalizerEngine();
logger.info('Normalizer engine initialized');

document.addEventListener('DOMContentLoaded', async () => {
  logger.info('Popup opened');
  
  await loadReports();
  await loadCurrentPageUrl();
  setupTabs();
  
  document.getElementById('extract-btn').addEventListener('click', extractElements);
  document.getElementById('compare-btn').addEventListener('click', compareReports);
  
  populateReportSelectors();
});


//Get and display current page URL
async function loadCurrentPageUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      document.getElementById('page-url').value = tab.url;
    }
  } catch (error) {
    logger.error('Failed to get current tab URL', { error: error.message });
  }
}

//Tab switching functionality
function setupTabs() {
  const tabButtons = document.querySelectorAll('.tab-button');
  
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
      
      button.classList.add('active');
      const tabName = button.dataset.tab;
      document.getElementById(`${tabName}-tab`).classList.add('active');
      
      logger.debug('Tab switched', { tab: tabName });
    });
  });
}

//Extract elements from current page
async function extractElements() {
  const statusDiv = document.getElementById('extract-status');
  const extractBtn = document.getElementById('extract-btn');
  const pageUrlInput = document.getElementById('page-url');
  
  try {
    extractBtn.disabled = true;
    extractBtn.textContent = 'Extracting...';
    
    statusDiv.className = 'status info';
    statusDiv.textContent = 'Extracting elements from the page...';
    
    logger.info('Starting extraction');
    const startTime = performance.now();
    
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab) {
      throw new Error('No active tab found');
    }
    
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://')) {
      throw new Error('Cannot extract elements from browser internal pages');
    }
    
    const pageUrl = pageUrlInput.value.trim() || tab.url;
    
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'] // Fixed: webpack outputs to root of dist/
      });
    } catch (injectionError) {
      logger.debug('Content script injection', { error: injectionError.message });
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'extractElements' });
    
    if (response && response.success) {
      const report = {
        id: Date.now().toString(),
        url: pageUrl,
        timestamp: new Date().toISOString(),
        data: response.data
      };
      
      reports.push(report);
      await saveReports();
      
      displayReports();
      populateReportSelectors();
      
      const duration = performance.now() - startTime;
      
      logger.info('Extraction successful', { 
        reportId: report.id,
        elementCount: response.data.totalElements,
        duration: Math.round(duration)
      });
      
      statusDiv.className = 'status success';
      statusDiv.textContent = `Successfully extracted ${response.data.totalElements} elements from the page!`;
    } else {
      throw new Error(response?.error || 'Failed to extract elements');
    }
  } catch (error) {
    logger.error('Extraction failed', { error: error.message });
    
    errorTracker.logError(
      ErrorCodes.EXTRACTION_TIMEOUT,
      'Extraction failed in popup',
      { error: error.message }
    );
    
    statusDiv.className = 'status error';
    if (error.message.includes('Cannot access')) {
      statusDiv.textContent = 'Error: Cannot access this page. Try reloading the page first, then click Extract Elements again.';
    } else {
      statusDiv.textContent = `Error: ${error.message}`;
    }
  } finally {
    extractBtn.disabled = false;
    extractBtn.textContent = 'Extract Elements';
  }
}

//Load reports from storage
async function loadReports() {
  try {
    const storageKey = config.get('storage.keys.reports', 'page_comparator_reports');
    const result = await chrome.storage.local.get([storageKey]);
    reports = result[storageKey] || [];
    
    logger.debug('Reports loaded', { count: reports.length });
    displayReports();
  } catch (error) {
    logger.error('Failed to load reports', { error: error.message });
  }
}

//Save reports to storage
async function saveReports() {
  try {
    const storageKey = config.get('storage.keys.reports', 'page_comparator_reports');
    const maxReports = config.get('storage.maxReports', 50);
    
    if (reports.length > maxReports) {
      logger.warn('Report limit exceeded, removing oldest', { 
        current: reports.length,
        max: maxReports 
      });
      reports = reports.slice(-maxReports);
    }
    
    await chrome.storage.local.set({ [storageKey]: reports });
    logger.debug('Reports saved', { count: reports.length });
  } catch (error) {
    logger.error('Failed to save reports', { error: error.message });
    
    errorTracker.logError(
      ErrorCodes.STORAGE_WRITE_FAILED,
      'Failed to save reports',
      { error: error.message }
    );
  }
}

//Display saved reports
function displayReports() {
  const container = document.getElementById('reports-container');
  
  if (reports.length === 0) {
    container.innerHTML = '<p style="color: #999; font-size: 12px; padding: 10px;">No reports saved yet.</p>';
    return;
  }
  
  container.innerHTML = reports.map(report => {
    const date = new Date(report.timestamp);
    const formattedDate = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
    const urlDisplay = report.url.length > 50 ? report.url.substring(0, 47) + '...' : report.url;
    
    return `
      <div class="report-item">
        <div class="report-info">
          <div class="report-name">${urlDisplay}</div>
          <div class="report-meta">${formattedDate} • ${report.data.totalElements} elements</div>
        </div>
        <div class="report-actions">
          <button class="download-btn" data-report-id="${report.id}">Download</button>
          <button class="delete-btn" data-report-id="${report.id}">Delete</button>
        </div>
      </div>
    `;
  }).join('');
  
  container.querySelectorAll('.download-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const reportId = e.target.getAttribute('data-report-id');
      downloadReport(reportId);
    });
  });
  
  container.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const reportId = e.target.getAttribute('data-report-id');
      deleteReport(reportId);
    });
  });
}

//Download report as Excel
function downloadReport(reportId) {
  const report = reports.find(r => r.id === reportId);
  if (!report) {
    logger.warn('Report not found for download', { reportId });
    alert('Report not found');
    return;
  }
  
  if (typeof XLSX === 'undefined') {
    logger.error('XLSX library not loaded');
    alert('Excel library not loaded. Please ensure xlsx.full.min.js is in the libs folder.');
    return;
  }
  
  try {
    logger.info('Downloading report', { reportId, elementCount: report.data.totalElements });
    
    const worksheetData = report.data.elements.map(el => ({
      'Index': el.index,
      'Tag Name': el.tagName,
      'ID': el.id,
      'Class': el.className,
      'Type': el.type,
      'Name': el.name,
      'Text Content': el.textContent,
      'Href': el.href,
      'Src': el.src,
      'Alt': el.alt,
      'Title': el.title,
      'Value': el.value,
      'Placeholder': el.placeholder,
      'XPath': el.xpath,
      'CSS Selector': el.cssSelector,
      'Attributes': el.attributes,
      'Visible': el.visible,
      'Position': el.position,
      'Dimensions': el.dimensions
    }));
    
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(worksheetData);
    
    XLSX.utils.book_append_sheet(wb, ws, 'Elements');
    
    const date = new Date(report.timestamp);
    const filename = `web_elements_${date.getFullYear()}-${(date.getMonth()+1).toString().padStart(2,'0')}-${date.getDate().toString().padStart(2,'0')}_${date.getHours()}.xlsx`;
    
    XLSX.writeFile(wb, filename);
    
    logger.info('Report downloaded', { filename });
  } catch (error) {
    logger.error('Failed to download report', { reportId, error: error.message });
    alert('Error downloading report: ' + error.message);
  }
}

//Delete report
async function deleteReport(reportId) {
  if (confirm('Are you sure you want to delete this report?')) {
    logger.info('Deleting report', { reportId });
    
    reports = reports.filter(r => r.id !== reportId);
    await saveReports();
    displayReports();
    populateReportSelectors();
  }
}

//Populate report selectors for comparison
function populateReportSelectors() {
  const select1 = document.getElementById('report1-select');
  const select2 = document.getElementById('report2-select');
  
  const options = reports.map(report => {
    const date = new Date(report.timestamp);
    const formattedDate = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
    const urlDisplay = report.url.length > 40 ? report.url.substring(0, 37) + '...' : report.url;
    return `<option value="${report.id}">${urlDisplay} (${formattedDate})</option>`;
  }).join('');
  
  select1.innerHTML = '<option value="">-- Select Report 1 --</option>' + options;
  select2.innerHTML = '<option value="">-- Select Report 2 --</option>' + options;
}

//Compare two reports
function compareReports() {
  const report1Id = document.getElementById('report1-select').value;
  const report2Id = document.getElementById('report2-select').value;
  const statusDiv = document.getElementById('compare-status');
  
  if (!report1Id || !report2Id) {
    statusDiv.className = 'status error';
    statusDiv.textContent = 'Please select both reports to compare.';
    return;
  }
  
  if (report1Id === report2Id) {
    statusDiv.className = 'status error';
    statusDiv.textContent = 'Please select two different reports.';
    return;
  }
  
  const report1 = reports.find(r => r.id === report1Id);
  const report2 = reports.find(r => r.id === report2Id);
  
  if (!report1 || !report2) {
    logger.error('Reports not found for comparison', { report1Id, report2Id });
    
    errorTracker.logError(
      ErrorCodes.COMPARISON_INVALID_REPORT,
      'Selected reports not found',
      { report1Id, report2Id }
    );
    
    statusDiv.className = 'status error';
    statusDiv.textContent = 'Selected reports not found.';
    return;
  }
  
  logger.info('Starting comparison', { 
    report1: report1.url,
    report2: report2.url 
  });
  
  const startTime = performance.now();
  const comparison = performComparison(report1, report2);
  const duration = performance.now() - startTime;
  
  logger.info('Comparison completed', { 
    added: comparison.added.length,
    removed: comparison.removed.length,
    modified: comparison.modified.length,
    duration: Math.round(duration)
  });
  
  displayComparisonResults(comparison, report1, report2);
  
  statusDiv.className = 'status success';
  statusDiv.textContent = 'Comparison completed successfully!';
}

//Perform the actual comparison with CSS normalization
function performComparison(report1, report2) {
  logger.debug('Normalizing reports before comparison');
  
  // Normalize both reports
  const normalizedReport1 = normalizeReport(report1);
  const normalizedReport2 = normalizeReport(report2);
  
  const matchStrategy = config.get('comparison.matchStrategy', 'xpath');
  
  const keyExtractor = matchStrategy === 'css' 
    ? (el) => el.cssSelector 
    : (el) => el.xpath;
  
  const elements1 = new Map(
    normalizedReport1.data.elements
      .filter(el => keyExtractor(el))
      .map(el => [keyExtractor(el), el])
  );
  
  const elements2 = new Map(
    normalizedReport2.data.elements
      .filter(el => keyExtractor(el))
      .map(el => [keyExtractor(el), el])
  );
  
  const added = [];
  const removed = [];
  const modified = [];
  
  // Find added and modified elements
  for (const [key, el2] of elements2) {
    if (!elements1.has(key)) {
      added.push(el2);
    } else {
      const el1 = elements1.get(key);
      const differences = findElementDifferences(el1, el2);
      if (differences.length > 0) {
        modified.push({ 
          element: el2, 
          baseline: el1,
          differences 
        });
      }
    }
  }
  
  // Find removed elements
  for (const [key, el1] of elements1) {
    if (!elements2.has(key)) {
      removed.push(el1);
    }
  }
  
  logger.debug('Comparison results', {
    total1: elements1.size,
    total2: elements2.size,
    added: added.length,
    removed: removed.length,
    modified: modified.length
  });
  
  return { added, removed, modified };
}

//Normalize entire report (add normalized CSS to each element)
function normalizeReport(report) {
  logger.debug('Normalizing report', { reportId: report.id });
  
  return {
    ...report,
    data: {
      ...report.data,
      elements: report.data.elements.map(element => {
        // If element has computed styles, normalize them
        if (element.styles && typeof element.styles === 'object') {
          try {
            const normalizedStyles = normalizerEngine.normalize(element.styles);
            
            return {
              ...element,
              originalStyles: element.styles, // Keep original for reference
              normalizedStyles: normalizedStyles // Add normalized version
            };
          } catch (error) {
            logger.warn('Failed to normalize styles for element', { 
              xpath: element.xpath,
              error: error.message 
            });
            
            return {
              ...element,
              originalStyles: element.styles,
              normalizedStyles: element.styles // Fallback to original
            };
          }
        }
        
        return element;
      })
    }
  };
}

//Find differences between two elements (including CSS)
function findElementDifferences(el1, el2) {
  const differences = [];
  
  // Compare basic attributes
  const keysToCompare = ['tagName', 'id', 'className', 'textContent', 'visible', 'dimensions'];
  
  for (const key of keysToCompare) {
    if (el1[key] !== el2[key]) {
      differences.push({
        property: key,
        oldValue: el1[key],
        newValue: el2[key],
        type: 'attribute'
      });
    }
  }
  
  // Compare normalized CSS properties
  if (el1.normalizedStyles && el2.normalizedStyles) {
    const cssDifferences = compareStyles(el1.normalizedStyles, el2.normalizedStyles);
    differences.push(...cssDifferences);
  }
  
  return differences;
}

//Compare two normalized CSS objects
function compareStyles(styles1, styles2) {
  const differences = [];
  
  // Get union of all properties
  const allProps = new Set([
    ...Object.keys(styles1 || {}),
    ...Object.keys(styles2 || {})
  ]);
  
  for (const prop of allProps) {
    const val1 = styles1?.[prop];
    const val2 = styles2?.[prop];
    
    // Compare normalized values (should now handle "red" vs "#FF0000" correctly)
    if (val1 !== val2) {
      differences.push({
        property: prop,
        oldValue: val1 || 'not set',
        newValue: val2 || 'not set',
        type: 'style'
      });
    }
  }
  
  return differences;
}

//Display comparison results
function displayComparisonResults(comparison, report1, report2) {
  const resultsDiv = document.getElementById('comparison-results');
  
  const summaryHTML = `
    <div class="comparison-summary">
      <h3>Comparison Summary</h3>
      <div class="summary-item">
        <span class="summary-label">Report 1 (Baseline):</span>
        <span class="summary-value">${report1.url}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Report 2 (Compare):</span>
        <span class="summary-value">${report2.url}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Elements Added:</span>
        <span class="summary-value added-count">${comparison.added.length}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Elements Removed:</span>
        <span class="summary-value removed-count">${comparison.removed.length}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Elements Modified:</span>
        <span class="summary-value modified-count">${comparison.modified.length}</span>
      </div>
    </div>
  `;
  
  let differencesHTML = '<div class="differences"><h3>Differences</h3>';
  
  // Display added elements
  if (comparison.added.length > 0) {
    differencesHTML += '<h4 style="margin-top: 15px; color: #4CAF50;">Added Elements</h4>';
    comparison.added.slice(0, 20).forEach(el => {
      differencesHTML += `
        <div class="difference-item added">
          <div class="difference-label">
            <strong>${el.tagName}</strong>${el.id ? '#' + el.id : ''}${el.className ? '.' + el.className.split(' ')[0] : ''}
          </div>
          <div class="difference-detail">XPath: ${el.xpath || 'N/A'}</div>
        </div>
      `;
    });
    if (comparison.added.length > 20) {
      differencesHTML += `<p style="color: #666; font-size: 11px; padding: 10px;">... and ${comparison.added.length - 20} more added elements</p>`;
    }
  }
  
  // Display removed elements
  if (comparison.removed.length > 0) {
    differencesHTML += '<h4 style="margin-top: 15px; color: #f44336;">Removed Elements</h4>';
    comparison.removed.slice(0, 20).forEach(el => {
      differencesHTML += `
        <div class="difference-item removed">
          <div class="difference-label">
            <strong>${el.tagName}</strong>${el.id ? '#' + el.id : ''}${el.className ? '.' + el.className.split(' ')[0] : ''}
          </div>
          <div class="difference-detail">XPath: ${el.xpath || 'N/A'}</div>
        </div>
      `;
    });
    if (comparison.removed.length > 20) {
      differencesHTML += `<p style="color: #666; font-size: 11px; padding: 10px;">... and ${comparison.removed.length - 20} more removed elements</p>`;
    }
  }
  
  // Display modified elements (with CSS differences)
  if (comparison.modified.length > 0) {
    differencesHTML += '<h4 style="margin-top: 15px; color: #FF9800;">Modified Elements</h4>';
    comparison.modified.slice(0, 20).forEach(item => {
      const el = item.element;
      
      // Separate attribute and style differences
      const attrDiffs = item.differences.filter(d => d.type === 'attribute');
      const styleDiffs = item.differences.filter(d => d.type === 'style');
      
      let diffDetails = '';
      
      if (attrDiffs.length > 0) {
        diffDetails += '<div style="margin-top: 5px;"><em>Attributes:</em></div>';
        diffDetails += '<ul style="margin: 5px 0; padding-left: 20px; font-size: 11px;">';
        attrDiffs.slice(0, 5).forEach(d => {
          diffDetails += `<li><strong>${d.property}:</strong> "${d.oldValue}" → "${d.newValue}"</li>`;
        });
        if (attrDiffs.length > 5) {
          diffDetails += `<li>... and ${attrDiffs.length - 5} more</li>`;
        }
        diffDetails += '</ul>';
      }
      
      if (styleDiffs.length > 0) {
        diffDetails += '<div style="margin-top: 5px;"><em>Styles:</em></div>';
        diffDetails += '<ul style="margin: 5px 0; padding-left: 20px; font-size: 11px;">';
        styleDiffs.slice(0, 5).forEach(d => {
          diffDetails += `<li><strong>${d.property}:</strong> "${d.oldValue}" → "${d.newValue}"</li>`;
        });
        if (styleDiffs.length > 5) {
          diffDetails += `<li>... and ${styleDiffs.length - 5} more</li>`;
        }
        diffDetails += '</ul>';
      }
      
      differencesHTML += `
        <div class="difference-item modified">
          <div class="difference-label">
            <strong>${el.tagName}</strong>${el.id ? '#' + el.id : ''}${el.className ? '.' + el.className.split(' ')[0] : ''}
            <span style="font-size: 10px; color: #666; margin-left: 10px;">(${item.differences.length} changes)</span>
          </div>
          <div class="difference-detail">${diffDetails}</div>
        </div>
      `;
    });
    if (comparison.modified.length > 20) {
      differencesHTML += `<p style="color: #666; font-size: 11px; padding: 10px;">... and ${comparison.modified.length - 20} more modified elements</p>`;
    }
  }
  
  if (comparison.added.length === 0 && comparison.removed.length === 0 && comparison.modified.length === 0) {
    differencesHTML += '<p style="color: #4CAF50; padding: 10px; font-weight: bold;">✓ No differences found! Pages are identical.</p>';
  }
  
  differencesHTML += '</div>';
  
  resultsDiv.innerHTML = summaryHTML + differencesHTML;
}
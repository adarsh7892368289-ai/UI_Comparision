// Popup script for Web Page Element Comparator

let reports = [];

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  // Load saved reports
  await loadReports();
  
  // Get current tab URL and display it
  await loadCurrentPageUrl();
  
  // Set up tab navigation
  setupTabs();
  
  // Set up event listeners
  document.getElementById('extract-btn').addEventListener('click', extractElements);
  document.getElementById('compare-btn').addEventListener('click', compareReports);
  
  // Populate report selectors
  populateReportSelectors();
});

// Get and display current page URL
async function loadCurrentPageUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      document.getElementById('page-url').value = tab.url;
    }
  } catch (error) {
    console.error('Error getting current tab URL:', error);
  }
}

// Tab switching functionality
function setupTabs() {
  const tabButtons = document.querySelectorAll('.tab-button');
  
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      // Remove active class from all buttons and contents
      document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
      
      // Add active class to clicked button and corresponding content
      button.classList.add('active');
      const tabName = button.dataset.tab;
      document.getElementById(`${tabName}-tab`).classList.add('active');
    });
  });
}

// Extract elements from current page
async function extractElements() {
  const statusDiv = document.getElementById('extract-status');
  const extractBtn = document.getElementById('extract-btn');
  const pageUrlInput = document.getElementById('page-url');
  
  try {
    // Disable button during extraction
    extractBtn.disabled = true;
    extractBtn.textContent = 'Extracting...';
    
    statusDiv.className = 'status info';
    statusDiv.textContent = 'Extracting elements from the page...';
    
    // Get the current active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab) {
      throw new Error('No active tab found');
    }
    
    // Check if the URL is a chrome:// or other restricted URL
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://')) {
      throw new Error('Cannot extract elements from browser internal pages');
    }
    
    // Use the URL from the input field or fall back to tab URL
    const pageUrl = pageUrlInput.value.trim() || tab.url;
    
    // Try to inject content script if not already present
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/scripts/content.js']
      });
    } catch (injectionError) {
      // Content script might already be injected, continue
      console.log('Content script injection:', injectionError.message);
    }
    
    // Wait a moment for script to initialize
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Send message to content script
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'extractElements' });
    
    if (response && response.success) {
      // Create report object
      const report = {
        id: Date.now().toString(),
        url: pageUrl,
        timestamp: new Date().toISOString(),
        data: response.data
      };
      
      // Save report
      reports.push(report);
      await saveReports();
      
      // Update UI
      displayReports();
      populateReportSelectors();
      
      statusDiv.className = 'status success';
      statusDiv.textContent = `Successfully extracted ${response.data.totalElements} elements from the page!`;
    } else {
      throw new Error(response?.error || 'Failed to extract elements');
    }
  } catch (error) {
    statusDiv.className = 'status error';
    if (error.message.includes('Cannot access')) {
      statusDiv.textContent = 'Error: Cannot access this page. Try reloading the page first, then click Extract Elements again.';
    } else {
      statusDiv.textContent = `Error: ${error.message}`;
    }
    console.error('Extraction error:', error);
  } finally {
    // Re-enable button
    extractBtn.disabled = false;
    extractBtn.textContent = 'Extract Elements';
  }
}

// Load reports from storage
async function loadReports() {
  try {
    const result = await chrome.storage.local.get(['reports']);
    reports = result.reports || [];
    displayReports();
  } catch (error) {
    console.error('Error loading reports:', error);
  }
}

// Save reports to storage
async function saveReports() {
  try {
    await chrome.storage.local.set({ reports: reports });
  } catch (error) {
    console.error('Error saving reports:', error);
  }
}

// Display saved reports
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
  
  // Attach event listeners to the buttons
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

// Download report as Excel
function downloadReport(reportId) {
  const report = reports.find(r => r.id === reportId);
  if (!report) {
    alert('Report not found');
    return;
  }
  
  // Check if XLSX library is loaded
  if (typeof XLSX === 'undefined') {
    alert('Excel library not loaded. Please ensure xlsx.full.min.js is in the libs folder.');
    return;
  }
  
  try {
    // Prepare data for Excel
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
    
    // Create workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(worksheetData);
    
    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(wb, ws, 'Elements');
    
    // Generate filename
    const date = new Date(report.timestamp);
    const filename = `web_elements_${date.getFullYear()}-${(date.getMonth()+1).toString().padStart(2,'0')}-${date.getDate().toString().padStart(2,'0')}_${date.getHours()}.xlsx`;
    
    // Download
    XLSX.writeFile(wb, filename);
  } catch (error) {
    alert('Error downloading report: ' + error.message);
    console.error('Download error:', error);
  }
}

// Delete report
async function deleteReport(reportId) {
  if (confirm('Are you sure you want to delete this report?')) {
    reports = reports.filter(r => r.id !== reportId);
    await saveReports();
    displayReports();
    populateReportSelectors();
  }
}

// Populate report selectors for comparison
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

// Compare two reports
function compareReports() {
  const report1Id = document.getElementById('report1-select').value;
  const report2Id = document.getElementById('report2-select').value;
  const statusDiv = document.getElementById('compare-status');
  const resultsDiv = document.getElementById('comparison-results');
  
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
    statusDiv.className = 'status error';
    statusDiv.textContent = 'Selected reports not found.';
    return;
  }
  
  // Perform comparison
  const comparison = performComparison(report1, report2);
  
  // Display results
  displayComparisonResults(comparison, report1, report2);
  
  statusDiv.className = 'status success';
  statusDiv.textContent = 'Comparison completed successfully!';
}

// Perform the actual comparison
function performComparison(report1, report2) {
  const elements1 = new Map(report1.data.elements.map(el => [el.xpath, el]));
  const elements2 = new Map(report2.data.elements.map(el => [el.xpath, el]));
  
  const added = [];
  const removed = [];
  const modified = [];
  
  // Find added and modified elements
  for (const [xpath, el2] of elements2) {
    if (!elements1.has(xpath)) {
      added.push(el2);
    } else {
      const el1 = elements1.get(xpath);
      const differences = findElementDifferences(el1, el2);
      if (differences.length > 0) {
        modified.push({ element: el2, differences });
      }
    }
  }
  
  // Find removed elements
  for (const [xpath, el1] of elements1) {
    if (!elements2.has(xpath)) {
      removed.push(el1);
    }
  }
  
  return { added, removed, modified };
}

// Find differences between two elements
function findElementDifferences(el1, el2) {
  const differences = [];
  const keysToCompare = ['tagName', 'id', 'className', 'textContent', 'visible', 'dimensions'];
  
  for (const key of keysToCompare) {
    if (el1[key] !== el2[key]) {
      differences.push({
        property: key,
        oldValue: el1[key],
        newValue: el2[key]
      });
    }
  }
  
  return differences;
}

// Display comparison results
function displayComparisonResults(comparison, report1, report2) {
  const resultsDiv = document.getElementById('comparison-results');
  
  const summaryHTML = `
    <div class="comparison-summary">
      <h3>Comparison Summary</h3>
      <div class="summary-item">
        <span class="summary-label">Report 1:</span>
        <span class="summary-value">${report1.url}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Report 2:</span>
        <span class="summary-value">${report2.url}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Elements Added:</span>
        <span class="summary-value">${comparison.added.length}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Elements Removed:</span>
        <span class="summary-value">${comparison.removed.length}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Elements Modified:</span>
        <span class="summary-value">${comparison.modified.length}</span>
      </div>
    </div>
  `;
  
  let differencesHTML = '<div class="differences"><h3>Differences</h3>';
  
  // Added elements
  if (comparison.added.length > 0) {
    comparison.added.slice(0, 20).forEach(el => {
      differencesHTML += `
        <div class="difference-item added">
          <div class="difference-label">Added: ${el.tagName}${el.id ? '#' + el.id : ''}</div>
          <div class="difference-detail">XPath: ${el.xpath}</div>
        </div>
      `;
    });
    if (comparison.added.length > 20) {
      differencesHTML += `<p style="color: #666; font-size: 11px; padding: 10px;">... and ${comparison.added.length - 20} more added elements</p>`;
    }
  }
  
  // Removed elements
  if (comparison.removed.length > 0) {
    comparison.removed.slice(0, 20).forEach(el => {
      differencesHTML += `
        <div class="difference-item removed">
          <div class="difference-label">Removed: ${el.tagName}${el.id ? '#' + el.id : ''}</div>
          <div class="difference-detail">XPath: ${el.xpath}</div>
        </div>
      `;
    });
    if (comparison.removed.length > 20) {
      differencesHTML += `<p style="color: #666; font-size: 11px; padding: 10px;">... and ${comparison.removed.length - 20} more removed elements</p>`;
    }
  }
  
  // Modified elements
  if (comparison.modified.length > 0) {
    comparison.modified.slice(0, 20).forEach(item => {
      const el = item.element;
      const diffs = item.differences.map(d => 
        `${d.property}: "${d.oldValue}" → "${d.newValue}"`
      ).join(', ');
      
      differencesHTML += `
        <div class="difference-item modified">
          <div class="difference-label">Modified: ${el.tagName}${el.id ? '#' + el.id : ''}</div>
          <div class="difference-detail">${diffs}</div>
        </div>
      `;
    });
    if (comparison.modified.length > 20) {
      differencesHTML += `<p style="color: #666; font-size: 11px; padding: 10px;">... and ${comparison.modified.length - 20} more modified elements</p>`;
    }
  }
  
  if (comparison.added.length === 0 && comparison.removed.length === 0 && comparison.modified.length === 0) {
    differencesHTML += '<p style="color: #666; padding: 10px;">No differences found between the reports.</p>';
  }
  
  differencesHTML += '</div>';
  
  resultsDiv.innerHTML = summaryHTML + differencesHTML;
}

import logger from '../../infrastructure/logger.js';

function exportToCSV(comparisonResult) {
  try {
    const csvContent = _generateCSV(comparisonResult);
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `comparison-${comparisonResult.baseline.id}-vs-${comparisonResult.compare.id}.csv`;
    a.click();
    
    URL.revokeObjectURL(url);
    
    logger.info('CSV export complete');
    return { success: true };
  } catch (error) {
    logger.error('CSV export failed', { error: error.message });
    return { success: false, error: error.message };
  }
}

function _generateCSV(result) {
  const rows = [];
  
  rows.push(['# COMPARISON SUMMARY']);
  rows.push(['Baseline ID', result.baseline.id]);
  rows.push(['Baseline URL', result.baseline.url]);
  rows.push(['Compare ID', result.compare.id]);
  rows.push(['Compare URL', result.compare.url]);
  rows.push(['Mode', result.mode]);
  rows.push(['Match Rate', `${result.matching.matchRate}%`]);
  rows.push(['Total Differences', result.comparison.summary.totalDifferences]);
  rows.push([]);
  
  rows.push(['# SEVERITY COUNTS']);
  rows.push(['Critical', result.comparison.summary.severityCounts.critical]);
  rows.push(['High', result.comparison.summary.severityCounts.high]);
  rows.push(['Medium', result.comparison.summary.severityCounts.medium]);
  rows.push(['Low', result.comparison.summary.severityCounts.low]);
  rows.push([]);
  
  rows.push(['# DIFFERENCES']);
  rows.push([
    'Element ID',
    'Tag Name',
    'Property',
    'Baseline Value',
    'Compare Value',
    'Type',
    'Category',
    'Severity'
  ]);
  
  for (const match of result.comparison.results) {
    if (match.differences && match.differences.length > 0) {
      for (const diff of match.differences) {
        rows.push([
          match.elementId,
          match.tagName,
          diff.property,
          _escapeCSV(diff.baseValue || ''),
          _escapeCSV(diff.compareValue || ''),
          diff.type,
          diff.category,
          diff.severity
        ]);
      }
    }
  }
  
  return rows.map(row => row.join(',')).join('\n');
}

function _escapeCSV(value) {
  if (typeof value !== 'string') {
    return value;
  }
  
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  
  return value;
}

export { exportToCSV };
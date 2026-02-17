import logger from '../../infrastructure/logger.js';

function getXLSX() {
  const XLSX = globalThis.XLSX;
  if (!XLSX) {
    throw new Error('XLSX library not loaded. Ensure libs/xlsx.full.min.js is included before popup.js.');
  }
  return XLSX;
}

function exportToExcel(comparisonResult) {
  try {
    const XLSX = getXLSX();
    const wb = XLSX.utils.book_new();

    _addSummarySheet(wb, comparisonResult, XLSX);
    _addMatchedElementsSheet(wb, comparisonResult, XLSX);
    _addDifferencesSheet(wb, comparisonResult, XLSX);
    _addUnmatchedSheet(wb, comparisonResult, XLSX);
    _addSeveritySheet(wb, comparisonResult, XLSX);

    const filename = `comparison-${comparisonResult.baseline.id}-vs-${comparisonResult.compare.id}.xlsx`;
    XLSX.writeFile(wb, filename);

    logger.info('Excel export complete', { filename });
    return { success: true, filename };
  } catch (error) {
    logger.error('Excel export failed', { error: error.message });
    return { success: false, error: error.message };
  }
}

function _addSummarySheet(wb, result, XLSX) {
  const data = [
    ['Comparison Summary', ''],
    ['', ''],
    ['Baseline Report', ''],
    ['  ID', result.baseline.id],
    ['  URL', result.baseline.url],
    ['  Title', result.baseline.title],
    ['  Timestamp', result.baseline.timestamp],
    ['  Total Elements', result.baseline.totalElements],
    ['', ''],
    ['Compare Report', ''],
    ['  ID', result.compare.id],
    ['  URL', result.compare.url],
    ['  Title', result.compare.title],
    ['  Timestamp', result.compare.timestamp],
    ['  Total Elements', result.compare.totalElements],
    ['', ''],
    ['Comparison Settings', ''],
    ['  Mode', result.mode],
    ['  Duration (ms)', result.duration],
    ['', ''],
    ['Matching Statistics', ''],
    ['  Total Matched', result.matching.totalMatched],
    ['  Match Rate', `${result.matching.matchRate}%`],
    ['  Unmatched Baseline', result.matching.unmatchedBaseline],
    ['  Unmatched Compare', result.matching.unmatchedCompare],
    ['', ''],
    ['Comparison Results', ''],
    ['  Total Elements', result.comparison.summary.totalElements],
    ['  Unchanged Elements', result.comparison.summary.unchangedElements],
    ['  Modified Elements', result.comparison.summary.modifiedElements],
    ['  Total Differences', result.comparison.summary.totalDifferences],
    ['', ''],
    ['Severity Breakdown', ''],
    ['  Critical', result.comparison.summary.severityCounts.critical],
    ['  High', result.comparison.summary.severityCounts.high],
    ['  Medium', result.comparison.summary.severityCounts.medium],
    ['  Low', result.comparison.summary.severityCounts.low]
  ];

  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 30 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Summary');
}

function _addMatchedElementsSheet(wb, result, XLSX) {
  const headers = [
    'Element ID', 'Tag Name', 'Element ID Attr', 'Class Name',
    'Match Strategy', 'Match Confidence', 'Total Differences', 'Overall Severity'
  ];

  const rows = result.comparison.results.map(r => [
    r.elementId,
    r.tagName,
    r.baselineElement?.elementId || '',
    r.baselineElement?.className || '',
    r.strategy,
    r.confidence.toFixed(2),
    r.totalDifferences,
    r.overallSeverity || 'none'
  ]);

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [
    { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 25 },
    { wch: 18 }, { wch: 16 }, { wch: 18 }, { wch: 16 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Matched Elements');
}

function _addDifferencesSheet(wb, result, XLSX) {
  const headers = [
    'Element ID', 'Tag Name', 'Property',
    'Baseline Value', 'Compare Value', 'Type', 'Category', 'Severity'
  ];

  const rows = [];
  for (const match of result.comparison.results) {
    for (const diff of (match.differences || [])) {
      rows.push([
        match.elementId, match.tagName, diff.property,
        diff.baseValue || '', diff.compareValue || '',
        diff.type, diff.category, diff.severity
      ]);
    }
  }

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [
    { wch: 12 }, { wch: 12 }, { wch: 25 },
    { wch: 30 }, { wch: 30 }, { wch: 12 }, { wch: 15 }, { wch: 12 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Differences');
}

function _addUnmatchedSheet(wb, result, XLSX) {
  const headers = ['Source', 'Element ID', 'Tag Name', 'Element ID Attr', 'Class Name'];
  const rows = [];

  for (const el of result.unmatchedElements.baseline) {
    rows.push(['REMOVED (Baseline only)', el.id, el.tagName, el.elementId || '', el.className || '']);
  }
  for (const el of result.unmatchedElements.compare) {
    rows.push(['ADDED (Compare only)', el.id, el.tagName, el.elementId || '', el.className || '']);
  }

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [{ wch: 25 }, { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 25 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Unmatched Elements');
}

function _addSeveritySheet(wb, result, XLSX) {
  const groups = { critical: [], high: [], medium: [], low: [] };

  for (const match of result.comparison.results) {
    for (const diff of (match.differences || [])) {
      groups[diff.severity]?.push({
        elementId: match.elementId,
        tagName: match.tagName,
        property: diff.property,
        baseValue: diff.baseValue,
        compareValue: diff.compareValue
      });
    }
  }

  const data = [['Severity Analysis', ''], ['', '']];

  for (const severity of ['critical', 'high', 'medium', 'low']) {
    const items = groups[severity];
    data.push([`${severity.toUpperCase()} (${items.length})`, '']);
    if (items.length > 0) {
      data.push(['Element ID', 'Tag', 'Property', 'Baseline', 'Compare']);
      for (const item of items) {
        data.push([item.elementId, item.tagName, item.property, item.baseValue || '', item.compareValue || '']);
      }
    }
    data.push(['', '']);
  }

  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 25 }, { wch: 30 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, ws, 'By Severity');
}

export { exportToExcel };
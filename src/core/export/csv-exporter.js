import logger from '../../infrastructure/logger.js';

const UTF8_BOM = '\uFEFF';

function exportToCSV(comparisonResult) {
  try {
    const csvContent = UTF8_BOM + _generateCSV(comparisonResult);
    const blob       = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url        = URL.createObjectURL(blob);
    const filename   = `comparison-${comparisonResult.baseline.id}-vs-${comparisonResult.compare.id}.csv`;

    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    logger.info('CSV export complete', { filename });
    return { success: true };
  } catch (error) {
    logger.error('CSV export failed', { error: error.message });
    return { success: false, error: error.message };
  }
}

function _generateCSV(result) {
  const s    = result.comparison.summary;
  const rows = [];

  rows.push(['COMPARISON SUMMARY']);
  rows.push(['Baseline ID',        result.baseline.id]);
  rows.push(['Baseline URL',       result.baseline.url]);
  rows.push(['Baseline Title',     result.baseline.title]);
  rows.push(['Baseline Elements',  result.baseline.totalElements]);
  rows.push(['Compare ID',         result.compare.id]);
  rows.push(['Compare URL',        result.compare.url]);
  rows.push(['Compare Title',      result.compare.title]);
  rows.push(['Compare Elements',   result.compare.totalElements]);
  rows.push(['Mode',               result.mode]);
  rows.push(['Duration (ms)',      result.duration]);
  rows.push(['Match Rate',         `${result.matching.matchRate}%`]);
  rows.push(['Total Matched',      result.matching.totalMatched]);
  rows.push(['Unmatched Baseline', result.matching.unmatchedBaseline]);
  rows.push(['Unmatched Compare',  result.matching.unmatchedCompare]);
  rows.push([]);

  rows.push(['SEVERITY BREAKDOWN']);
  rows.push(['Critical',           s.severityCounts.critical]);
  rows.push(['High',               s.severityCounts.high]);
  rows.push(['Medium',             s.severityCounts.medium]);
  rows.push(['Low',                s.severityCounts.low]);
  rows.push(['Total Differences',  s.totalDifferences]);
  rows.push(['Modified Elements',  s.modifiedElements]);
  rows.push(['Unchanged Elements', s.unchangedElements]);
  rows.push([]);

  rows.push(['DIFFERENCES']);
  rows.push([
    'HPID',
    'Absolute Index',
    'Tag Name',
    'Element ID',
    'Class Name',
    'Text Content',
    'Tier',
    'Depth',
    'XPath',
    'CSS Selector',
    'Property',
    'Category',
    'Baseline Value',
    'Compare Value',
    'Severity',
    'Diff Type'
  ]);

  for (const match of result.comparison.results) {
    const el  = match.baselineElement ?? {};
    const sel = el.selectors ?? match.selectors ?? {};

    for (const diff of (match.annotatedDifferences || [])) {
      rows.push([
        el.hpid            ?? match.hpid            ?? '',
        el.absoluteIndex   ?? match.absoluteIndex   ?? '',
        el.tagName         ?? match.tagName         ?? '',
        el.elementId       ?? match.elementId       ?? '',
        el.className       ?? match.className       ?? '',
        el.textContent     ?? '',
        el.tier            ?? '',
        el.depth           ?? '',
        sel.xpath          ?? '',
        sel.css            ?? '',
        diff.property,
        diff.category,
        diff.baseValue     ?? '',
        diff.compareValue  ?? '',
        diff.severity,
        diff.type
      ]);
    }
  }

  rows.push([]);
  rows.push(['UNMATCHED ELEMENTS']);
  rows.push([
    'Status',
    'HPID',
    'Absolute Index',
    'Tag Name',
    'Element ID',
    'Class Name',
    'Text Content',
    'Tier',
    'Depth',
    'XPath',
    'CSS Selector'
  ]);

  for (const el of result.unmatchedElements.baseline) {
    const sel = el.selectors ?? {};
    rows.push([
      'REMOVED',
      el.hpid          ?? '',
      el.absoluteIndex ?? '',
      el.tagName       ?? '',
      el.elementId     ?? '',
      el.className     ?? '',
      el.textContent   ?? '',
      el.tier          ?? '',
      el.depth         ?? '',
      sel.xpath        ?? '',
      sel.css          ?? ''
    ]);
  }

  for (const el of result.unmatchedElements.compare) {
    const sel = el.selectors ?? {};
    rows.push([
      'ADDED',
      el.hpid          ?? '',
      el.absoluteIndex ?? '',
      el.tagName       ?? '',
      el.elementId     ?? '',
      el.className     ?? '',
      el.textContent   ?? '',
      el.tier          ?? '',
      el.depth         ?? '',
      sel.xpath        ?? '',
      sel.css          ?? ''
    ]);
  }

  return rows.map(row => row.map(_escape).join(',')).join('\n');
}

function _escape(value) {
  if (value === null || value === undefined) { return ''; }
  if (typeof value === 'number' || typeof value === 'boolean') { return String(value); }
  const str  = String(value);
  const safe = /^[=+\-@]/.test(str) ? `'${str}` : str;
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n') || safe.includes('\r')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export { exportToCSV };
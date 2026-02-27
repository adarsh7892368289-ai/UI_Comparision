import logger              from '../../infrastructure/logger.js';
import { rowsToCsv }       from './csv-utils.js';
import { triggerDownload } from './download-trigger.js';

const UTF8_BOM = '\uFEFF';

function buildComparisonCsv(result) {
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
    'HPID', 'Absolute HPID', 'Tag Name', 'Element ID', 'Class Name',
    'Text Content', 'Tier', 'Depth',
    'CSS Selector', 'XPath',
    'Property', 'Category', 'Baseline Value', 'Compare Value', 'Severity', 'Diff Type'
  ]);

  for (const match of result.comparison.results) {
    const el = match.baselineElement ?? {};
    for (const diff of (match.annotatedDifferences || [])) {
      rows.push([
        el.hpid         ?? '',
        el.absoluteHpid ?? '',
        el.tagName      ?? '',
        el.elementId    ?? '',
        el.className    ?? '',
        el.textContent  ?? '',
        el.tier         ?? '',
        el.depth        ?? '',
        el.cssSelector  ?? '',
        el.xpath        ?? '',
        diff.property,
        diff.category,
        diff.baseValue    ?? '',
        diff.compareValue ?? '',
        diff.severity,
        diff.type
      ]);
    }
  }

  rows.push([]);
  rows.push(['UNMATCHED ELEMENTS']);
  rows.push([
    'Status', 'HPID', 'Absolute HPID', 'Tag Name', 'Element ID',
    'Class Name', 'Text Content', 'Tier', 'Depth', 'CSS Selector', 'XPath'
  ]);

  for (const el of result.unmatchedElements.baseline) {
    rows.push([
      'REMOVED', el.hpid ?? '', el.absoluteHpid ?? '', el.tagName ?? '',
      el.elementId ?? '', el.className ?? '', el.textContent ?? '',
      el.tier ?? '', el.depth ?? '', el.cssSelector ?? '', el.xpath ?? ''
    ]);
  }

  for (const el of result.unmatchedElements.compare) {
    rows.push([
      'ADDED', el.hpid ?? '', el.absoluteHpid ?? '', el.tagName ?? '',
      el.elementId ?? '', el.className ?? '', el.textContent ?? '',
      el.tier ?? '', el.depth ?? '', el.cssSelector ?? '', el.xpath ?? ''
    ]);
  }

  return UTF8_BOM + rowsToCsv(rows);
}

function exportComparisonToCsv(result) {
  try {
    const csv      = buildComparisonCsv(result);
    const filename = `comparison-${result.baseline.id}-vs-${result.compare.id}.csv`;
    triggerDownload(csv, 'text/csv;charset=utf-8;', filename);
    logger.info('Comparison CSV export complete', { filename });
    return { success: true, filename };
  } catch (err) {
    logger.error('Comparison CSV export failed', { error: err.message });
    return { success: false, error: err.message };
  }
}

export { buildComparisonCsv, exportComparisonToCsv };
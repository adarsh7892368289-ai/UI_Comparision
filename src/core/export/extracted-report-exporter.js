import { get }           from '../../config/defaults.js';
import { rowsToCsv }     from './csv-utils.js';

const UTF8_BOM         = '\uFEFF';
const CSV_TEXT_MAX     = 200;

function buildExtractedReportCsv(report) {
  const cssProperties = get('extraction.cssProperties', []);
  const rows          = [];

  rows.push(['REPORT METADATA']);
  rows.push(['Report ID',       report.id]);
  rows.push(['URL',             report.url]);
  rows.push(['Title',           report.title]);
  rows.push(['Timestamp',       report.timestamp]);
  rows.push(['Total Elements',  report.totalElements]);
  rows.push(['Duration (ms)',   report.duration       ?? 'N/A']);
  rows.push(['Capture Quality', report.captureQuality ?? 'N/A']);
  rows.push([]);

  const filters = report.filters;
  if (filters && Object.values(filters).some(Boolean)) {
    rows.push(['FILTERS APPLIED']);
    rows.push(['Class Filter', filters.class || 'none']);
    rows.push(['ID Filter',    filters.id    || 'none']);
    rows.push(['Tag Filter',   filters.tag   || 'none']);
    rows.push([]);
  }

  const schema = report.extractOptions?.schema;
  if (schema) {
    rows.push(['SCHEMA OPTIONS']);
    rows.push(['Styles',         schema.includeStyles         ?? false]);
    rows.push(['Attributes',     schema.includeAttributes     ?? false]);
    rows.push(['Rect',           schema.includeRect           ?? false]);
    rows.push(['Neighbours',     schema.includeNeighbours     ?? false]);
    rows.push(['Class Hierarchy', schema.includeClassHierarchy ?? false]);
    rows.push([]);
  }

  rows.push(['EXTRACTED ELEMENTS']);

  const headers = [
    'HPID',
    'Absolute HPID',
    'Tag Name',
    'Element ID',
    'Class Name',
    'Class Occurrence Count',
    'Text Content',
    'CSS Selector',
    'XPath',
    'Shadow Path',
    'Rect X',
    'Rect Y',
    'Rect Top',
    'Rect Left',
    'Width',
    'Height',
    'Display',
    'Visibility',
    'Opacity',
    'Tier',
    'Depth',
    'Page Section',
    'Class Hierarchy',
    'Neighbours',
    ...cssProperties
  ];
  rows.push(headers);

  for (const el of (report.elements || [])) {
    const styleValues = cssProperties.map(prop => el.styles?.[prop] ?? '');

    rows.push([
      el.hpid                ?? '',
      el.absoluteHpid        ?? '',
      el.tagName             ?? '',
      el.elementId           ?? '',
      el.className           ?? '',
      el.classOccurrenceCount ?? 0,
      (el.textContent ?? '').substring(0, CSV_TEXT_MAX),
      el.cssSelector         ?? '',
      el.xpath               ?? '',
      el.shadowPath          ?? '',
      el.rect?.x             ?? '',
      el.rect?.y             ?? '',
      el.rect?.top           ?? '',
      el.rect?.left          ?? '',
      el.rect?.width         ?? '',
      el.rect?.height        ?? '',
      el.styles?.display     ?? '',
      el.styles?.visibility  ?? '',
      el.styles?.opacity     ?? '',
      el.tier                ?? '',
      el.depth               ?? '',
      el.pageSection         ?? '',
      el.classHierarchy ? JSON.stringify(el.classHierarchy) : '',
      el.neighbours     ? JSON.stringify(el.neighbours)     : '',
      ...styleValues
    ]);
  }

  return UTF8_BOM + rowsToCsv(rows);
}

function buildExtractedReportJson(report) {
  return JSON.stringify(report, null, 2);
}

function buildAllExtractedReportsCsv(reports) {
  const sections = reports.map((report, i) =>
    `## ===== REPORT ${i + 1} of ${reports.length} =====\n${buildExtractedReportCsv(report).replace(UTF8_BOM, '')}`
  );
  return UTF8_BOM + sections.join('\n\n');
}

function buildAllExtractedReportsJson(reports) {
  return JSON.stringify(reports, null, 2);
}

export {
  buildExtractedReportCsv,
  buildExtractedReportJson,
  buildAllExtractedReportsCsv,
  buildAllExtractedReportsJson
};
import { get } from '../config/defaults.js';
import logger from '../infrastructure/logger.js';
import { isValidReport, loadAllReports, saveReport } from './report-manager.js';

const ELEMENT_HEADER_ANCHORS = new Set(['hpid', 'tag name', 'css selector', 'xpath', 'absolute hpid']);
const MIN_ANCHOR_MATCHES     = 2;

function _parseVersion(versionStr) {
  const parts = (versionStr ?? '0.0').split('.');
  return { major: parseInt(parts[0], 10) || 0, minor: parseInt(parts[1], 10) || 0 };
}

function _versionAtLeast(versionStr, minStr) {
  const subject = _parseVersion(versionStr);
  const minimum = _parseVersion(minStr);
  if (subject.major !== minimum.major) return subject.major > minimum.major;
  return subject.minor >= minimum.minor;
}

function _detectFormat(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'json')                  return 'json';
  if (ext === 'csv')                   return 'csv';
  if (ext === 'xlsx' || ext === 'xls') return 'excel';
  return null;
}

function _safeJsonParse(cell) {
  if (!cell || !String(cell).trim()) return undefined;
  try { return JSON.parse(cell); } catch { return undefined; }
}

function _looksLikeElementHeader(record) {
  let matches = 0;
  for (const cell of record) {
    if (ELEMENT_HEADER_ANCHORS.has(String(cell).trim().toLowerCase())) matches++;
    if (matches >= MIN_ANCHOR_MATCHES) return true;
  }
  return false;
}

const REQUIRED_COLUMNS    = ['hpid', 'tag name'];
const RECOMMENDED_COLUMNS = ['css selector', 'xpath'];

function _validateColumns(headerIndex) {
  const missing = REQUIRED_COLUMNS.filter(col => !(col in headerIndex));
  if (missing.length > 0) {
    const display = missing.map(c => c.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' '));
    return {
      valid: false,
      error: `Missing required columns: ${display.join(', ')}. These are needed for element matching — without them comparison produces no results.`
    };
  }
  const missingRec = RECOMMENDED_COLUMNS.filter(col => !(col in headerIndex));
  return {
    valid: true,
    warning: missingRec.length > 0
      ? `Missing recommended columns: ${missingRec.map(c => c.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')).join(', ')}. Fallback matching phases will be skipped.`
      : null
  };
}

function _makeHeaderIndex(headers) {
  const index = {};
headers.forEach((h, i) => {
    const key = String(h).trim().toLowerCase();
    if (!(key in index)) index[key] = i;
  });
  return index;
}

function _parseRect(headerIndex, row) {
  const fields = [
    ['rect x', 'x'], ['rect y', 'y'], ['rect top', 'top'], ['rect left', 'left'],
    ['width', 'width'], ['height', 'height']
  ];
  const rect   = {};
  let hasAny   = false;
  for (const [col, key] of fields) {
    const idx = headerIndex[col];
    if (idx === undefined) continue;
    const raw = row[idx];
    if (raw !== '' && raw != null) { rect[key] = Number(raw); hasAny = true; }
  }
  return hasAny ? rect : undefined;
}

function _splitCsvRecords(text) {
  const records = [];
  let record    = [];
  let cell      = '';
  let inQuotes  = false;

  for (let i = 0; i < text.length; i++) {
    const ch   = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { cell += '"'; i++; }
      else if (ch === '"')            { inQuotes = false; }
      else                            { cell += ch; }
    } else {
      if      (ch === '"')                   { inQuotes = true; }
      else if (ch === ',')                   { record.push(cell); cell = ''; }
      else if (ch === '\r' && next === '\n') { record.push(cell); cell = ''; records.push(record); record = []; i++; }
      else if (ch === '\n')                  { record.push(cell); cell = ''; records.push(record); record = []; }
      else                                   { cell += ch; }
    }
  }
  record.push(cell);
  if (record.some(c => c !== '')) records.push(record);
  return records;
}

function _buildElementFromRow(headerIndex, row, cssProperties) {
  const col = (name) => {
    const idx = headerIndex[name.toLowerCase()];
    return idx !== undefined ? (row[idx] ?? '') : '';
  };

  const el = {
    hpid:                 col('HPID')                    || undefined,
    absoluteHpid:         col('Absolute HPID')           || undefined,
    tagName:              col('Tag Name')                 || undefined,
    elementId:            col('Element ID')              || undefined,
    className:            col('Class Name')              || undefined,
    classOccurrenceCount: col('Class Occurrence Count') !== '' ? Number(col('Class Occurrence Count')) : undefined,
    textContent:          col('Text Content')             || undefined,
    cssSelector:          col('CSS Selector')             || undefined,
    xpath:                col('XPath')                    || undefined,
    shadowPath:           col('Shadow Path')              || undefined,
    tier:                 col('Tier')                     || undefined,
    depth:                col('Depth') !== '' ? Number(col('Depth')) : undefined,
    pageSection:          col('Page Section')             || undefined,
    classHierarchy:       _safeJsonParse(col('Class Hierarchy')),
    neighbours:           _safeJsonParse(col('Neighbours')),
    attributes:           _safeJsonParse(col('Attributes')),
    rect:                 _parseRect(headerIndex, row)
  };

  const styles = {};
  cssProperties.forEach(prop => {
    const idx = headerIndex[prop.toLowerCase()];
    if (idx === undefined) return;
    const val = row[idx];
    if (val !== '' && val != null) styles[prop] = String(val);
  });
  if (Object.keys(styles).length > 0) el.styles = styles;

  Object.keys(el).forEach(k => { if (el[k] === undefined) delete el[k]; });
  return el;
}

function _buildReportFromMeta(metaMap, elements) {
  const get = (key) => metaMap[key] ?? metaMap[key.toLowerCase()] ?? metaMap[key.toUpperCase()] ?? '';
  return {
    id:             get('Report ID')      || String(Date.now()),
    version:        get('Version')        || '3.0',
    url:            get('URL')            || '',
    title:          get('Title')          || 'Untitled',
    timestamp:      get('Timestamp')      || new Date().toISOString(),
    totalElements:  elements.length,
    duration:       Number(get('Duration (ms)') || 0),
    captureQuality: get('Capture Quality')       || undefined,
    filters:        _safeJsonParse(get('Filters'))         ?? null,
    extractOptions: _safeJsonParse(get('Extract Options')) ?? null,
    elements
  };
}

function _parseCsv(text) {
  const cssProperties = get('extraction.cssProperties', []);
  const raw           = text.replace(/^\uFEFF/, '');
  const records       = _splitCsvRecords(raw);

  if (records.length === 0) {
    return { success: false, error: 'CSV file is empty or unreadable' };
  }

  // Scan all records to find the header row (by recognising element column names)
  // and collect any key/value metadata rows found before it
  const metaMap  = {};
  let headerIdx  = -1;

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (_looksLikeElementHeader(rec)) {
      headerIdx = i;
      break;
    }
    // Treat as metadata if it has a non-empty key and value
    if (rec.length >= 2 && rec[0] && rec[1] !== undefined && rec[1] !== '') {
      metaMap[rec[0].trim()] = rec[1];
    }
  }

  if (headerIdx === -1) {
    return { success: false, error: 'Could not find element columns — expected headers like HPID, Tag Name, CSS Selector' };
  }

  const headerIndex  = _makeHeaderIndex(records[headerIdx]);
  const colCheck     = _validateColumns(headerIndex);
  if (!colCheck.valid) return { success: false, error: colCheck.error };

  const elements = [];
  for (let i = headerIdx + 1; i < records.length; i++) {
    const row = records[i];
    if (row.every(c => c === '')) continue;
    elements.push(_buildElementFromRow(headerIndex, row, cssProperties));
  }

  return { success: true, warning: colCheck.warning, report: _buildReportFromMeta(metaMap, elements) };
}

function _parseExcel(buffer) {
  const XLSX = globalThis.XLSX;
  if (!XLSX) return { success: false, error: 'Excel support unavailable — try JSON format' };

  const cssProperties = get('extraction.cssProperties', []);
  const wb            = XLSX.read(buffer, { type: 'array' });

  if (wb.SheetNames.length === 0) {
    return { success: false, error: 'Excel file contains no sheets' };
  }

  // Read metadata from 'Metadata' sheet if present — not required
  const metaMap = {};
  const metaWs  = wb.Sheets['Metadata'];
  if (metaWs) {
    const metaRows = XLSX.utils.sheet_to_json(metaWs, { header: 1 });
    for (const row of metaRows) {
      if (row[0] && row[1] !== undefined) metaMap[String(row[0]).trim()] = String(row[1] ?? '');
    }
  }

  // Find element sheet — prefer 'Elements' by name, then scan all other sheets
  // for a header row that passes the element column check
  let elemWs = wb.Sheets['Elements'];

  if (!elemWs) {
    for (const name of wb.SheetNames) {
      if (name === 'Metadata') continue;
      const ws      = wb.Sheets[name];
      const preview = XLSX.utils.sheet_to_json(ws, { header: 1, range: 0 });
      if (preview.length > 0 && _looksLikeElementHeader(preview[0].map(String))) {
        elemWs = ws;
        break;
      }
    }
  }

  if (!elemWs) {
    return { success: false, error: 'Could not find element data — expected a sheet with columns like HPID, Tag Name, CSS Selector' };
  }

  const elemRows = XLSX.utils.sheet_to_json(elemWs, { defval: '' });
  if (elemRows.length === 0) return { success: true, warning: null, report: _buildReportFromMeta(metaMap, []) };

  const firstHeaderIndex = _makeHeaderIndex(Object.keys(elemRows[0]));
  const colCheck         = _validateColumns(firstHeaderIndex);
  if (!colCheck.valid) return { success: false, error: colCheck.error };

  const elements = elemRows.map(rowObj => {
    const headerIndex = _makeHeaderIndex(Object.keys(rowObj));
    const row         = Object.values(rowObj);
    return _buildElementFromRow(headerIndex, row, cssProperties);
  });

  return { success: true, warning: colCheck.warning, report: _buildReportFromMeta(metaMap, elements) };
}

async function importReportFromFile(file, { forceReplace = false } = {}) {
  if (file.size === 0) {
    return { success: false, error: 'File is empty' };
  }
  if (file.size > 50 * 1024 * 1024) {
    return { success: false, error: 'File too large — max 50 MB' };
  }

  const format = _detectFormat(file.name);
  if (!format) {
    return { success: false, error: 'Unsupported format — use JSON, CSV, or Excel' };
  }

  let parsed;
  let importWarning = null;

  try {
    if (format === 'json') {
      const text = await file.text();
      parsed = JSON.parse(text);
    } else if (format === 'csv') {
      const text   = await file.text();
      const result = _parseCsv(text);
      if (!result.success) return result;
      parsed        = result.report;
      importWarning = result.warning ?? null;
    } else {
      const buffer = await file.arrayBuffer();
      const result = _parseExcel(buffer);
      if (!result.success) return result;
      parsed        = result.report;
      importWarning = result.warning ?? null;
    }
  } catch {
    return { success: false, error: 'File could not be parsed — check it is a valid UI Compare report' };
  }

  // Always reconcile totalElements with actual parsed count — prevents
  // count-mismatch errors from partial exports or files without metadata
  if (Array.isArray(parsed.elements)) {
    parsed.totalElements = parsed.elements.length;
  }

  if (parsed.version && !_versionAtLeast(parsed.version, '3.0')) {
    return { success: false, error: 'Report version too old — must be 3.0 or higher' };
  }

  parsed.source  = 'imported';
  parsed.version = parsed.version ?? '3.0';

  const validation = isValidReport(parsed);
  if (!validation.valid) {
    return { success: false, error: validation.errors.join(', ') };
  }

  const existing  = await loadAllReports();
  const duplicate = existing.find(r => r.id === parsed.id);
  if (duplicate && !forceReplace) {
    return { success: false, isDuplicate: true, existingReport: duplicate, error: 'A report with this ID already exists' };
  }

  const result = await saveReport(parsed);
  if (!result.success) {
    return { success: false, error: result.error ?? 'Failed to save report' };
  }

  logger.info('Report imported from file', { id: parsed.id, format, elements: parsed.elements?.length ?? 0 });
  return { success: true, report: result.meta ?? parsed, warning: importWarning };
}

export { importReportFromFile };


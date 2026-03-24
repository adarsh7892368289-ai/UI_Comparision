/**
 * Thin orchestration layer for all export operations. Routes extraction reports and
 * comparison results to the appropriate format-specific exporter and triggers downloads.
 * Runs in the MV3 service worker.
 * Failure mode contained here: thrown errors from any exporter are caught and
 * normalised into {success:false} returns — callers receive a consistent contract
 * regardless of which formatter failed.
 * Callers: popup.js (exportComparison, exportReport, exportAllReports).
 */
import { exportComparisonToCsv } from '../core/export/comparison/csv-exporter.js';
import { exportToExcel } from '../core/export/comparison/excel-exporter.js';
import { exportToHTML } from '../core/export/comparison/html-exporter.js';
import { exportComparisonToJson } from '../core/export/comparison/json-exporter.js';
import {
  buildAllExtractedReportsCsv,
  buildAllExtractedReportsExcel,
  buildAllExtractedReportsJson,
  buildExtractedReportCsv,
  buildExtractedReportExcel,
  buildExtractedReportJson
} from '../core/export/extraction/report-exporter.js';
import { safeTimestamp } from '../core/export/shared/csv-utils.js';
import { triggerDownload } from '../core/export/shared/download-trigger.js';
import logger from '../infrastructure/logger.js';
import storage from '../infrastructure/idb-repository.js';
import { getReportById } from './report-manager.js';

/** Format options for comparison result exports (diff tables, severity summaries). */
const EXPORT_FORMAT = Object.freeze({
  EXCEL: 'excel',
  CSV:   'csv',
  HTML:  'html',
  JSON:  'json'
});

/**
 * Format options for extracted report exports (raw DOM element data).
 * Kept separate from EXPORT_FORMAT — the two use entirely different formatter chains
 * and must not be used interchangeably.
 */
const EXTRACTED_FORMAT = Object.freeze({
  JSON:  'json',
  CSV:   'csv',
  EXCEL: 'excel'
});

/**
 * Exports a single extraction report in the requested format and triggers a download.
 * Fetches the full report (with elements) from IDB first; falls back to the passed-in
 * metadata if the IDB read returns null, in which case elements may be absent.
 *
 * @param {Object} reportMeta - Report metadata record (id required).
 * @param {string} format - An EXTRACTED_FORMAT constant.
 */
async function exportReport(reportMeta, format) {
  const full = await getReportById(reportMeta.id);
  const data = full ?? reportMeta;

  if (format === EXTRACTED_FORMAT.EXCEL) {
    const result = buildExtractedReportExcel(data);
    if (result.success) {
      logger.info('Extracted report exported as Excel', { id: reportMeta.id, filename: result.filename, elements: data.elements?.length ?? 0 });
    } else {
      logger.error('Extracted report Excel export failed', { id: reportMeta.id, error: result.error });
    }
    return result;
  }

  if (format === EXTRACTED_FORMAT.JSON) {
    const json     = buildExtractedReportJson(data);
    const filename = `report-${reportMeta.id}-${safeTimestamp()}.json`;
    triggerDownload(json, 'application/json', filename);
    logger.info('Extracted report exported as JSON', { id: reportMeta.id, elements: data.elements?.length ?? 0 });
    return;
  }

  const csv      = buildExtractedReportCsv(data);
  const filename = `report-${reportMeta.id}-${safeTimestamp()}.csv`;
  triggerDownload(csv, 'text/csv;charset=utf-8;', filename);
  logger.info('Extracted report exported as CSV', { id: reportMeta.id, elements: data.elements?.length ?? 0 });
}

/**
 * Exports all saved extraction reports in the requested format as a single download.
 * Uses a sequential loop rather than Promise.all to avoid flooding IDB with concurrent
 * reads during a bulk operation that may overlap with in-flight writes.
 * The Excel path enforces a 50,000-element cap before calling the builder — the
 * underlying library silently truncates beyond practical row limits without erroring.
 *
 * @param {string} format - An EXTRACTED_FORMAT constant.
 * @returns {Promise<{success: boolean, count?: number, error?: string}>}
 */
async function exportAllReports(format) {
  const metas = await storage.loadReports();
  if (metas.length === 0) {
    return { success: false, error: 'No reports to export' };
  }

  const full = [];
  for (const meta of metas) {
    const report = await getReportById(meta.id);
    if (report) {full.push(report);}
  }

  if (format === EXTRACTED_FORMAT.EXCEL) {
    const totalElements = full.reduce((sum, r) => sum + (r.elements?.length ?? 0), 0);
    if (totalElements > 50_000) {
      logger.warn('Bulk Excel export aborted — element count too large', { totalElements });
      return {
        success: false,
        error: `Excel export limited to 50,000 elements total. Your ${full.length} reports contain ${totalElements.toLocaleString()} elements. Export individually or use JSON format.`
      };
    }
    const result = buildAllExtractedReportsExcel(full);
    if (!result.success) {return { success: false, error: result.error };}
    logger.info('All extracted reports exported as Excel', { count: full.length });
    return { success: true, count: full.length };
  }

  if (format === EXTRACTED_FORMAT.JSON) {
    const json     = buildAllExtractedReportsJson(full);
    const filename = `all-reports-${safeTimestamp()}.json`;
    triggerDownload(json, 'application/json', filename);
    logger.info('All extracted reports exported as JSON', { count: full.length });
    return { success: true, count: full.length };
  }

  const csv      = buildAllExtractedReportsCsv(full);
  const filename = `all-reports-${safeTimestamp()}.csv`;
  triggerDownload(csv, 'text/csv;charset=utf-8;', filename);
  logger.info('All extracted reports exported as CSV', { count: full.length });
  return { success: true, count: full.length };
}

/**
 * Exports a comparison result in the requested format. Catches errors from all
 * four formatters and returns {success:false} so callers get a consistent contract
 * regardless of which formatter failed or threw.
 *
 * @param {Object} comparisonResult - Full comparison result object.
 * @param {string} format - An EXPORT_FORMAT constant.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function exportComparison(comparisonResult, format) {
  logger.info('Comparison export requested', { format });

  try {
    switch (format) {
      case EXPORT_FORMAT.EXCEL: return await exportToExcel(comparisonResult);
      case EXPORT_FORMAT.CSV:   return exportComparisonToCsv(comparisonResult);
      case EXPORT_FORMAT.HTML:  return await exportToHTML(comparisonResult);
      case EXPORT_FORMAT.JSON:  return exportComparisonToJson(comparisonResult);
      default:
        throw new Error(`Unsupported export format: "${format}"`);
    }
  } catch (err) {
    logger.error('Comparison export failed', { format, error: err.message });
    return { success: false, error: err.message };
  }
}

export { EXPORT_FORMAT, exportAllReports, exportComparison, exportReport, EXTRACTED_FORMAT };
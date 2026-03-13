import logger                            from '../infrastructure/logger.js';
import { getReportById }                 from './report-manager.js';
import storage                           from '../infrastructure/storage.js';
import { triggerDownload }               from '../core/export/shared/download-trigger.js';
import { safeTimestamp }                 from '../core/export/shared/csv-utils.js';
import {
  buildExtractedReportCsv,
  buildExtractedReportJson,
  buildAllExtractedReportsCsv,
  buildAllExtractedReportsJson,
  buildExtractedReportExcel,
  buildAllExtractedReportsExcel
}                                        from '../core/export/extraction/report-exporter.js';
import { exportComparisonToCsv }         from '../core/export/comparison/csv-exporter.js';
import { exportComparisonToJson }        from '../core/export/comparison/json-exporter.js';
import { exportToExcel }                 from '../core/export/comparison/excel-exporter.js';
import { exportToHTML }                  from '../core/export/comparison/html-exporter.js';

const EXPORT_FORMAT = Object.freeze({
  EXCEL: 'excel',
  CSV:   'csv',
  HTML:  'html',
  JSON:  'json'
});

const EXTRACTED_FORMAT = Object.freeze({
  JSON:  'json',
  CSV:   'csv',
  EXCEL: 'excel'
});

async function exportReport(reportMeta, format) {
  const full = await getReportById(reportMeta.id);
  const data = full ?? reportMeta;

  if (format === EXTRACTED_FORMAT.EXCEL) {
    const result = buildExtractedReportExcel(data);
    // XLSX.writeFile is called internally — no triggerDownload needed
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

async function exportAllReports(format) {
  const metas = await storage.loadReports();
  if (metas.length === 0) {
    return { success: false, error: 'No reports to export' };
  }

  const full = [];
  for (const meta of metas) {
    const report = await getReportById(meta.id);
    if (report) full.push(report);
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
    if (!result.success) return { success: false, error: result.error };
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

export { exportReport, exportAllReports, exportComparison, EXPORT_FORMAT, EXTRACTED_FORMAT };
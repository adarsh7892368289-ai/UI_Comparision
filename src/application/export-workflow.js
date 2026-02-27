import logger                            from '../infrastructure/logger.js';
import { getReportById }                 from './report-manager.js';
import storage                           from '../infrastructure/storage.js';
import { triggerDownload }               from '../core/export/download-trigger.js';
import { safeTimestamp }                 from '../core/export/csv-utils.js';
import {
  buildExtractedReportCsv,
  buildExtractedReportJson,
  buildAllExtractedReportsCsv,
  buildAllExtractedReportsJson
}                                        from '../core/export/extracted-report-exporter.js';
import {
  exportComparison,
  EXPORT_FORMAT
}                                        from '../core/export/export-manager.js';

const EXTRACTED_FORMAT = Object.freeze({
  JSON: 'json',
  CSV:  'csv'
});

async function exportReport(reportMeta, format) {
  const full = await getReportById(reportMeta.id);
  const data = full ?? reportMeta;

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

export { exportReport, exportAllReports, exportComparison, EXPORT_FORMAT, EXTRACTED_FORMAT };
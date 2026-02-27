import logger                              from '../../infrastructure/logger.js';
import { exportComparisonToCsv }           from './comparison-csv-exporter.js';
import { exportComparisonToJson }          from './comparison-json-exporter.js';
import { exportToExcel }                   from './excel-exporter.js';
import { exportToHTML }                    from './html-exporter.js';

const EXPORT_FORMAT = Object.freeze({
  EXCEL: 'excel',
  CSV:   'csv',
  HTML:  'html',
  JSON:  'json'
});

async function exportComparison(comparisonResult, format) {
  logger.info('Comparison export requested', { format });

  try {
    switch (format) {
      case EXPORT_FORMAT.EXCEL: return await exportToExcel(comparisonResult);
      case EXPORT_FORMAT.CSV:   return exportComparisonToCsv(comparisonResult);
      case EXPORT_FORMAT.HTML:  return await exportToHTML(comparisonResult);
      case EXPORT_FORMAT.JSON:  return exportComparisonToJson(comparisonResult);
      default:
        throw new Error(`Unsupported comparison export format: "${format}"`);
    }
  } catch (err) {
    logger.error('Comparison export failed', { format, error: err.message });
    return { success: false, error: err.message };
  }
}

function getSupportedFormats() {
  return Object.values(EXPORT_FORMAT);
}

export { exportComparison, getSupportedFormats, EXPORT_FORMAT };
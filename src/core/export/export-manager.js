import logger from '../../infrastructure/logger.js';
import { exportToExcel } from './excel-exporter.js';
import { exportToCSV } from './csv-exporter.js';
import { exportToHTML } from './html-exporter.js';
import { exportToJSON } from './json-exporter.js';

const EXPORT_FORMATS = {
  EXCEL: 'excel',
  CSV: 'csv',
  HTML: 'html',
  JSON: 'json'
};

class ExportManager {
  async export(comparisonResult, format) {
    logger.info('Starting export', { format });

    try {
      let result;

      switch (format) {
        case EXPORT_FORMATS.EXCEL:
          result = await exportToExcel(comparisonResult);
          break;

        case EXPORT_FORMATS.CSV:
          result = await exportToCSV(comparisonResult);
          break;

        case EXPORT_FORMATS.HTML:
          result = await exportToHTML(comparisonResult);
          break;

        case EXPORT_FORMATS.JSON:
          result = exportToJSON(comparisonResult);
          break;

        default:
          throw new Error(`Unsupported export format: ${format}`);
      }

      if (result.success) {
        logger.info('Export completed successfully', { format });
      } else {
        logger.error('Export failed', { format, error: result.error });
      }

      return result;
    } catch (error) {
      logger.error('Export error', { format, error: error.message });
      return { success: false, error: error.message };
    }
  }

  getSupportedFormats() {
    return Object.values(EXPORT_FORMATS);
  }
}

export { ExportManager, EXPORT_FORMATS };
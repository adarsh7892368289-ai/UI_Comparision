import logger from '../../infrastructure/logger.js';
import { exportToExcel } from './excel-exporter.js';
import { exportToCSV } from './csv-exporter.js';
import { exportToHTML } from './html-exporter.js';

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
          result = this._exportToJSON(comparisonResult);
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

  _exportToJSON(comparisonResult) {
    try {
      const json     = JSON.stringify(comparisonResult, null, 2);
      const blob     = new Blob([json], { type: 'application/json' });
      const url      = URL.createObjectURL(blob);
      const filename = `comparison-${comparisonResult.baseline.id}-vs-${comparisonResult.compare.id}.json`;
      const a        = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  getSupportedFormats() {
    return Object.values(EXPORT_FORMATS);
  }
}

export { ExportManager, EXPORT_FORMATS };
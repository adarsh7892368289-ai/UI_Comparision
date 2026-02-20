import { get } from '../../config/defaults.js';

const URL_REVOKE_DELAY_MS = 1_000;  // ms to wait before revoking object URL after download
const ID_PREVIEW_LENGTH   = 8;      // first N chars of a UUID used in filename
const ISO_DATE_SLICE_END  = 19;     // 'YYYY-MM-DDTHH:mm:ss' — drops ms + Z

/**
 * json-exporter.js — Standalone JSON Export
 *
 * Pure function, no side effects beyond DOM anchor click.
 * Extracted from ExportManager._exportToJSON() to:
 *  - Enable independent unit testing
 *  - Allow external tools to consume the export pipeline
 *  - Respect SRP (ExportManager = router; this = format logic)
 */

/**
 * Serialise a comparison result and trigger a browser download.
 *
 * @param {Object} comparisonResult  Full result from comparator.compare()
 * @returns {{ success: boolean, error?: string }}
 */
function exportToJSON(comparisonResult) {
  try {
    const payload = _buildPayload(comparisonResult);
    const json    = JSON.stringify(payload, null, 2);
    const blob    = new Blob([json], { type: 'application/json' });
    const url     = URL.createObjectURL(blob);

    const filename = _buildFilename(comparisonResult);

    const a = Object.assign(document.createElement('a'), {
      href:     url,
      download: filename
    });

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Revoke after browser has had time to initiate the download
    setTimeout(() => URL.revokeObjectURL(url), URL_REVOKE_DELAY_MS);

    return { success: true, filename };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Build the export payload — strips runtime-only fields, adds metadata envelope.
 */
function _buildPayload(result) {
  return {
    exportVersion: '1.0',
    exportedAt:    new Date().toISOString(),
    baseline: {
      id:        result.baseline?.id,
      url:       result.baseline?.url,
      title:     result.baseline?.title,
      timestamp: result.baseline?.timestamp
    },
    compare: {
      id:        result.compare?.id,
      url:       result.compare?.url,
      title:     result.compare?.title,
      timestamp: result.compare?.timestamp
    },
    mode:      result.mode,
    duration:  result.duration,
    matching:  result.matching,
    comparison: {
      summary: result.comparison?.summary,
      results: result.comparison?.results ?? []
    },
    unmatchedElements: result.unmatchedElements
  };
}

function _buildFilename(result) {
  const base = get('export.defaultFilename', 'comparison-report');
  const bId  = result.baseline?.id?.slice(0, ID_PREVIEW_LENGTH) ?? 'unknown';
  const cId  = result.compare?.id?.slice(0,  ID_PREVIEW_LENGTH) ?? 'unknown';
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, ISO_DATE_SLICE_END);
  return `${base}-${bId}-vs-${cId}-${ts}.json`;
}

export { exportToJSON };
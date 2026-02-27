import { get } from '../../config/defaults.js';

const URL_REVOKE_DELAY_MS = 1_000;  
const ID_PREVIEW_LENGTH   = 8;      
const ISO_DATE_SLICE_END  = 19;     

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

    
    setTimeout(() => URL.revokeObjectURL(url), URL_REVOKE_DELAY_MS);

    return { success: true, filename };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function _buildPayload(result) {
  return {
    exportVersion: '1.0',
    exportedAt:    new Date().toISOString(),
    baseline: {
      id:            result.baseline?.id,
      url:           result.baseline?.url,
      pageUrl:       result.baseline?.pageUrl,
      title:         result.baseline?.title,
      pageTitle:     result.baseline?.pageTitle,
      extractedAt:   result.baseline?.extractedAt,
      timestamp:     result.baseline?.timestamp,
      totalElements: result.baseline?.totalElements,
      styleCategories: result.baseline?.styleCategories,
      extractOptions:  result.baseline?.extractOptions
    },
    compare: {
      id:            result.compare?.id,
      url:           result.compare?.url,
      pageUrl:       result.compare?.pageUrl,
      title:         result.compare?.title,
      pageTitle:     result.compare?.pageTitle,
      extractedAt:   result.compare?.extractedAt,
      timestamp:     result.compare?.timestamp,
      totalElements: result.compare?.totalElements,
      styleCategories: result.compare?.styleCategories,
      extractOptions:  result.compare?.extractOptions
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
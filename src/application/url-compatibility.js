/**
 * URL compatibility assessment for the pre-flight check in compare-workflow.js.
 * Classifies two URLs as COMPATIBLE, CAUTION, or INCOMPATIBLE based on path, hash,
 * and query param differences after stripping known tracking parameters.
 * Runs in the MV3 service worker.
 * Callers: compare-workflow.js (assessUrlCompatibility).
 */

// Matches tracking params by prefix (utm_) or exact key name (gclid, fbclid, etc.).
// Prefix patterns have no $ anchor; exact-match patterns do.
const TRACKING_PARAM_PATTERN = /^(utm_|gclid$|gad_source$|fbclid$|msclkid$|_ga$|_gl$)/i;

/**
 * Returns a new URL with all tracking query params removed. Clones before mutating
 * because searchParams.delete() modifies in place — mutating the caller's object
 * would corrupt the URLs mid-comparison.
 */
function stripTrackingParams(parsed) {
  const cleaned = new URL(parsed.toString());
  for (const key of [...cleaned.searchParams.keys()]) {
    if (TRACKING_PARAM_PATTERN.test(key)) {
      cleaned.searchParams.delete(key);
    }
  }
  return cleaned;
}

/**
 * Lowercases and strips a trailing slash from a pathname. Returns '/' for empty
 * pathnames so that bare-origin URLs (https://example.com, pathname='') compare
 * equal to https://example.com/.
 */
function normalizePath(pathname) {
  const lowered = pathname.toLowerCase().replace(/\/$/, '');
  return lowered.length > 0 ? lowered : '/';
}

/**
 * Returns a list of query param differences between baseline and compare URLs.
 * Two-pass approach: the first pass walks baseline params (detecting changed and
 * removed keys) and deletes each visited key from compMap; the second pass walks
 * the remaining compMap entries, which are params present only in compare.
 */
function collectQueryDiff(baseParams, compParams) {
  const compMap = new Map(compParams.entries());
  const diffs = [];

  for (const [k, v] of baseParams.entries()) {
    const compVal = compMap.get(k) ?? null;
    if (compVal !== v) {
      diffs.push({ key: k, baseline: v, compare: compVal });
    }
    compMap.delete(k);
  }

  for (const [k, v] of compMap) {
    diffs.push({ key: k, baseline: null, compare: v });
  }

  return diffs;
}

/**
 * Classifies the compatibility of two capture URLs after stripping tracking params.
 *
 * INCOMPATIBLE — paths differ or either URL is unparseable. compare-workflow.js
 *   throws PreFlightError and halts the comparison.
 * CAUTION — same path but hash or query params differ (e.g. different filter state).
 *   Comparison proceeds but preFlightWarning is attached to the result.
 * COMPATIBLE — URLs are identical after normalisation. Comparison proceeds silently.
 *
 * estimatedFalseNegatives is a reserved field, not yet computed.
 *
 * @param {string} baselineUrl
 * @param {string} compareUrl
 * @returns {{classification: string, baselineUrl: string, compareUrl: string, mismatchDelta: Object, estimatedFalseNegatives: null}}
 */
function assessUrlCompatibility(baselineUrl, compareUrl) {
  let baseParsed, compParsed;

  try {
    baseParsed = stripTrackingParams(new URL(baselineUrl));
    compParsed = stripTrackingParams(new URL(compareUrl));
  } catch {
    return {
      classification: 'INCOMPATIBLE',
      baselineUrl,
      compareUrl,
      mismatchDelta: {
        pathname: { baseline: baselineUrl, compare: compareUrl },
        hash: null,
        queryParams: null
      },
      estimatedFalseNegatives: null
    };
  }

  const basePath = normalizePath(baseParsed.pathname);
  const compPath = normalizePath(compParsed.pathname);

  if (basePath !== compPath) {
    return {
      classification: 'INCOMPATIBLE',
      baselineUrl,
      compareUrl,
      mismatchDelta: {
        pathname: { baseline: basePath, compare: compPath },
        hash: null,
        queryParams: null
      },
      estimatedFalseNegatives: null
    };
  }

  const baseHash = baseParsed.hash;
  const compHash = compParsed.hash;
  const hashDiffers = baseHash !== compHash;

  const queryDiffs = collectQueryDiff(baseParsed.searchParams, compParsed.searchParams);
  const stateMismatch = hashDiffers || queryDiffs.length > 0;

  if (!stateMismatch) {
    return {
      classification: 'COMPATIBLE',
      baselineUrl,
      compareUrl,
      mismatchDelta: { pathname: null, hash: null, queryParams: null },
      estimatedFalseNegatives: null
    };
  }

  return {
    classification: 'CAUTION',
    baselineUrl,
    compareUrl,
    mismatchDelta: {
      pathname: null,
      hash: hashDiffers ? { baseline: baseHash, compare: compHash } : null,
      queryParams: queryDiffs.length > 0 ? queryDiffs : null
    },
    estimatedFalseNegatives: null
  };
}

export { assessUrlCompatibility };
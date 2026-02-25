const CACHE_BUST_PATTERN = /^[0-9a-f]{6,64}$|^\d{10,13}$/i;
const NON_NAVIGABLE_PATTERN = /^(mailto:|tel:|javascript:|data:)/i;
const TRACKING_PARAM_PATTERN = /^(utm_|gclid$|gad_source$|fbclid$|msclkid$|_ga$|_gl$)/i;

function extractUrlPath(rawHref) {
  if (!rawHref) {
    return '';
  }
  if (NON_NAVIGABLE_PATTERN.test(rawHref)) {
    return '';
  }
  if (rawHref.startsWith('#')) {
    return '';
  }
  try {
    return new URL(rawHref, document.baseURI).pathname;
  } catch {
    return rawHref.split('?')[0].split('#')[0];
  }
}

function extractSrcPath(rawSrc) {
  if (!rawSrc) {
    return '';
  }
  try {
    const parsed = new URL(rawSrc, document.baseURI);
    const semanticParams = [];
    for (const [k, v] of parsed.searchParams) {
      if (!CACHE_BUST_PATTERN.test(v)) {
        semanticParams.push(`${k}=${v}`);
      }
    }
    const suffix = semanticParams.length > 0 ? '?' + semanticParams.join('&') : '';
    return parsed.pathname + suffix;
  } catch {
    return rawSrc.split('?')[0].split('#')[0];
  }
}

function stripTrackingParams(parsed) {
  const cleaned = new URL(parsed.toString());
  for (const key of [...cleaned.searchParams.keys()]) {
    if (TRACKING_PARAM_PATTERN.test(key)) {
      cleaned.searchParams.delete(key);
    }
  }
  return cleaned;
}

function normalizePath(pathname) {
  const lowered = pathname.toLowerCase().replace(/\/$/, '');
  return lowered.length > 0 ? lowered : '/';
}

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

export { extractUrlPath, extractSrcPath, assessUrlCompatibility };
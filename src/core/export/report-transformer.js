const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function elementLabel(el) {
  const tag      = (el.tagName || 'unknown').toLowerCase();
  const idPart   = el.elementId ? `#${el.elementId}` : '';
  const rawClass = el.className;
  const classStr = typeof rawClass === 'string'
    ? rawClass
    : (rawClass?.baseVal ?? '');
  const clsPart = classStr.trim()
    ? `.${classStr.trim().split(/\s+/).slice(0, 2).join('.')}`
    : '';
  return `${tag}${idPart}${clsPart}`;
}

function elementBreadcrumb(el) {
  return el.selectors?.css || el.selectors?.xpath || elementLabel(el);
}

function getTopSeverity(annotatedDifferences) {
  for (const level of ['critical', 'high', 'medium', 'low']) {
    if (annotatedDifferences.some(d => d.severity === level)) {
      return level;
    }
  }
  return 'low';
}

function buildDiffsByCategory(annotatedDifferences) {
  const map = {};
  for (const diff of annotatedDifferences) {
    const cat = diff.category || 'other';
    if (!map[cat]) {
      map[cat] = [];
    }
    map[cat].push(diff);
  }
  for (const cat of Object.keys(map)) {
    map[cat].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3));
  }
  return map;
}

function buildMatchedGroups(results) {
  const groups = { critical: [], high: [], medium: [], low: [], unchanged: [] };

  for (const match of results) {
    const el = match.baselineElement || {
      id:        match.baselineElementId,
      tagName:   match.tagName,
      elementId: match.elementId,
      className: match.className,
      selectors: match.selectors
    };
    const diffs = match.annotatedDifferences ?? match.differences ?? [];

    if ((match.totalDifferences ?? diffs.length) === 0) {
      groups.unchanged.push({ elementKey: elementLabel(el), tagName: el.tagName });
      continue;
    }

    const topSeverity     = getTopSeverity(diffs);
    const diffsByCategory = buildDiffsByCategory(diffs);

    groups[topSeverity].push({
      elementKey:      elementLabel(el),
      breadcrumb:      elementBreadcrumb(el),
      elementId:       el.id,
      tagName:         el.tagName,
      totalDiffs:      match.totalDifferences ?? diffs.length,
      severity:        topSeverity,
      diffsByCategory,
      selectors:       el.selectors,
      matchConfidence: match.confidence,
      matchStrategy:   match.strategy
    });
  }

  for (const severity of ['critical', 'high', 'medium', 'low']) {
    groups[severity].sort((a, b) => b.totalDiffs - a.totalDiffs);
  }

  return groups;
}

function resolveAmbiguousElement(entry) {
  if (entry.baselineElement) {
    return entry.baselineElement;
  }
  return {
    id:        entry.baselineElementId,
    tagName:   entry.tagName,
    elementId: entry.elementId,
    className: entry.className,
    selectors: entry.selectors
  };
}

function buildAmbiguousGroup(ambiguousList) {
  return ambiguousList.map(entry => {
    const el = resolveAmbiguousElement(entry);
    return {
      elementKey:      elementLabel(el),
      breadcrumb:      elementBreadcrumb(el),
      elementId:       el.id ?? null,
      tagName:         el.tagName,
      selectors:       el.selectors ?? null,
      candidateCount:  entry.candidateCount ?? entry.ambiguousCandidates?.length ?? 0,
      matchConfidence: entry.confidence,
      matchStrategy:   entry.strategy
    };
  });
}

function transformToGroupedReport(comparisonResult) {
  const { comparison, unmatchedElements, matching } = comparisonResult;
  const results       = comparison?.results   ?? [];
  const ambiguousList = comparison?.ambiguous ?? [];

  const matchedGroups     = buildMatchedGroups(results);
  const unmatchedCompare  = unmatchedElements?.compare  ?? [];
  const unmatchedBaseline = unmatchedElements?.baseline ?? [];

  const groups = {
    ...matchedGroups,
    added:     unmatchedCompare.map(el  => ({ elementKey: elementLabel(el),  tagName: el.tagName, className: el.className, status: 'added' })),
    removed:   unmatchedBaseline.map(el => ({ elementKey: elementLabel(el),  tagName: el.tagName, className: el.className, status: 'removed' })),
    ambiguous: buildAmbiguousGroup(ambiguousList)
  };

  const summary = {
    matchRate:        matching?.matchRate        ?? 0,
    totalMatched:     matching?.totalMatched     ?? 0,
    ambiguousCount:   matching?.ambiguousCount   ?? 0,
    modified:         comparison?.summary?.modifiedElements  ?? 0,
    unchanged:        comparison?.summary?.unchangedElements ?? 0,
    added:            unmatchedCompare.length,
    removed:          unmatchedBaseline.length,
    ambiguous:        ambiguousList.length,
    severityCounts:   comparison?.summary?.severityCounts   ?? { critical: 0, high: 0, medium: 0, low: 0 },
    totalDifferences: comparison?.summary?.totalDifferences ?? 0
  };

  return { summary, groups };
}

export { transformToGroupedReport, elementLabel, elementBreadcrumb, getTopSeverity };
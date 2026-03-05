import logger from '../../../infrastructure/logger.js';
import storage from '../../../infrastructure/storage.js';
import { transformToGroupedReport, elementLabel } from '../shared/report-transformer.js';

async function exportToHTML(comparisonResult) {
  try {
    const grouped          = transformToGroupedReport(comparisonResult);
    const manifest         = resolveVisualManifest(comparisonResult.visualDiffs ?? null);
    const visualDiffStatus = comparisonResult.visualDiffStatus ?? null;
    const blobData         = await loadBlobData(manifest);
    const html             = buildDocument(grouped, comparisonResult, manifest, blobData, visualDiffStatus);
    await triggerDownload(html, `comparison-${Date.now()}.html`);
    logger.info('HTML export complete', {
      elements:         grouped.summary.totalMatched,
      ambiguous:        grouped.summary.ambiguous,
      visualDiffs:      Object.keys(manifest).length,
      blobsEmbedded:    Object.keys(blobData).length,
      visualDiffStatus: visualDiffStatus?.status ?? 'none'
    });
    return { success: true };
  } catch (error) {
    logger.error('HTML export failed', { error: error.message });
    return { success: false, error: error.message };
  }
}

function resolveVisualManifest(visualDiffs) {
  if (!visualDiffs) return {};
  const out     = Object.create(null);
  const entries = visualDiffs instanceof Map
    ? visualDiffs.entries()
    : Object.entries(visualDiffs);

  for (const [key, entry] of entries) {
    const { baseline, compare, diffs } = entry ?? {};
    if (!baseline && !compare) continue;
    out[key] = {
      baselineKeyframeId: baseline?.keyframeId   ?? null,
      baselineRect:       baseline?.viewportRect  ?? null,
      compareKeyframeId:  compare?.keyframeId    ?? null,
      compareRect:        compare?.viewportRect   ?? null,
      diffs:              diffs ?? []
    };
  }
  return out;
}

async function blobToDataUri(blob) {
  const buf   = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let binary  = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${blob.type || 'image/webp'};base64,${btoa(binary)}`;
}

async function loadBlobData(manifest) {
  const ids = new Set();
  for (const entry of Object.values(manifest)) {
    if (entry.baselineKeyframeId) ids.add(entry.baselineKeyframeId);
    if (entry.compareKeyframeId)  ids.add(entry.compareKeyframeId);
  }
  const out = Object.create(null);
  for (const id of ids) {
    const blob = await storage.loadVisualBlob(id);
    if (blob) out[id] = await blobToDataUri(blob);
  }
  return out;
}

function buildDiagnosticBanner(vds) {
  if (!vds || vds.status === 'success' || vds.status === 'completed') return '';
  const isFailed  = vds.status === 'failed';
  const bg        = isFailed ? '#7f1d1d' : '#78350f';
  const border    = isFailed ? '#ef4444' : '#f97316';
  const iconLabel = isFailed ? '\u2716 Visual Capture Failed' : '\u26a0 Visual Diff Skipped';
  const hint      = isFailed
    ? 'Close DevTools on both pages and run the comparison again.'
    : 'Screenshots not available \u2014 property diffs are still complete.';
  return `<div style="position:sticky;top:0;z-index:9999;background:${bg};border-bottom:3px solid ${border};padding:10px 16px;display:flex;align-items:flex-start;gap:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;">
  <span style="font-weight:800;color:#fff;white-space:nowrap;">${iconLabel}</span>
  <span style="color:#fecaca;flex:1;">${esc(vds.reason || 'No reason provided.')}</span>
  <span style="color:#9ca3af;font-size:11px;white-space:nowrap;">${hint}</span>
</div>`;
}

function buildPreFlightBanner(preFlightWarning) {
  if (!preFlightWarning || preFlightWarning.classification !== 'CAUTION') return '';
  const { mismatchDelta, estimatedFalseNegatives } = preFlightWarning;
  const parts = [];
  if (mismatchDelta.hash) {
    parts.push(`SPA hash mismatch: <code>${esc(mismatchDelta.hash.baseline)}</code> vs <code>${esc(mismatchDelta.hash.compare)}</code>`);
  }
  if (mismatchDelta.queryParams) {
    parts.push(`Query parameter differences: ${mismatchDelta.queryParams.map(p => esc(p.key)).join(', ')}`);
  }
  const fnNote = estimatedFalseNegatives != null ? ` Estimated false negatives: ~${estimatedFalseNegatives} elements.` : '';
  return `<div style="position:sticky;top:0;z-index:9998;background:#1e3a5f;border-bottom:3px solid #3b82f6;padding:10px 16px;display:flex;align-items:flex-start;gap:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;">
  <span style="font-weight:800;color:#93c5fd;white-space:nowrap;">\u26a0 Page State Mismatch</span>
  <span style="color:#bfdbfe;flex:1;">${parts.join(' \u00b7 ')}${fnNote} Results may contain false positives.</span>
</div>`;
}

async function triggerDownload(html, filename) {
  const bytes = new TextEncoder().encode(html);
  const chunk = 0x8000;
  let binary  = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const url = `data:text/html;base64,${btoa(binary)}`;
  await chrome.downloads.download({ url, filename, saveAs: false });
}

function buildModalHtml() {
  return `<div id="vdiff-modal" class="vdiff-modal" aria-modal="true" role="dialog" hidden>
  <div class="vdiff-modal__header">
    <span class="vdiff-modal__title"></span>
    <div class="vdiff-modal__controls">
      <button data-action="ghost">Ghost Mode</button>
      <button data-action="sync">Sync: ON</button>
      <button data-action="zoom-in">\uff0b</button>
      <button data-action="zoom-out">\uff0d</button>
      <button data-action="close">\u2715</button>
    </div>
  </div>
  <div class="vdiff-modal__panes">
    <div class="vdiff-pane vdiff-pane--baseline">
      <div class="vdiff-pane__label">BASELINE</div>
      <div class="vdiff-pane__scroll-container" data-pane="baseline">
        <div class="vdiff-pane__content">
          <img class="vdiff-screenshot" data-role="baseline" decoding="async" alt="Baseline screenshot">
          <svg class="vdiff-svg-overlay" data-role="baseline" aria-hidden="true"></svg>
          <div class="vdiff-ghost" hidden></div>
        </div>
      </div>
    </div>
    <div class="vdiff-pane vdiff-pane--compare">
      <div class="vdiff-pane__label">COMPARE</div>
      <div class="vdiff-pane__scroll-container" data-pane="compare">
        <div class="vdiff-pane__content">
          <img class="vdiff-screenshot" data-role="compare" decoding="async" alt="Compare screenshot">
          <svg class="vdiff-svg-overlay" data-role="compare" aria-hidden="true"></svg>
        </div>
      </div>
    </div>
  </div>
  <div id="vdiff-tooltip" class="vdiff-tooltip" hidden></div>
</div>`;
}

function buildDocument(grouped, raw, manifest, blobData, visualDiffStatus) {
  const { summary } = grouped;
  const title = `${raw.baseline?.url ?? ''} vs ${raw.compare?.url ?? ''}`;
  const date  = new Date(raw.timestamp ?? Date.now()).toLocaleString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UI Diff \u2014 ${esc(title)}</title>
<style>${buildCss()}</style>
</head>
<body>
${buildDiagnosticBanner(visualDiffStatus)}${buildPreFlightBanner(raw.preFlightWarning ?? null)}<div class="app">
  <header class="topbar">
    <span class="topbar-title">UI Comparison Report</span>
    <span class="topbar-meta">${esc(title)} &mdash; ${date}</span>
    <div class="topbar-search"><input id="search" type="text" placeholder="Filter elements\u2026" autocomplete="off"></div>
  </header>
  <div class="layout">
    <aside class="sidebar">${buildSidebar(summary)}</aside>
    <main class="center-panel">
      <div class="view-tabs">
        <button class="view-tab active" data-view="flat">\u25a4 Flat</button>
        <button class="view-tab" data-view="tree">\u25b8 Tree</button>
      </div>
      <div class="panel-list" id="panel-list">
        <div class="list-loading" id="list-loading">
          <div class="list-spinner"></div>
          <span>Rendering elements\u2026</span>
        </div>
      </div>
      <div class="tree-panel" id="tree-panel" hidden></div>
    </main>
    <aside class="panel-detail" id="panel-detail"><div class="detail-placeholder">Select an element</div></aside>
  </div>
</div>
${buildModalHtml()}
<script>${buildJs(grouped, manifest, blobData)}</script>
</body>
</html>`;
}

function buildSidebar(s) {
  const bar = Math.round(s.matchRate);
  return `
<div class="sidebar-section">
  <div class="stat-headline">${bar}%</div>
  <div class="stat-label">Match Rate</div>
  <div class="progress-bar"><div class="progress-fill" style="width:${bar}%"></div></div>
</div>
<div class="sidebar-section">
  <div class="stat-row sev-critical"><span class="badge badge-critical">${s.severityCounts.critical}</span> Critical</div>
  <div class="stat-row sev-high"><span class="badge badge-high">${s.severityCounts.high}</span> High</div>
  <div class="stat-row sev-medium"><span class="badge badge-medium">${s.severityCounts.medium}</span> Medium</div>
  <div class="stat-row sev-low"><span class="badge badge-low">${s.severityCounts.low}</span> Low</div>
</div>
<div class="sidebar-section">
  <div class="stat-row"><span class="icon">\u2756</span> ${s.totalMatched} Matched</div>
  <div class="stat-row"><span class="icon add">\uff0b</span> ${s.added} Added</div>
  <div class="stat-row"><span class="icon rem">\uff0d</span> ${s.removed} Removed</div>
  <div class="stat-row"><span class="icon">\u25cb</span> ${s.unchanged} Unchanged</div>
  <div class="stat-row"><span class="icon amb">\u25c6</span> ${s.ambiguous} Ambiguous</div>
</div>
<div class="sidebar-section filter-buttons">
  <div class="filter-label">Severity filter</div>
  <button class="filter-btn active" data-sev="all">All</button>
  <button class="filter-btn" data-sev="critical">Critical</button>
  <button class="filter-btn" data-sev="high">High</button>
  <button class="filter-btn" data-sev="medium">Medium</button>
  <button class="filter-btn" data-sev="low">Low</button>
  <button class="filter-btn" data-sev="ambiguous">Ambiguous</button>
</div>
<div class="sidebar-section filter-buttons">
  <div class="filter-label">Category</div>
  <button class="filter-btn active" data-cat="all">All</button>
  <button class="filter-btn" data-cat="layout">Layout</button>
  <button class="filter-btn" data-cat="visual">Visual</button>
  <button class="filter-btn" data-cat="typography">Typography</button>
  <button class="filter-btn" data-cat="spacing">Spacing</button>
</div>`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildCss() {
  return `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;font-size:13px;height:100vh;overflow:hidden}
.app{display:flex;flex-direction:column;height:100vh}
.topbar{display:flex;align-items:center;gap:16px;padding:10px 16px;background:#1a1d27;border-bottom:1px solid #2d3148;flex-shrink:0}
.topbar-title{font-weight:700;font-size:15px;color:#fff}
.topbar-meta{color:#8892b0;font-size:12px;flex:1}
#search{background:#0f1117;border:1px solid #2d3148;border-radius:6px;padding:5px 10px;color:#e2e8f0;width:220px;outline:none}
#search:focus{border-color:#7c3aed}
.layout{display:grid;grid-template-columns:220px 1fr 380px;flex:1;overflow:hidden}
.sidebar{overflow-y:auto;padding:12px;background:#1a1d27;border-right:1px solid #2d3148}
.sidebar-section{margin-bottom:20px}
.stat-headline{font-size:32px;font-weight:800;color:#fff}
.stat-label{font-size:11px;color:#8892b0;margin-bottom:6px}
.progress-bar{height:6px;background:#2d3148;border-radius:3px;overflow:hidden;margin-top:4px}
.progress-fill{height:100%;background:linear-gradient(90deg,#7c3aed,#06b6d4);transition:width .5s}
.stat-row{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px;color:#a0aec0}
.badge{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:18px;border-radius:4px;font-size:11px;font-weight:700;padding:0 4px}
.badge-critical{background:#7f1d1d;color:#fca5a5}
.badge-high{background:#78350f;color:#fcd34d}
.badge-medium{background:#3b1f00;color:#fbbf24}
.badge-low{background:#1e293b;color:#94a3b8}
.filter-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#4a5568;margin-bottom:6px}
.filter-buttons{display:flex;flex-wrap:wrap;gap:4px}
.filter-btn{background:#2d3148;border:1px solid #3d4165;border-radius:4px;color:#a0aec0;font-size:11px;padding:3px 8px;cursor:pointer}
.filter-btn.active{background:#7c3aed;border-color:#7c3aed;color:#fff}
.icon{width:16px;display:inline-block;text-align:center}
.icon.add{color:#10b981}.icon.rem{color:#ef4444}.icon.amb{color:#f59e0b}
.center-panel{display:flex;flex-direction:column;overflow:hidden;min-width:0}
.view-tabs{display:flex;gap:0;border-bottom:1px solid #2d3148;flex-shrink:0;background:#1a1d27}
.view-tab{background:none;border:none;border-bottom:2px solid transparent;color:#8892b0;font-size:12px;padding:8px 18px;cursor:pointer;font-weight:500;transition:color .15s,border-color .15s;letter-spacing:.03em}
.view-tab.active{color:#a78bfa;border-bottom-color:#7c3aed}
.view-tab:hover:not(.active){color:#e2e8f0}
.panel-list{overflow-y:auto;padding:8px;flex:1}
.tree-panel{overflow-y:auto;padding:8px;flex:1}
.list-loading{display:flex;align-items:center;gap:10px;padding:20px;color:#4a5568;font-size:12px}
.list-spinner{width:16px;height:16px;border:2px solid #2d3148;border-top-color:#7c3aed;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
.severity-group{margin-bottom:6px}
.severity-header{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#1e2133;border-radius:6px;cursor:pointer;list-style:none;user-select:none;border:1px solid #2d3148}
.severity-header::-webkit-details-marker{display:none}
details[open] .severity-header{border-radius:6px 6px 0 0;border-bottom:none}
.sev-icon{font-size:14px}
.sev-label{flex:1;font-weight:600;color:#e2e8f0;font-size:13px}
.sev-count{background:#2d3148;border-radius:10px;padding:1px 8px;font-size:11px;color:#a0aec0}
.severity-body{background:#161929;border:1px solid #2d3148;border-top:none;border-radius:0 0 6px 6px;overflow:hidden}
.element-card{padding:10px 12px;border-bottom:1px solid #1e2133;cursor:pointer;transition:background .15s}
.element-card:hover{background:#1e2133}
.element-card.selected{background:#1e2a3a;border-left:3px solid #7c3aed}
.element-card.ambiguous-card{border-left:2px solid #f59e0b}
.element-card:last-child{border-bottom:none}
.card-header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.element-label{font-size:12px;color:#93c5fd;font-family:'JetBrains Mono',monospace}
.card-meta{display:flex;gap:6px;align-items:center;flex-shrink:0}
.diff-count{background:#312e81;color:#a5b4fc;border-radius:4px;padding:1px 6px;font-size:11px}
.recurrence-badge{background:#1a3320;color:#4ade80;border-radius:4px;padding:1px 6px;font-size:11px}
.candidate-count{background:#3d2800;color:#fcd34d;border-radius:4px;padding:1px 6px;font-size:11px}
.confidence{color:#6b7280;font-size:11px}
.has-visual{background:#2d1a3e;color:#c084fc;border-radius:4px;padding:1px 6px;font-size:10px;letter-spacing:.03em}
.card-breadcrumb{font-size:10px;color:#4a5568;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cat-pills{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.cat-pill{font-size:10px;padding:1px 6px;border-radius:10px;background:#1e2133;color:#6b7280}
.cat-layout{background:#1e3a5f;color:#60a5fa}
.cat-visual{background:#3b1f4f;color:#c084fc}
.cat-typography{background:#1a3320;color:#4ade80}
.cat-spacing{background:#3b2a00;color:#fbbf24}
.cat-attribute{background:#1e293b;color:#94a3b8}
.panel-detail{overflow-y:auto;padding:16px;background:#1a1d27;border-left:1px solid #2d3148}
.detail-placeholder{color:#4a5568;text-align:center;margin-top:80px;font-size:13px}
.detail-header{margin-bottom:16px}
.detail-tag{font-size:18px;font-weight:700;color:#fff;font-family:monospace}
.detail-breadcrumb{font-size:11px;color:#4a5568;margin-top:4px;word-break:break-all}
.detail-selectors{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.detail-suppressed{font-size:11px;color:#4a5568;margin-top:4px;font-style:italic}
.sel-btn{background:#1e2133;border:1px solid #2d3148;border-radius:4px;color:#93c5fd;font-size:11px;padding:3px 8px;cursor:pointer;font-family:monospace}
.sel-btn:hover{background:#2d3148}
.detail-category{margin-bottom:12px}
.cat-title{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#4a5568;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #1e2133}
.diff-row{display:grid;grid-template-columns:140px 1fr 16px 1fr;gap:6px;align-items:center;padding:4px 0;font-size:12px}
.diff-prop{color:#a0aec0;font-family:monospace}
.diff-base{color:#fca5a5;font-family:monospace;word-break:break-all}
.diff-compare{color:#86efac;font-family:monospace;word-break:break-all}
.diff-arrow{color:#4a5568;text-align:center}
.sev-pip{display:inline-block;width:6px;height:6px;border-radius:50%;margin-left:4px;vertical-align:middle}
.sev-pip.critical{background:#ef4444}
.sev-pip.high{background:#f97316}
.sev-pip.medium{background:#eab308}
.sev-pip.low{background:#6b7280}
.swatch{display:inline-block;width:12px;height:12px;border-radius:2px;border:1px solid rgba(255,255,255,.2);vertical-align:middle;margin-right:3px}
.ambiguous-notice{background:#3d2800;border:1px solid #f59e0b;border-radius:8px;padding:12px 14px;margin-bottom:16px;font-size:12px;color:#fcd34d}
.ambiguous-notice strong{display:block;margin-bottom:4px;font-size:13px}
.candidate-table{width:100%;border-collapse:collapse;margin-top:10px}
.candidate-table th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#4a5568;padding:4px 8px;border-bottom:1px solid #1e2133}
.candidate-table td{font-size:12px;color:#a0aec0;padding:5px 8px;border-bottom:1px solid #1a1d27;font-family:monospace}
.candidate-table tr:hover td{background:#1e2133}
.candidate-rank{color:#f59e0b;font-weight:700}
.vdiff-section{margin-top:16px;border:1px solid #2d3148;border-radius:8px;overflow:hidden}
.vdiff-section-bar{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#1e2133}
.vdiff-toggle{display:flex;align-items:center;gap:6px;background:none;border:none;color:#c084fc;font-size:12px;font-weight:600;cursor:pointer;letter-spacing:.04em;text-transform:uppercase;padding:0}
.vdiff-toggle:hover{color:#e9d5ff}
.vdiff-chevron{transition:transform .2s;font-style:normal;font-size:14px}
.vdiff-toggle[aria-expanded=true] .vdiff-chevron{transform:rotate(180deg)}
.vdiff-open-btn{background:#312e81;border:1px solid #6366f1;border-radius:4px;color:#a5b4fc;font-size:11px;padding:3px 8px;cursor:pointer;transition:background .15s}
.vdiff-open-btn:hover{background:#3730a3;color:#c7d2fe}
.vdiff-panes{display:none;grid-template-columns:1fr 1fr;gap:1px;background:#2d3148}
.vdiff-panes.open{display:grid}
.vdiff-pane{display:flex;flex-direction:column;background:#0f1117;min-width:0}
.vdiff-pane-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;padding:6px 8px;color:#4a5568;flex-shrink:0;font-weight:600}
.vdiff-pane-label.label-baseline{color:#60a5fa}
.vdiff-pane-label.label-compare{color:#4ade80}
.vdiff-thumb-wrapper{position:relative;overflow:hidden;width:100%;background:#0a0c14}
.vdiff-thumb{display:block;transform-origin:top left}
.vdiff-missing{display:flex;align-items:center;justify-content:center;height:80px;color:#2d3148;font-size:11px}
.vdiff-modal{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.88);display:flex;flex-direction:column;backdrop-filter:blur(4px)}
.vdiff-modal[hidden]{display:none}
.vdiff-modal__header{display:flex;align-items:center;gap:12px;padding:10px 16px;background:#1a1d27;border-bottom:1px solid #2d3148;flex-shrink:0}
.vdiff-modal__title{font-size:13px;color:#93c5fd;font-family:monospace;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vdiff-modal__controls{display:flex;gap:6px;align-items:center;flex-shrink:0}
.vdiff-modal__controls button{background:#2d3148;border:1px solid #3d4165;border-radius:4px;color:#a0aec0;font-size:12px;padding:4px 10px;cursor:pointer;transition:background .12s,color .12s}
.vdiff-modal__controls button:hover{background:#3d4165;color:#e2e8f0}
.vdiff-modal__controls [data-action=ghost].active{background:#312e81;border-color:#6366f1;color:#a5b4fc}
.vdiff-modal__controls [data-action=close]{background:#450a0a;border-color:#991b1b;color:#fca5a5}
.vdiff-modal__controls [data-action=close]:hover{background:#7f1d1d}
.vdiff-modal__panes{display:grid;grid-template-columns:1fr 1fr;flex:1;overflow:hidden;gap:1px;background:#2d3148}
.vdiff-pane{display:flex;flex-direction:column;background:#0f1117;min-width:0;overflow:hidden}
.vdiff-pane__label{font-size:10px;text-transform:uppercase;letter-spacing:.1em;padding:5px 12px;flex-shrink:0;font-weight:700}
.vdiff-pane--baseline .vdiff-pane__label{color:#60a5fa;background:#060e1a}
.vdiff-pane--compare .vdiff-pane__label{color:#4ade80;background:#061209}
.vdiff-pane__scroll-container{overflow:auto;flex:1;position:relative;scrollbar-width:thin;scrollbar-color:#2d3148 transparent}
.vdiff-pane__content{position:relative;display:inline-block;min-width:100%;transform-origin:top left}
.vdiff-screenshot{width:100%;height:auto;display:block;image-rendering:crisp-edges}
.vdiff-svg-overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.vdiff-svg-overlay .hl-rect{pointer-events:all;cursor:crosshair;transition:opacity .15s}
.vdiff-svg-overlay .hl-rect:hover{opacity:.8}
.vdiff-ghost{position:absolute;inset:0;z-index:5;pointer-events:none}
.vdiff-ghost-img{width:100%;height:auto;opacity:.5}
.vdiff-tooltip{position:fixed;z-index:10010;background:#13111c;border:1px solid #6d28d9;border-radius:6px;padding:8px 10px;font-size:11px;max-width:340px;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,.6)}
.vdiff-tooltip[hidden]{display:none}
.tt-row{display:grid;grid-template-columns:120px 1fr 14px 1fr;gap:4px;align-items:baseline;padding:2px 0;border-bottom:1px solid #1e1b2e}
.tt-row:last-child{border-bottom:none}
.tt-prop{color:#94a3b8;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tt-base{color:#fca5a5;font-family:monospace;word-break:break-all}
.tt-arr{color:#4a5568;text-align:center}
.tt-cmp{color:#86efac;font-family:monospace;word-break:break-all}
.tree-root{padding:4px 0}
.tree-node{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:4px;cursor:default;user-select:none;min-height:26px}
.tree-node.tree-has-diff{cursor:pointer}
.tree-node.tree-has-diff:hover{background:#1e2133}
.tree-node.tree-selected{background:#1e2a3a;outline:1px solid #7c3aed}
.tree-node.tree-structural .tree-label{color:#374151}
.tree-toggle{width:14px;text-align:center;font-size:10px;color:#4a5568;cursor:pointer;flex-shrink:0;line-height:1}
.tree-toggle:hover{color:#e2e8f0}
.tree-toggle-spacer{width:14px;flex-shrink:0}
.tree-label{font-size:12px;color:#8892b0;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.tree-has-diff .tree-label{color:#c4b5fd}
.tree-sev{font-size:10px;border-radius:3px;padding:1px 5px;font-weight:700;flex-shrink:0;text-transform:uppercase;letter-spacing:.04em}
.tree-diff-count{background:#312e81;color:#a5b4fc;border-radius:4px;padding:1px 5px;font-size:10px;flex-shrink:0}
.tree-hpid{font-size:10px;color:#2d3148;font-family:monospace;flex-shrink:0;padding-left:4px}
.tree-children{border-left:1px solid #1e2133;margin-left:14px}
.tree-recurrence{font-size:10px;color:#4ade80;flex-shrink:0}
.tree-empty{color:#4a5568;text-align:center;padding:40px 0;font-size:13px}
@media(max-width:900px){.layout{grid-template-columns:1fr}.panel-detail{display:none}}
`;
}

function buildJs(grouped, manifest, blobData) {
  const data         = JSON.stringify(grouped);
  const manifestJson = JSON.stringify(manifest ?? {});
  const blobJson     = JSON.stringify(blobData ?? {});

  return `
(function(){
const GROUPED         = ${data};
const VISUAL_MANIFEST = ${manifestJson};
const VISUAL_DATA     = ${blobJson};
const NORMALIZED_DPR  = 2;

const listEl   = document.getElementById('panel-list');
const detailEl = document.getElementById('panel-detail');
const searchEl = document.getElementById('search');
const treeEl   = document.getElementById('tree-panel');
let activeSev    = 'all';
let activeCat    = 'all';
let selectedCard = null;
let _syncCtrl    = null;
let _zoom        = 1;
let _resizeObs   = null;
let _activeEntry = null;
let _treeBuilt   = false;

const SEVERITY_COLORS = {
  critical: '#ef4444',
  high:     '#f97316',
  medium:   '#eab308',
  low:      '#6b7280',
  removed:  '#ef4444',
  added:    '#22c55e',
  mutated:  '#eab308'
};

const SEV_ORDER = [
  { key:'critical',  label:'Critical',  icon:'\u{1F534}', expanded:true  },
  { key:'high',      label:'High',      icon:'\u{1F7E0}', expanded:true  },
  { key:'medium',    label:'Medium',    icon:'\u{1F7E1}', expanded:false },
  { key:'low',       label:'Low',       icon:'\u26AA',    expanded:false },
  { key:'added',     label:'Added',     icon:'\u{1F7E2}', expanded:true  },
  { key:'removed',   label:'Removed',   icon:'\u2B1B',    expanded:true  },
  { key:'ambiguous', label:'Ambiguous', icon:'\u{1F536}', expanded:true  }
];

function ric(cb){
  if(typeof requestIdleCallback==='function') requestIdleCallback(cb,{timeout:1000});
  else setTimeout(()=>cb({timeRemaining:()=>50,didTimeout:false}),0);
}

function esc(s){
  return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function isColorProp(p){ return p.includes('color')||p.includes('background'); }

function swatch(v){
  if(!v||v==='none'||v==='transparent') return '';
  return '<span class="swatch" style="background:'+esc(v)+'" title="'+esc(v)+'"></span>';
}

function sevPip(s){ return '<span class="sev-pip '+esc(s)+'"></span>'; }

function buildCatPills(diffsByCategory){
  const cats=Object.keys(diffsByCategory||{});
  if(!cats.length) return '';
  return '<div class="cat-pills">'+cats.map(cat=>'<span class="cat-pill cat-'+esc(cat)+'">'+esc(cat)+' '+diffsByCategory[cat].length+'</span>').join('')+'</div>';
}

function buildCard(item,severity,index){
  const key=severity+'-'+index;
  const badge=item.totalDiffs!=null?'<span class="diff-count">'+item.totalDiffs+' diff'+(item.totalDiffs!==1?'s':'')+'</span>':'';
  const conf=item.matchConfidence!=null?'<span class="confidence">'+Math.round(item.matchConfidence*100)+'%</span>':'';
  const visualBadge=VISUAL_MANIFEST[item.hpid]?'<span class="has-visual">\u{1F4F7} Visual</span>':'';
  const recBadge=item.recurrenceCount>1?'<span class="recurrence-badge">\u00d7'+item.recurrenceCount+'</span>':'';
  return '<div class="element-card" data-key="'+esc(key)+'" data-sev="'+esc(severity)+'" role="button" tabindex="0">'
    +'<div class="card-header"><code class="element-label">'+esc(item.elementKey)+'</code>'
    +'<div class="card-meta">'+badge+recBadge+visualBadge+conf+'</div></div>'
    +(item.breadcrumb?'<div class="card-breadcrumb">'+esc(item.breadcrumb)+'</div>':'')
    +buildCatPills(item.diffsByCategory)+'</div>';
}

function buildAmbiguousCard(item,index){
  const key='ambiguous-'+index;
  const count=(item.candidates||[]).length;
  const badge='<span class="candidate-count">'+count+' candidate'+(count!==1?'s':'')+'</span>';
  return '<div class="element-card ambiguous-card" data-key="'+esc(key)+'" data-sev="ambiguous" role="button" tabindex="0">'
    +'<div class="card-header"><code class="element-label">'+esc(item.elementKey)+'</code>'
    +'<div class="card-meta">'+badge+'</div></div>'
    +(item.breadcrumb?'<div class="card-breadcrumb">'+esc(item.breadcrumb)+'</div>':'')
    +'</div>';
}

function buildGroup(spec){
  const items=GROUPED.groups[spec.key]??[];
  if(!items.length) return null;
  const el=document.createElement('details');
  el.className='severity-group';
  el.dataset.sev=spec.key;
  if(spec.expanded) el.open=true;
  const isAmb=spec.key==='ambiguous';
  const cards=items.map((item,i)=>isAmb?buildAmbiguousCard(item,i):buildCard(item,spec.key,i));
  el.innerHTML='<summary class="severity-header">'
    +'<span class="sev-icon">'+spec.icon+'</span>'
    +'<span class="sev-label">'+spec.label+'</span>'
    +'<span class="sev-count">'+items.length+'</span>'
    +'</summary>'
    +'<div class="severity-body">'+cards.join('')+'</div>';
  return el;
}

function applyCrop(img){
  var rect=null;
  try{ rect=img.dataset.rect?JSON.parse(img.dataset.rect):null; }catch(e){ return; }
  if(!rect) return;
  var container=img.parentElement;
  if(!container||!container.classList.contains('vdiff-thumb-wrapper')) return;
  var rx=rect.x!=null?rect.x:(rect.left||0);
  var ry=rect.y!=null?rect.y:(rect.top||0);
  var rw=rect.width||rect.w||1;
  var rh=rect.height||rect.h||1;
  var vpW=img.naturalWidth/NORMALIZED_DPR;
  var vpH=img.naturalHeight/NORMALIZED_DPR;
  var displayW=container.clientWidth||300;
  var scale=displayW/rw;
  img.style.width=(vpW*scale)+'px';
  img.style.height=(vpH*scale)+'px';
  img.style.transform='translate('+(-rx*scale)+'px,'+(-ry*scale)+'px)';
  img.style.transformOrigin='top left';
  img.style.position='absolute';
  container.style.height=(rh*scale)+'px';
}

function buildVisualDiffSection(hpid){
  var entry=VISUAL_MANIFEST[hpid];
  if(!entry) return '';
  var panelId='vd-'+String(hpid).replace(/[^a-zA-Z0-9-_]/g,'_');

  function pane(kfId,label,cls,rect){
    var rectAttr=rect?(' data-rect="'+esc(JSON.stringify(rect))+'"'):'';
    return '<div class="vdiff-pane">'
      +'<div class="vdiff-pane-label '+cls+'">'+label+'</div>'
      +(kfId
        ?'<div class="vdiff-thumb-wrapper"><img class="vdiff-thumb" data-kf-id="'+esc(kfId)+'"'+rectAttr+' alt="'+label+'" decoding="async" loading="lazy"></div>'
        :'<div class="vdiff-missing">No capture</div>')
      +'</div>';
  }

  return '<div class="vdiff-section">'
    +'<div class="vdiff-section-bar">'
    +'<button class="vdiff-toggle" aria-expanded="false" aria-controls="'+panelId+'">'
    +'\u{1F4F7} Visual Diff<i class="vdiff-chevron">\u2964</i>'
    +'</button>'
    +'<button class="vdiff-open-btn" data-hpid="'+esc(hpid)+'">&#x29c9; Workbench</button>'
    +'</div>'
    +'<div class="vdiff-panes" id="'+panelId+'" role="region">'
    +pane(entry.baselineKeyframeId,'Baseline','label-baseline',entry.baselineRect)
    +pane(entry.compareKeyframeId,'Compare','label-compare',entry.compareRect)
    +'</div>'
    +'</div>';
}

function buildAmbiguousDetail(item){
  var candidates=item.candidates||[];
  var rows=candidates.map(function(c,i){
    var rankLabel=i===0?'<span class="candidate-rank">#1</span>':'#'+(i+1);
    return '<tr>'
      +'<td>'+rankLabel+'</td>'
      +'<td>'+esc(c.compareIndex!=null?String(c.compareIndex):'\u2014')+'</td>'
      +'<td>'+(Math.round((c.confidence||0)*100))+'%</td>'
      +'<td>'+esc(c.strategy||'\u2014')+'</td>'
      +'<td>'+(c.deltaFromBest!=null?('+'+Math.round(c.deltaFromBest*100)/100):'0')+'</td>'
      +'</tr>';
  });
  var sel=item.selectors||{};
  var selBtns=[
    sel.xpath?'<button class="sel-btn" data-copy="'+esc(sel.xpath)+'">Copy XPath</button>':'',
    sel.css  ?'<button class="sel-btn" data-copy="'+esc(sel.css)+'">Copy CSS</button>':''
  ].join('');
  detailEl.innerHTML='<div class="detail-header">'
    +'<div class="detail-tag">'+esc(item.elementKey)+'</div>'
    +(item.breadcrumb?'<div class="detail-breadcrumb">'+esc(item.breadcrumb)+'</div>':'')
    +'<div class="detail-selectors">'+selBtns+'</div>'
    +'</div>'
    +'<div class="ambiguous-notice">'
    +'<strong>\u{1F536} Ambiguous Match \u2014 Not Compared</strong>'
    +'This element has '+candidates.length+' candidate match'+(candidates.length!==1?'es':'')+' within the ambiguity window (confidence delta \u2264 0.12). '
    +'The matcher declined to commit a match to prevent false property diffs. '
    +'Inspect the candidates below to determine the intended counterpart.'
    +'</div>'
    +(rows.length>0
      ?'<table class="candidate-table">'
        +'<thead><tr><th>Rank</th><th>Compare idx</th><th>Confidence</th><th>Strategy</th><th>Delta</th></tr></thead>'
        +'<tbody>'+rows.join('')+'</tbody>'
        +'</table>'
      :'<div class="detail-placeholder" style="margin-top:16px">No candidate data available</div>');

  detailEl.querySelectorAll('[data-copy]').forEach(function(btn){
    btn.addEventListener('click',function(){
      navigator.clipboard.writeText(btn.dataset.copy).then(function(){
        var orig=btn.textContent; btn.textContent='Copied!';
        setTimeout(function(){ btn.textContent=orig; },1200);
      });
    });
  });
}

function renderDetail(item,contextHpid){
  if(!item){ detailEl.innerHTML='<div class="detail-placeholder">Select an element</div>'; return; }
  if(item.isAmbiguous){ buildAmbiguousDetail(item); return; }
  var sel=item.selectors||{};
  var selBtns=[
    sel.xpath?'<button class="sel-btn" data-copy="'+esc(sel.xpath)+'">Copy XPath</button>':'',
    sel.css  ?'<button class="sel-btn" data-copy="'+esc(sel.css)+'">Copy CSS</button>':''
  ].join('');
  var catBlocks=Object.keys(item.diffsByCategory||{}).map(function(cat){
    var rows=item.diffsByCategory[cat].map(function(d){
      var cls=isColorProp(d.property)?' color-diff':'';
      return '<div class="diff-row'+cls+'">'
        +'<span class="diff-prop">'+esc(d.property)+'</span>'
        +'<span class="diff-base">'+swatch(d.baseValue)+esc(d.baseValue??'\u2014')+'</span>'
        +'<span class="diff-arrow">\u2192</span>'
        +'<span class="diff-compare">'+swatch(d.compareValue)+esc(d.compareValue??'\u2014')+sevPip(d.severity||'low')+'</span>'
        +'</div>';
    }).join('');
    return '<div class="detail-category"><div class="cat-title">'+esc(cat)+'</div>'+rows+'</div>';
  }).join('');

  var recurrenceNote='';
  if(item.recurrenceCount>1){
    recurrenceNote='<div class="detail-suppressed">\u00d7'+item.recurrenceCount+' elements share this exact diff pattern (hpids: '+esc((item.recurrenceHpids||[]).join(', '))+')</div>';
  }
  var suppressedNote=item.suppressedDiffsCount>0
    ?'<div class="detail-suppressed">'+item.suppressedDiffsCount+' inherited style diff'+(item.suppressedDiffsCount!==1?'s':'')+' suppressed (CSS cascade)</div>'
    :'';

  detailEl.innerHTML='<div class="detail-header">'
    +'<div class="detail-tag">'+esc(item.elementKey)+'</div>'
    +(item.breadcrumb?'<div class="detail-breadcrumb">'+esc(item.breadcrumb)+'</div>':'')
    +'<div class="detail-selectors">'+selBtns+'</div>'
    +suppressedNote+recurrenceNote
    +'</div>'
    +(catBlocks||'<div class="detail-placeholder" style="margin-top:20px">No property diffs</div>')
    +buildVisualDiffSection(contextHpid||item.hpid);

  detailEl.querySelectorAll('[data-copy]').forEach(function(btn){
    btn.addEventListener('click',function(){
      navigator.clipboard.writeText(btn.dataset.copy).then(function(){
        var orig=btn.textContent; btn.textContent='Copied!';
        setTimeout(function(){ btn.textContent=orig; },1200);
      });
    });
  });

  var toggleBtn=detailEl.querySelector('.vdiff-toggle');
  if(toggleBtn){
    toggleBtn.addEventListener('click',function(){
      var expanded=toggleBtn.getAttribute('aria-expanded')==='true';
      var panes=detailEl.querySelector('.vdiff-panes');
      toggleBtn.setAttribute('aria-expanded',String(!expanded));
      if(panes){
        panes.classList.toggle('open',!expanded);
        if(!expanded){
          panes.querySelectorAll('img[data-kf-id]').forEach(function(img){
            if(!img.src&&img.dataset.kfId){
              var uri=VISUAL_DATA[img.dataset.kfId];
              if(uri){
                img.src=uri;
                img.onload=function(){ applyCrop(img); };
              }
            }
          });
        }
      }
    });
  }
}

function renderListAsync(){
  var loading=document.getElementById('list-loading');
  var queue=SEV_ORDER.slice();
  var frag=document.createDocumentFragment();
  function chunk(deadline){
    while(queue.length>0&&(deadline.timeRemaining()>4||deadline.didTimeout)){
      var g=buildGroup(queue.shift());
      if(g) frag.appendChild(g);
    }
    if(queue.length>0){ ric(chunk); }
    else {
      if(loading) loading.remove();
      listEl.appendChild(frag);
      attachListHandlers();
    }
  }
  ric(chunk);
}

function applyFilters(){
  var q=searchEl.value.toLowerCase();
  listEl.querySelectorAll('.severity-group').forEach(function(group){
    var sevMatch=activeSev==='all'||group.dataset.sev===activeSev;
    group.style.display=sevMatch?'':'none';
    group.querySelectorAll('.element-card').forEach(function(card){
      var label=(card.querySelector('.element-label')?.textContent||'').toLowerCase();
      var crumb=(card.querySelector('.card-breadcrumb')?.textContent||'').toLowerCase();
      var textMatch=!q||label.includes(q)||crumb.includes(q);
      var catMatch=activeCat==='all'||Array.from(card.querySelectorAll('.cat-pill')).some(function(p){ return p.textContent.trim().startsWith(activeCat); });
      card.style.display=textMatch&&catMatch?'':'none';
    });
  });
}

function attachListHandlers(){
  listEl.addEventListener('click',function(e){
    var card=e.target.closest('.element-card');
    if(!card) return;
    if(selectedCard) selectedCard.classList.remove('selected');
    card.classList.add('selected');
    selectedCard=card;
    var parts=card.dataset.key.split(/-(.+)/);
    var sev=parts[0], idx=parseInt(parts[1]);
    renderDetail((GROUPED.groups[sev]||[])[idx]||null);
  });
  listEl.addEventListener('keydown',function(e){
    if(e.key===' '&&e.target.classList.contains('element-card')){ e.target.click(); e.preventDefault(); }
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      var cards=Array.from(listEl.querySelectorAll('.element-card:not([style*="none"])'));
      var next=cards[cards.indexOf(document.activeElement)+(e.key==='ArrowDown'?1:-1)];
      if(next){ next.focus(); e.preventDefault(); }
    }
  });
}

document.querySelectorAll('[data-sev].filter-btn').forEach(function(btn){
  btn.addEventListener('click',function(){
    document.querySelectorAll('[data-sev].filter-btn').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active'); activeSev=btn.dataset.sev; applyFilters();
  });
});

document.querySelectorAll('[data-cat].filter-btn').forEach(function(btn){
  btn.addEventListener('click',function(){
    document.querySelectorAll('[data-cat].filter-btn').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active'); activeCat=btn.dataset.cat; applyFilters();
  });
});

searchEl.addEventListener('input',applyFilters);

document.querySelectorAll('.view-tab').forEach(function(btn){
  btn.addEventListener('click',function(){
    document.querySelectorAll('.view-tab').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    var view=btn.dataset.view;
    listEl.hidden=(view!=='flat');
    treeEl.hidden=(view!=='tree');
    if(view==='tree') buildTreeView();
  });
});

document.addEventListener('keydown',function(e){
  if(e.key==='f'&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){ searchEl.focus(); e.preventDefault(); }
  if(e.key==='Escape'){ var m=document.getElementById('vdiff-modal'); if(m&&!m.hasAttribute('hidden')) closeModal(); }
  if(e.key==='c'&&selectedCard){
    var parts=selectedCard.dataset.key.split(/-(.+)/);
    var sel=(GROUPED.groups[parts[0]]||[])[parseInt(parts[1])]?.selectors?.css;
    if(sel) navigator.clipboard.writeText(sel);
  }
});

var HPID_ITEM_MAP=(function(){
  var m=new Map();
  ['critical','high','medium','low'].forEach(function(sev){
    (GROUPED.groups[sev]||[]).forEach(function(item){
      if(item.hpid) m.set(item.hpid,{sev:sev,item:item});
      (item.recurrenceHpids||[]).forEach(function(h){ if(h&&!m.has(h)) m.set(h,{sev:sev,item:item}); });
    });
  });
  (GROUPED.groups.unchanged||[]).forEach(function(item){
    if(item.hpid) m.set(item.hpid,{sev:'unchanged',item:item});
  });
  return m;
})();

var HPID_LABEL_MAP=(function(){
  var m=new Map();
  (GROUPED.groups.unchanged||[]).forEach(function(item){
    if(item.hpid) m.set(item.hpid,item.elementKey);
  });
  ['critical','high','medium','low','added','removed'].forEach(function(sev){
    (GROUPED.groups[sev]||[]).forEach(function(item){
      if(item.hpid) m.set(item.hpid,item.elementKey);
    });
  });
  return m;
})();

function hpidParent(hpid){
  var idx=hpid.lastIndexOf('.');
  return idx>-1?hpid.slice(0,idx):null;
}

function hpidSortCompare(a,b){
  var pa=a.split('.').map(Number);
  var pb=b.split('.').map(Number);
  for(var i=0;i<Math.max(pa.length,pb.length);i++){
    var va=pa[i]!=null?pa[i]:0;
    var vb=pb[i]!=null?pb[i]:0;
    if(va!==vb) return va-vb;
  }
  return 0;
}

function buildTreeData(){
  var nodeMap=new Map();

  function addDiffNode(hpid,sev,item){
    if(!hpid||nodeMap.has(hpid)) return;
    nodeMap.set(hpid,{hpid:hpid,severity:sev,item:item,hasDiff:true,isStructural:false,children:[]});
  }

  ['critical','high','medium','low','added','removed'].forEach(function(sev){
    (GROUPED.groups[sev]||[]).forEach(function(item){
      if(item.hpid) addDiffNode(item.hpid,sev,item);
      (item.recurrenceHpids||[]).slice(1).forEach(function(h){
        if(h) addDiffNode(h,sev,Object.assign({},item,{hpid:h,isRecurrence:true}));
      });
    });
  });

  var hpidsToProcess=Array.from(nodeMap.keys());
  hpidsToProcess.forEach(function(hpid){
    var p=hpidParent(hpid);
    while(p&&!nodeMap.has(p)){
      nodeMap.set(p,{hpid:p,severity:null,item:null,hasDiff:false,isStructural:true,children:[]});
      p=hpidParent(p);
    }
  });

  var roots=[];
  nodeMap.forEach(function(node,hpid){
    var p=hpidParent(hpid);
    if(p&&nodeMap.has(p)){
      nodeMap.get(p).children.push(node);
    } else {
      roots.push(node);
    }
  });

  nodeMap.forEach(function(node){
    node.children.sort(function(a,b){ return hpidSortCompare(a.hpid,b.hpid); });
  });
  roots.sort(function(a,b){ return hpidSortCompare(a.hpid,b.hpid); });

  return roots;
}

function renderTreeNode(node,depth){
  depth=depth||0;
  var hpid=node.hpid;
  var severity=node.severity;
  var item=node.item;
  var hasDiff=node.hasDiff;
  var isStructural=node.isStructural;
  var children=node.children;
  var hasChildren=children.length>0;

  var label=HPID_LABEL_MAP.get(hpid)||hpid;
  var sevColor={critical:'#ef4444',high:'#f97316',medium:'#eab308',low:'#6b7280',added:'#22c55e',removed:'#ef4444'}[severity]||'transparent';

  var container=document.createElement('div');

  var nodeEl=document.createElement('div');
  nodeEl.className='tree-node'+(isStructural?' tree-structural':'')+(hasDiff?' tree-has-diff':'');
  nodeEl.style.paddingLeft=(depth*14+4)+'px';
  nodeEl.dataset.hpid=hpid;

  var toggleSpan=document.createElement('span');
  if(hasChildren){
    toggleSpan.className='tree-toggle';
    toggleSpan.textContent='\u25be';
  } else {
    toggleSpan.className='tree-toggle-spacer';
  }

  var labelSpan=document.createElement('span');
  labelSpan.className='tree-label';
  labelSpan.title=label;
  labelSpan.textContent=label;

  nodeEl.appendChild(toggleSpan);
  nodeEl.appendChild(labelSpan);

  if(severity&&severity!=='unchanged'){
    var sevSpan=document.createElement('span');
    sevSpan.className='tree-sev';
    sevSpan.style.cssText='background:'+sevColor+'20;color:'+sevColor;
    sevSpan.textContent=severity;
    nodeEl.appendChild(sevSpan);
  }

  if(item&&item.totalDiffs){
    var countSpan=document.createElement('span');
    countSpan.className='tree-diff-count';
    countSpan.textContent=item.totalDiffs+'d';
    nodeEl.appendChild(countSpan);
  }

  if(item&&item.recurrenceCount>1){
    var recSpan=document.createElement('span');
    recSpan.className='tree-recurrence';
    recSpan.textContent='\u00d7'+item.recurrenceCount;
    nodeEl.appendChild(recSpan);
  }

  var hpidSpan=document.createElement('span');
  hpidSpan.className='tree-hpid';
  hpidSpan.textContent=hpid;
  nodeEl.appendChild(hpidSpan);

  container.appendChild(nodeEl);

  if(hasChildren){
    var childContainer=document.createElement('div');
    childContainer.className='tree-children';

    var childrenBuilt=false;

    toggleSpan.addEventListener('click',function(e){
      e.stopPropagation();
      var isOpen=toggleSpan.textContent==='\u25be';
      if(isOpen){
        toggleSpan.textContent='\u25b8';
        childContainer.hidden=true;
      } else {
        if(!childrenBuilt){
          childrenBuilt=true;
          children.forEach(function(child){ childContainer.appendChild(renderTreeNode(child,depth+1)); });
        }
        toggleSpan.textContent='\u25be';
        childContainer.hidden=false;
      }
    });

    if(hasDiff||children.some(function(c){ return c.hasDiff; })){
      childrenBuilt=true;
      children.forEach(function(child){ childContainer.appendChild(renderTreeNode(child,depth+1)); });
    } else {
      childContainer.hidden=true;
    }

    container.appendChild(childContainer);
  }

  return container;
}

function buildTreeView(){
  if(_treeBuilt) return;
  _treeBuilt=true;

  var roots=buildTreeData();
  if(!roots.length){
    treeEl.innerHTML='<div class="tree-empty">No diff elements found</div>';
    return;
  }

  var frag=document.createDocumentFragment();
  var div=document.createElement('div');
  div.className='tree-root';

  roots.forEach(function(root){ div.appendChild(renderTreeNode(root,0)); });
  frag.appendChild(div);
  treeEl.appendChild(frag);

  treeEl.addEventListener('click',function(e){
    var node=e.target.closest('.tree-node.tree-has-diff');
    if(!node) return;
    treeEl.querySelectorAll('.tree-node.tree-selected').forEach(function(n){ n.classList.remove('tree-selected'); });
    node.classList.add('tree-selected');
    var hpid=node.dataset.hpid;
    var entry=HPID_ITEM_MAP.get(hpid);
    if(entry) renderDetail(entry.item,hpid);
  });
}

function getModal(){ return document.getElementById('vdiff-modal'); }

function svgNS(tag){ return document.createElementNS('http://www.w3.org/2000/svg',tag); }

function setAttrs(el,attrs){
  for(var k in attrs) el.setAttribute(k,String(attrs[k]));
}

function drawHighlights(svgEl,rect,diffs,vpW,vpH){
  svgEl.innerHTML='';
  if(!rect||!vpW||!vpH) return;
  var contW=svgEl.parentElement.clientWidth;
  var contH=svgEl.parentElement.clientHeight;
  svgEl.setAttribute('viewBox','0 0 '+contW+' '+contH);
  svgEl.setAttribute('width',contW);
  svgEl.setAttribute('height',contH);
  var sx=contW/vpW;
  var sy=contH/vpH;
  var severity=(diffs&&diffs[0])?diffs[0].severity:'medium';
  var color=SEVERITY_COLORS[severity]||'#6b7280';
  var rx=rect.x!=null?rect.x:(rect.left||0);
  var ry=rect.y!=null?rect.y:(rect.top||0);
  var rw=rect.width||rect.w||0;
  var rh=rect.height||rect.h||0;
  var x=rx*sx;
  var y=ry*sy;
  var w=rw*sx;
  var h=rh*sy;

  var glow=svgNS('rect');
  setAttrs(glow,{x:x-2,y:y-2,width:w+4,height:h+4,fill:'none',stroke:color,'stroke-width':3,opacity:.4,rx:2});
  svgEl.appendChild(glow);

  var hl=svgNS('rect');
  setAttrs(hl,{x:x,y:y,width:w,height:h,fill:color+'22',stroke:color,'stroke-width':2,rx:2,'class':'hl-rect'});
  hl.dataset.diffs=JSON.stringify(diffs||[]);
  svgEl.appendChild(hl);

  if(w>40&&h>16){
    var txt=svgNS('text');
    var propList=(diffs||[]).map(function(d){ return d.property; }).join(', ');
    var label=propList.length>32?propList.slice(0,31)+'\u2026':propList;
    setAttrs(txt,{x:x+4,y:y+13,fill:color,'font-size':11,'font-family':'monospace'});
    txt.textContent=label;
    svgEl.appendChild(txt);
  }
}

function setModalImage(imgEl,svgEl,kfId,rect,diffs){
  svgEl.innerHTML='';
  imgEl.removeAttribute('src');
  if(!kfId) return;
  var uri=VISUAL_DATA[kfId];
  if(!uri) return;
  imgEl.onload=function(){
    var vpW=imgEl.naturalWidth/NORMALIZED_DPR;
    var vpH=imgEl.naturalHeight/NORMALIZED_DPR;
    drawHighlights(svgEl,rect,diffs,vpW,vpH);
  };
  imgEl.src=uri;
}

function initSyncScroll(paneA,paneB){
  var lock=false, enabled=true;
  function sync(src,dst){
    if(!enabled||lock) return;
    lock=true; dst.scrollLeft=src.scrollLeft; dst.scrollTop=src.scrollTop;
    requestAnimationFrame(function(){ lock=false; });
  }
  function onA(){ sync(paneA,paneB); }
  function onB(){ sync(paneB,paneA); }
  paneA.addEventListener('scroll',onA,{passive:true});
  paneB.addEventListener('scroll',onB,{passive:true});
  return {
    toggle:function(){ enabled=!enabled; return enabled; },
    destroy:function(){ paneA.removeEventListener('scroll',onA); paneB.removeEventListener('scroll',onB); }
  };
}

function applyZoom(z){
  getModal().querySelectorAll('.vdiff-pane__content').forEach(function(c){
    c.style.transform=z===1?'':'scale('+z+')';
    c.style.transformOrigin='top left';
  });
}

function redrawAll(){
  var modal=getModal();
  var entry=_activeEntry;
  if(!entry) return;
  var baseImg=modal.querySelector('.vdiff-screenshot[data-role="baseline"]');
  var cmpImg=modal.querySelector('.vdiff-screenshot[data-role="compare"]');
  var baseSvg=modal.querySelector('.vdiff-svg-overlay[data-role="baseline"]');
  var cmpSvg=modal.querySelector('.vdiff-svg-overlay[data-role="compare"]');
  if(baseImg.naturalWidth) drawHighlights(baseSvg,entry.baselineRect,entry.diffs,baseImg.naturalWidth/NORMALIZED_DPR,baseImg.naturalHeight/NORMALIZED_DPR);
  if(cmpImg.naturalWidth)  drawHighlights(cmpSvg,entry.compareRect,entry.diffs,cmpImg.naturalWidth/NORMALIZED_DPR,cmpImg.naturalHeight/NORMALIZED_DPR);
}

function openDiffModal(hpid){
  var entry=VISUAL_MANIFEST[hpid];
  if(!entry) return;
  _activeEntry=entry;
  var modal=getModal();
  modal.querySelector('.vdiff-modal__title').textContent=hpid;

  var baseImg=modal.querySelector('.vdiff-screenshot[data-role="baseline"]');
  var cmpImg=modal.querySelector('.vdiff-screenshot[data-role="compare"]');
  var baseSvg=modal.querySelector('.vdiff-svg-overlay[data-role="baseline"]');
  var cmpSvg=modal.querySelector('.vdiff-svg-overlay[data-role="compare"]');
  var ghost=modal.querySelector('.vdiff-ghost');

  modal.classList.remove('ghost-mode');
  ghost.hidden=true; ghost.innerHTML='';
  _zoom=1; applyZoom(1);
  modal.querySelector('[data-action="ghost"]').classList.remove('active');
  modal.querySelector('[data-action="ghost"]').textContent='Ghost Mode';
  modal.querySelector('[data-action="sync"]').textContent='Sync: ON';

  setModalImage(baseImg,baseSvg,entry.baselineKeyframeId,entry.baselineRect,entry.diffs);
  setModalImage(cmpImg,cmpSvg,entry.compareKeyframeId,entry.compareRect,entry.diffs);

  var paneA=modal.querySelector('[data-pane="baseline"]');
  var paneB=modal.querySelector('[data-pane="compare"]');
  _syncCtrl=initSyncScroll(paneA,paneB);

  if(_resizeObs) _resizeObs.disconnect();
  if(window.ResizeObserver){
    _resizeObs=new ResizeObserver(function(){ requestAnimationFrame(redrawAll); });
    _resizeObs.observe(modal.querySelector('.vdiff-modal__panes'));
  }

  modal.removeAttribute('hidden');
  document.body.style.overflow='hidden';
}

function closeModal(){
  var modal=getModal();
  modal.setAttribute('hidden','');
  document.body.style.overflow='';
  if(_resizeObs){ _resizeObs.disconnect(); _resizeObs=null; }
  if(_syncCtrl){ _syncCtrl.destroy(); _syncCtrl=null; }
  _activeEntry=null;
}

function toggleGhost(){
  var modal=getModal();
  var ghost=modal.querySelector('.vdiff-ghost');
  var btn=modal.querySelector('[data-action="ghost"]');
  var active=modal.classList.toggle('ghost-mode');
  btn.classList.toggle('active',active);
  btn.textContent=active?'Ghost: ON':'Ghost Mode';
  if(active){
    var cmpImg=modal.querySelector('.vdiff-screenshot[data-role="compare"]');
    if(cmpImg.src&&!ghost.querySelector('img')){
      var gi=document.createElement('img');
      gi.className='vdiff-ghost-img'; gi.src=cmpImg.src; gi.setAttribute('decoding','async');
      ghost.appendChild(gi); ghost.hidden=false;
    }
  } else { ghost.hidden=true; ghost.innerHTML=''; }
}

document.addEventListener('click',function(e){
  var btn=e.target.closest('[data-action]');
  if(btn){
    var a=btn.dataset.action;
    if(a==='close'){ closeModal(); return; }
    if(a==='ghost'){ toggleGhost(); return; }
    if(a==='sync'){ if(_syncCtrl){ var en=_syncCtrl.toggle(); btn.textContent=en?'Sync: ON':'Sync: OFF'; } return; }
    if(a==='zoom-in'){  _zoom=Math.min(4,_zoom+0.25); applyZoom(_zoom); return; }
    if(a==='zoom-out'){ _zoom=Math.max(0.25,_zoom-0.25); applyZoom(_zoom); return; }
  }
  var ob=e.target.closest('.vdiff-open-btn');
  if(ob){ openDiffModal(ob.dataset.hpid); return; }
  if(e.target.id==='vdiff-modal') closeModal();
});

var tooltipEl=document.getElementById('vdiff-tooltip');

document.addEventListener('mousemove',function(e){
  var hl=e.target.closest('.hl-rect');
  if(!hl){ tooltipEl.hidden=true; return; }
  var diffs=JSON.parse(hl.dataset.diffs||'[]');
  if(!diffs.length){ tooltipEl.hidden=true; return; }
  var rows=diffs.map(function(d){
    return '<div class="tt-row">'
      +'<span class="tt-prop">'+esc(d.property)+'</span>'
      +'<span class="tt-base">'+esc(d.baseValue||'\u2014')+'</span>'
      +'<span class="tt-arr">\u2192</span>'
      +'<span class="tt-cmp">'+esc(d.compareValue||'\u2014')+'</span>'
      +'</div>';
  }).join('');
  tooltipEl.innerHTML=rows;
  var vw=window.innerWidth;
  var left=e.clientX+14;
  tooltipEl.style.left=(left+200>vw?e.clientX-214:left)+'px';
  tooltipEl.style.top=(e.clientY+14)+'px';
  tooltipEl.hidden=false;
});

document.addEventListener('mouseleave',function(){ tooltipEl.hidden=true; },true);

renderListAsync();

})();
`;
}

export { exportToHTML };
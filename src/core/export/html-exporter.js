import logger from '../../infrastructure/logger.js';
import { transformToGroupedReport, elementLabel } from './report-transformer.js';

function exportToHTML(comparisonResult) {
  try {
    const grouped = transformToGroupedReport(comparisonResult);
    const html    = _buildDocument(grouped, comparisonResult);
    _triggerDownload(html, `comparison-${Date.now()}.html`);
    logger.info('HTML export complete', { elements: grouped.summary.totalMatched });
    return { success: true };
  } catch (error) {
    logger.error('HTML export failed', { error: error.message });
    return { success: false, error: error.message };
  }
}

function _triggerDownload(html, filename) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _buildDocument(grouped, raw) {
  const { summary } = grouped;
  const title = `${raw.baseline?.url ?? ''} vs ${raw.compare?.url ?? ''}`;
  const date  = new Date(raw.timestamp ?? Date.now()).toLocaleString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UI Diff — ${_esc(title)}</title>
<style>${_css()}</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <span class="topbar-title">UI Comparison Report</span>
    <span class="topbar-meta">${_esc(title)} &mdash; ${date}</span>
    <div class="topbar-search"><input id="search" type="text" placeholder="Filter elements…" autocomplete="off"></div>
  </header>
  <div class="layout">
    <aside class="sidebar">${_buildSidebar(summary)}</aside>
    <main class="panel-list" id="panel-list">${_buildList(grouped)}</main>
    <aside class="panel-detail" id="panel-detail"><div class="detail-placeholder">Select an element</div></aside>
  </div>
</div>
<script>${_js(grouped)}</script>
</body>
</html>`;
}

function _buildSidebar(s) {
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
  <div class="stat-row"><span class="icon">✦</span> ${s.totalMatched} Matched</div>
  <div class="stat-row"><span class="icon add">＋</span> ${s.added} Added</div>
  <div class="stat-row"><span class="icon rem">－</span> ${s.removed} Removed</div>
  <div class="stat-row"><span class="icon">○</span> ${s.unchanged} Unchanged</div>
</div>
<div class="sidebar-section filter-buttons">
  <div class="filter-label">Severity filter</div>
  <button class="filter-btn active" data-sev="all">All</button>
  <button class="filter-btn" data-sev="critical">Critical</button>
  <button class="filter-btn" data-sev="high">High</button>
  <button class="filter-btn" data-sev="medium">Medium</button>
  <button class="filter-btn" data-sev="low">Low</button>
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

function _buildList(grouped) {
  const SEVERITIES = [
    { key: 'critical', label: 'Critical', icon: '🔴', expanded: true },
    { key: 'high',     label: 'High',     icon: '🟠', expanded: true },
    { key: 'medium',   label: 'Medium',   icon: '🟡', expanded: false },
    { key: 'low',      label: 'Low',      icon: '⚪', expanded: false },
    { key: 'added',    label: 'Added',    icon: '🟢', expanded: true },
    { key: 'removed',  label: 'Removed',  icon: '⬛', expanded: true }
  ];

  return SEVERITIES.map(({ key, label, icon, expanded }) => {
    const items = grouped.groups[key] ?? [];
    if (items.length === 0) return '';
    const openAttr = expanded ? ' open' : '';
    return `<details class="severity-group" data-sev="${key}"${openAttr}>
  <summary class="severity-header">
    <span class="sev-icon">${icon}</span>
    <span class="sev-label">${label}</span>
    <span class="sev-count">${items.length}</span>
  </summary>
  <div class="severity-body">
    ${items.map((item, i) => _buildElementCard(item, key, i)).join('')}
  </div>
</details>`;
  }).join('');
}

function _buildElementCard(item, severity, index) {
  const key = `${severity}-${index}`;
  const countBadge = item.totalDiffs != null
    ? `<span class="diff-count">${item.totalDiffs} diff${item.totalDiffs !== 1 ? 's' : ''}</span>`
    : '';
  const confidence = item.matchConfidence != null
    ? `<span class="confidence">${Math.round(item.matchConfidence * 100)}%</span>`
    : '';

  return `<div class="element-card" data-key="${_esc(key)}" data-sev="${severity}" role="button" tabindex="0">
  <div class="card-header">
    <code class="element-label">${_esc(item.elementKey)}</code>
    <div class="card-meta">${countBadge}${confidence}</div>
  </div>
  ${item.breadcrumb ? `<div class="card-breadcrumb">${_esc(item.breadcrumb)}</div>` : ''}
  ${_buildCategoryPills(item.diffsByCategory)}
</div>`;
}

function _buildCategoryPills(diffsByCategory) {
  if (!diffsByCategory) return '';
  return `<div class="cat-pills">${Object.keys(diffsByCategory).map(cat =>
    `<span class="cat-pill cat-${cat}">${cat} ${diffsByCategory[cat].length}</span>`
  ).join('')}</div>`;
}

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _isColorProp(property) {
  return property.includes('color') || property.includes('background');
}

function _colorSwatch(colorStr) {
  if (!colorStr || colorStr === 'none' || colorStr === 'transparent') return '';
  return `<span class="swatch" style="background:${_esc(colorStr)}" title="${_esc(colorStr)}"></span>`;
}

function _css() {
  return `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;font-size:13px;height:100vh;overflow:hidden}
.app{display:flex;flex-direction:column;height:100vh}
.topbar{display:flex;align-items:center;gap:16px;padding:10px 16px;background:#1a1d27;border-bottom:1px solid #2d3148;flex-shrink:0}
.topbar-title{font-weight:700;font-size:15px;color:#fff}
.topbar-meta{color:#8892b0;font-size:12px;flex:1}
#search{background:#0f1117;border:1px solid #2d3148;border-radius:6px;padding:5px 10px;color:#e2e8f0;width:220px;outline:none}
#search:focus{border-color:#7c3aed}
.layout{display:grid;grid-template-columns:220px 1fr 340px;flex:1;overflow:hidden}
.sidebar{overflow-y:auto;padding:12px;background:#1a1d27;border-right:1px solid #2d3148}
.sidebar-section{margin-bottom:20px}
.stat-headline{font-size:32px;font-weight:800;color:#fff}
.stat-label{font-size:11px;color:#8892b0;margin-bottom:6px}
.progress-bar{height:6px;background:#2d3148;border-radius:3px;overflow:hidden;margin-top:4px}
.progress-fill{height:100%;background:linear-gradient(90deg,#7c3aed,#06b6d4);transition:width 0.5s}
.stat-row{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px;color:#a0aec0}
.badge{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:18px;border-radius:4px;font-size:11px;font-weight:700;padding:0 4px}
.badge-critical{background:#7f1d1d;color:#fca5a5}
.badge-high{background:#78350f;color:#fcd34d}
.badge-medium{background:#3b1f00;color:#fbbf24}
.badge-low{background:#1e293b;color:#94a3b8}
.sev-critical .badge{background:#7f1d1d;color:#fca5a5}
.filter-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#4a5568;margin-bottom:6px}
.filter-buttons{display:flex;flex-wrap:wrap;gap:4px}
.filter-btn{background:#2d3148;border:1px solid #3d4165;border-radius:4px;color:#a0aec0;font-size:11px;padding:3px 8px;cursor:pointer}
.filter-btn.active{background:#7c3aed;border-color:#7c3aed;color:#fff}
.icon{width:16px;display:inline-block;text-align:center}
.icon.add{color:#10b981}.icon.rem{color:#ef4444}
.panel-list{overflow-y:auto;padding:8px}
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
.element-card:last-child{border-bottom:none}
.card-header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.element-label{font-size:12px;color:#93c5fd;font-family:'JetBrains Mono',monospace}
.card-meta{display:flex;gap:6px;align-items:center;flex-shrink:0}
.diff-count{background:#312e81;color:#a5b4fc;border-radius:4px;padding:1px 6px;font-size:11px}
.confidence{color:#6b7280;font-size:11px}
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
@media(max-width:900px){.layout{grid-template-columns:1fr}.panel-detail{display:none}}
`;
}

function _js(grouped) {
  const data = JSON.stringify(grouped);
  return `
(function(){
const GROUPED = ${data};
const listEl   = document.getElementById('panel-list');
const detailEl = document.getElementById('panel-detail');
const searchEl = document.getElementById('search');
let activeSev  = 'all';
let activeCat  = 'all';
let selectedCard = null;

function isColorProp(p){ return p.includes('color') || p.includes('background'); }

function swatch(v){
  if(!v||v==='none'||v==='transparent') return '';
  return '<span class="swatch" style="background:'+esc(v)+'" title="'+esc(v)+'"></span>';
}

function esc(s){
  return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sevPip(s){ return '<span class="sev-pip '+esc(s)+'"></span>'; }

function renderDetail(item){
  if(!item){ detailEl.innerHTML='<div class="detail-placeholder">Select an element</div>'; return; }

  const selectors = item.selectors || {};
  const selBtns = [
    selectors.xpath ? '<button class="sel-btn" data-copy="'+esc(selectors.xpath)+'">Copy XPath</button>' : '',
    selectors.css   ? '<button class="sel-btn" data-copy="'+esc(selectors.css)+'">Copy CSS</button>' : ''
  ].join('');

  const catBlocks = Object.keys(item.diffsByCategory||{}).map(cat => {
    const diffs = item.diffsByCategory[cat];
    const rows  = diffs.map(d => {
      const colorCls = isColorProp(d.property) ? ' color-diff' : '';
      return '<div class="diff-row'+colorCls+'">'
        +'<span class="diff-prop">'+esc(d.property)+'</span>'
        +'<span class="diff-base">'+swatch(d.baseValue)+esc(d.baseValue??'—')+'</span>'
        +'<span class="diff-arrow">→</span>'
        +'<span class="diff-compare">'+swatch(d.compareValue)+esc(d.compareValue??'—')+sevPip(d.severity||'low')+'</span>'
        +'</div>';
    }).join('');
    return '<div class="detail-category"><div class="cat-title">'+esc(cat)+'</div>'+rows+'</div>';
  }).join('');

  detailEl.innerHTML = \`
<div class="detail-header">
  <div class="detail-tag">\${esc(item.elementKey)}</div>
  \${item.breadcrumb?'<div class="detail-breadcrumb">'+esc(item.breadcrumb)+'</div>':''}
  <div class="detail-selectors">\${selBtns}</div>
</div>
\${catBlocks||'<div class="detail-placeholder" style="margin-top:20px">No property diffs</div>'}
\`;

  detailEl.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.copy).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1200);
      });
    });
  });
}

function applyFilters(){
  const q = searchEl.value.toLowerCase();
  listEl.querySelectorAll('.severity-group').forEach(group => {
    const sev = group.dataset.sev;
    const sevMatch = activeSev === 'all' || sev === activeSev;
    group.style.display = sevMatch ? '' : 'none';

    group.querySelectorAll('.element-card').forEach(card => {
      const label = (card.querySelector('.element-label')?.textContent || '').toLowerCase();
      const crumb = (card.querySelector('.card-breadcrumb')?.textContent || '').toLowerCase();
      const textMatch = !q || label.includes(q) || crumb.includes(q);

      let catMatch = true;
      if(activeCat !== 'all'){
        catMatch = Array.from(card.querySelectorAll('.cat-pill')).some(p => p.textContent.trim().startsWith(activeCat));
      }
      card.style.display = textMatch && catMatch ? '' : 'none';
    });
  });
}

listEl.addEventListener('click', e => {
  const card = e.target.closest('.element-card');
  if(!card) return;
  if(selectedCard) selectedCard.classList.remove('selected');
  card.classList.add('selected');
  selectedCard = card;

  const sev = card.dataset.sev;
  const key = card.dataset.key;
  const [severity, idx] = key.split(/-(.+)/);
  const items = GROUPED.groups[sev] || [];
  renderDetail(items[parseInt(idx)] || null);
});

listEl.addEventListener('keydown', e => {
  if(e.key === ' ' && e.target.classList.contains('element-card')){ e.target.click(); e.preventDefault(); }
  if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    const cards = Array.from(listEl.querySelectorAll('.element-card:not([style*="none"])'));
    const idx = cards.indexOf(document.activeElement);
    const next = cards[idx + (e.key === 'ArrowDown' ? 1 : -1)];
    if(next){ next.focus(); e.preventDefault(); }
  }
});

document.querySelectorAll('[data-sev]').forEach(btn => {
  if(!btn.classList.contains('filter-btn')) return;
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-sev].filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeSev = btn.dataset.sev;
    applyFilters();
  });
});

document.querySelectorAll('[data-cat]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-cat].filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeCat = btn.dataset.cat;
    applyFilters();
  });
});

searchEl.addEventListener('input', applyFilters);

document.addEventListener('keydown', e => {
  if(e.key === 'f' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){
    searchEl.focus(); e.preventDefault();
  }
  if(e.key === 'c' && selectedCard){
    const sel = GROUPED.groups[selectedCard.dataset.sev]?.[parseInt(selectedCard.dataset.key.split(/-(.+)/)[1])]?.selectors?.css;
    if(sel) navigator.clipboard.writeText(sel);
  }
});

})();
`;
}

export { exportToHTML };
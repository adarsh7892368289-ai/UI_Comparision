import logger from '../../infrastructure/logger.js';
import { transformToGroupedReport, elementLabel } from './report-transformer.js';

/**
 * @param {object} comparisonResult
 * @returns {{ success: boolean, error?: string }}
 */
async function exportToHTML(comparisonResult) {
  try {
    const grouped         = transformToGroupedReport(comparisonResult);
    const diffUris        = _resolveVisualDiffUris(comparisonResult.visualDiffs ?? null);
    const visualDiffStatus = comparisonResult.visualDiffStatus ?? null;
    const html            = _buildDocument(grouped, comparisonResult, diffUris, visualDiffStatus);
    await _triggerDownload(html, `comparison-${Date.now()}.html`);
    logger.info('HTML export complete', {
      elements:         grouped.summary.totalMatched,
      visualDiffs:      Object.keys(diffUris).length,
      visualDiffStatus: visualDiffStatus?.status ?? 'none'
    });
    return { success: true };
  } catch (error) {
    logger.error('HTML export failed', { error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * Maps comparisonResult.visualDiffs into the DIFF_URIS payload.
 * Values are already data URI strings serialized in the Service Worker —
 * no async work needed.
 *
 * @param {Map<string,{baseline:string,compare:string,diff:string|null}>|null} visualDiffs
 * @returns {Record<string,{baselineUri:string,compareUri:string,diffUri:string|null}>}
 */
function _resolveVisualDiffUris(visualDiffs) {
  if (!visualDiffs) {return {};}

  const out     = Object.create(null);
  const entries = visualDiffs instanceof Map
    ? visualDiffs.entries()
    : Object.entries(visualDiffs);

  for (const [key, { baseline, compare, diff }] of entries) {
    if (!baseline && !compare) {continue;}
    out[key] = {
      baselineUri: baseline ?? null,
      compareUri:  compare  ?? null,
      diffUri:     diff     ?? null
    };
  }

  return out;
}

/**
 * Renders a sticky diagnostic banner when the visual capture phase did not
 * produce screenshots. Only called when visualDiffStatus is non-null and
 * status !== 'success'.
 *
 * @param {{ status: string, reason: string } | null} vds
 * @returns {string}  HTML string (empty when no banner is needed)
 */
function _buildDiagnosticBanner(vds) {
  if (!vds || vds.status === 'success') {return '';}

  const isError   = vds.status === 'error';
  const bg        = isError ? '#7f1d1d' : '#78350f';
  const border    = isError ? '#ef4444' : '#f97316';
  const iconLabel = isError ? '✖ Visual Diff Error' : '⚠ Visual Diff Skipped';
  const safeReason = _esc(vds.reason || 'No reason provided.');

  return `
<div style="
  position:sticky;top:0;z-index:9999;
  background:${bg};border-bottom:3px solid ${border};
  padding:10px 16px;display:flex;align-items:flex-start;gap:10px;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
">
  <span style="font-weight:800;color:#fff;white-space:nowrap;">${iconLabel}</span>
  <span style="color:#fecaca;flex:1;">${safeReason}</span>
  <span style="color:#9ca3af;font-size:11px;white-space:nowrap;">
    Screenshots not available — property diffs are still complete.
  </span>
</div>`;
}

function _htmlToDataUri(html) {
  const bytes = new TextEncoder().encode(html);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:text/html;base64,${  btoa(binary)}`;
}

async function _triggerDownload(html, filename) {
  const url = _htmlToDataUri(html);
  await chrome.downloads.download({ url, filename, saveAs: false });
}

function _buildDocument(grouped, raw, diffUris, visualDiffStatus = null) {
  const { summary } = grouped;
  const title = `${raw.baseline?.url ?? ''} vs ${raw.compare?.url ?? ''}`;
  const date  = new Date(raw.timestamp ?? Date.now()).toLocaleString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UI Diff \u2014 ${_esc(title)}</title>
<style>${_css()}</style>
</head>
<body>
${_buildDiagnosticBanner(visualDiffStatus)}<div class="app">
  <header class="topbar">
    <span class="topbar-title">UI Comparison Report</span>
    <span class="topbar-meta">${_esc(title)} &mdash; ${date}</span>
    <div class="topbar-search"><input id="search" type="text" placeholder="Filter elements\u2026" autocomplete="off"></div>
  </header>
  <div class="layout">
    <aside class="sidebar">${_buildSidebar(summary)}</aside>
    <main class="panel-list" id="panel-list">
      <div class="list-loading" id="list-loading">
        <div class="list-spinner"></div>
        <span>Rendering elements\u2026</span>
      </div>
    </main>
    <aside class="panel-detail" id="panel-detail"><div class="detail-placeholder">Select an element</div></aside>
  </div>
</div>
<script>${_js(grouped, diffUris)}</script>
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
  <div class="stat-row"><span class="icon">\u2756</span> ${s.totalMatched} Matched</div>
  <div class="stat-row"><span class="icon add">\uff0b</span> ${s.added} Added</div>
  <div class="stat-row"><span class="icon rem">\uff0d</span> ${s.removed} Removed</div>
  <div class="stat-row"><span class="icon">\u25cb</span> ${s.unchanged} Unchanged</div>
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

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
.layout{display:grid;grid-template-columns:220px 1fr 380px;flex:1;overflow:hidden}
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
.element-card:last-child{border-bottom:none}
.card-header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.element-label{font-size:12px;color:#93c5fd;font-family:'JetBrains Mono',monospace}
.card-meta{display:flex;gap:6px;align-items:center;flex-shrink:0}
.diff-count{background:#312e81;color:#a5b4fc;border-radius:4px;padding:1px 6px;font-size:11px}
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
.vdiff-section{margin-top:16px;border:1px solid #2d3148;border-radius:8px;overflow:hidden}
.vdiff-toggle{width:100%;display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#1e2133;border:none;color:#c084fc;font-size:12px;font-weight:600;cursor:pointer;letter-spacing:.04em;text-transform:uppercase}
.vdiff-toggle:hover{background:#252840}
.vdiff-toggle .vdiff-chevron{transition:transform .2s;font-style:normal;font-size:16px}
.vdiff-toggle[aria-expanded=true] .vdiff-chevron{transform:rotate(180deg)}
.vdiff-panes{display:none;grid-template-columns:repeat(3,1fr);gap:1px;background:#2d3148}
.vdiff-panes.open{display:grid}
.vdiff-pane{display:flex;flex-direction:column;background:#0f1117;min-width:0}
.vdiff-pane-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;padding:6px 8px;color:#4a5568;flex-shrink:0;font-weight:600}
.vdiff-pane-label.label-baseline{color:#60a5fa}
.vdiff-pane-label.label-diff{color:#c084fc}
.vdiff-pane-label.label-compare{color:#4ade80}
.vdiff-img{width:100%;height:auto;display:block;image-rendering:crisp-edges}
.vdiff-missing{display:flex;align-items:center;justify-content:center;height:80px;color:#2d3148;font-size:11px}
.vdiff-legend{display:flex;gap:12px;padding:8px 12px;background:#0f1117;font-size:10px;color:#6b7280;border-top:1px solid #1e2133}
.vdiff-legend-item{display:flex;align-items:center;gap:5px}
.legend-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.legend-dot.magenta{background:#ff00ff}
.legend-dot.yellow{background:#ffff00;border:1px solid #666}
@media(max-width:900px){.layout{grid-template-columns:1fr}.panel-detail{display:none}}
`;
}

function _js(grouped, diffUris) {
  const data     = JSON.stringify(grouped);
  const urisJson = JSON.stringify(diffUris ?? {});

  return `
(function(){
const GROUPED   = ${data};
const DIFF_URIS = ${urisJson};
const listEl   = document.getElementById('panel-list');
const detailEl = document.getElementById('panel-detail');
const searchEl = document.getElementById('search');
let activeSev    = 'all';
let activeCat    = 'all';
let selectedCard = null;

const SEV_ORDER = [
  { key:'critical', label:'Critical', icon:'\u{1F534}', expanded:true  },
  { key:'high',     label:'High',     icon:'\u{1F7E0}', expanded:true  },
  { key:'medium',   label:'Medium',   icon:'\u{1F7E1}', expanded:false },
  { key:'low',      label:'Low',      icon:'\u26AA',    expanded:false },
  { key:'added',    label:'Added',    icon:'\u{1F7E2}', expanded:true  },
  { key:'removed',  label:'Removed',  icon:'\u2B1B',    expanded:true  }
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
  const visualBadge=DIFF_URIS[item.elementId]?'<span class="has-visual">\u{1F4F7} Visual</span>':'';
  return '<div class="element-card" data-key="'+esc(key)+'" data-sev="'+esc(severity)+'" role="button" tabindex="0">'
    +'<div class="card-header"><code class="element-label">'+esc(item.elementKey)+'</code>'
    +'<div class="card-meta">'+badge+visualBadge+conf+'</div></div>'
    +(item.breadcrumb?'<div class="card-breadcrumb">'+esc(item.breadcrumb)+'</div>':'')
    +buildCatPills(item.diffsByCategory)+'</div>';
}

function buildGroup(spec){
  const items=GROUPED.groups[spec.key]??[];
  if(!items.length) return null;
  const el=document.createElement('details');
  el.className='severity-group';
  el.dataset.sev=spec.key;
  if(spec.expanded) el.open=true;
  el.innerHTML='<summary class="severity-header">'
    +'<span class="sev-icon">'+spec.icon+'</span>'
    +'<span class="sev-label">'+spec.label+'</span>'
    +'<span class="sev-count">'+items.length+'</span>'
    +'</summary>'
    +'<div class="severity-body">'+items.map((item,i)=>buildCard(item,spec.key,i)).join('')+'</div>';
  return el;
}

function buildVisualDiffSection(elementId){
  const uris=DIFF_URIS[elementId];
  if(!uris) return '';
  const panelId='vd-'+String(elementId).replace(/[^a-zA-Z0-9-_]/g,'_');
  const legendId='vd-legend-'+String(elementId).replace(/[^a-zA-Z0-9-_]/g,'_');
  function pane(uri,label,labelCls){
    const content=uri
      ?'<img class="vdiff-img" src="'+uri+'" alt="'+label+'" loading="lazy">'
      :'<div class="vdiff-missing">No capture</div>';
    return '<div class="vdiff-pane">'
      +'<div class="vdiff-pane-label '+labelCls+'">'+label+'</div>'
      +content
      +'</div>';
  }
  return '<div class="vdiff-section">'
    +'<button class="vdiff-toggle" aria-expanded="false" aria-controls="'+panelId+'">'
    +'\u{1F4F7} Visual Diff'
    +'<i class="vdiff-chevron">\u2964</i>'
    +'</button>'
    +'<div class="vdiff-panes" id="'+panelId+'" role="region">'
    +pane(uris.baselineUri,'Baseline','label-baseline')
    +pane(uris.diffUri,'Diff','label-diff')
    +pane(uris.compareUri,'Compare','label-compare')
    +'</div>'
    +'<div class="vdiff-legend" id="'+legendId+'" style="display:none">'
    +'<span class="vdiff-legend-item"><span class="legend-dot magenta"></span>Real difference</span>'
    +'<span class="vdiff-legend-item"><span class="legend-dot yellow"></span>Anti-alias artifact</span>'
    +'</div>'
    +'</div>';
}

function renderListAsync(){
  const loading=document.getElementById('list-loading');
  const queue=SEV_ORDER.slice();
  const frag=document.createDocumentFragment();
  function chunk(deadline){
    while(queue.length>0&&(deadline.timeRemaining()>4||deadline.didTimeout)){
      const g=buildGroup(queue.shift());
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

function renderDetail(item){
  if(!item){ detailEl.innerHTML='<div class="detail-placeholder">Select an element</div>'; return; }
  const sel=item.selectors||{};
  const selBtns=[
    sel.xpath?'<button class="sel-btn" data-copy="'+esc(sel.xpath)+'">Copy XPath</button>':'',
    sel.css  ?'<button class="sel-btn" data-copy="'+esc(sel.css)+'">Copy CSS</button>':''
  ].join('');
  const catBlocks=Object.keys(item.diffsByCategory||{}).map(cat=>{
    const rows=item.diffsByCategory[cat].map(d=>{
      const cls=isColorProp(d.property)?' color-diff':'';
      return '<div class="diff-row'+cls+'">'
        +'<span class="diff-prop">'+esc(d.property)+'</span>'
        +'<span class="diff-base">'+swatch(d.baseValue)+esc(d.baseValue??'\u2014')+'</span>'
        +'<span class="diff-arrow">\u2192</span>'
        +'<span class="diff-compare">'+swatch(d.compareValue)+esc(d.compareValue??'\u2014')+sevPip(d.severity||'low')+'</span>'
        +'</div>';
    }).join('');
    return '<div class="detail-category"><div class="cat-title">'+esc(cat)+'</div>'+rows+'</div>';
  }).join('');

  detailEl.innerHTML='<div class="detail-header">'
    +'<div class="detail-tag">'+esc(item.elementKey)+'</div>'
    +(item.breadcrumb?'<div class="detail-breadcrumb">'+esc(item.breadcrumb)+'</div>':'')
    +'<div class="detail-selectors">'+selBtns+'</div>'
    +'</div>'
    +(catBlocks||'<div class="detail-placeholder" style="margin-top:20px">No property diffs</div>')
    +buildVisualDiffSection(item.elementId);

  detailEl.querySelectorAll('[data-copy]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      navigator.clipboard.writeText(btn.dataset.copy).then(()=>{
        const orig=btn.textContent; btn.textContent='Copied!';
        setTimeout(()=>{ btn.textContent=orig; },1200);
      });
    });
  });

  const toggleBtn=detailEl.querySelector('.vdiff-toggle');
  if(toggleBtn){
    toggleBtn.addEventListener('click',()=>{
      const expanded=toggleBtn.getAttribute('aria-expanded')==='true';
      const panes=detailEl.querySelector('.vdiff-panes');
      const key=toggleBtn.getAttribute('aria-controls').replace(/^vd-/,'');
      const legend=detailEl.getElementById
        ? null
        : document.getElementById('vd-legend-'+key);
      const legendEl=detailEl.querySelector('[id^="vd-legend-"]');
      toggleBtn.setAttribute('aria-expanded',String(!expanded));
      if(panes) panes.classList.toggle('open',!expanded);
      if(legendEl) legendEl.style.display=expanded?'none':'flex';
    });
  }
}

function applyFilters(){
  const q=searchEl.value.toLowerCase();
  listEl.querySelectorAll('.severity-group').forEach(group=>{
    const sevMatch=activeSev==='all'||group.dataset.sev===activeSev;
    group.style.display=sevMatch?'':'none';
    group.querySelectorAll('.element-card').forEach(card=>{
      const label=(card.querySelector('.element-label')?.textContent||'').toLowerCase();
      const crumb=(card.querySelector('.card-breadcrumb')?.textContent||'').toLowerCase();
      const textMatch=!q||label.includes(q)||crumb.includes(q);
      const catMatch=activeCat==='all'||Array.from(card.querySelectorAll('.cat-pill')).some(p=>p.textContent.trim().startsWith(activeCat));
      card.style.display=textMatch&&catMatch?'':'none';
    });
  });
}

function attachListHandlers(){
  listEl.addEventListener('click',e=>{
    const card=e.target.closest('.element-card');
    if(!card) return;
    if(selectedCard) selectedCard.classList.remove('selected');
    card.classList.add('selected');
    selectedCard=card;
    const [sev,idx]=card.dataset.key.split(/-(.+)/);
    renderDetail((GROUPED.groups[sev]||[])[parseInt(idx)]||null);
  });
  listEl.addEventListener('keydown',e=>{
    if(e.key===' '&&e.target.classList.contains('element-card')){ e.target.click(); e.preventDefault(); }
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      const cards=Array.from(listEl.querySelectorAll('.element-card:not([style*="none"])'));
      const next=cards[cards.indexOf(document.activeElement)+(e.key==='ArrowDown'?1:-1)];
      if(next){ next.focus(); e.preventDefault(); }
    }
  });
}

document.querySelectorAll('[data-sev].filter-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('[data-sev].filter-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); activeSev=btn.dataset.sev; applyFilters();
  });
});

document.querySelectorAll('[data-cat].filter-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('[data-cat].filter-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); activeCat=btn.dataset.cat; applyFilters();
  });
});

searchEl.addEventListener('input',applyFilters);

document.addEventListener('keydown',e=>{
  if(e.key==='f'&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){ searchEl.focus(); e.preventDefault(); }
  if(e.key==='c'&&selectedCard){
    const sel=GROUPED.groups[selectedCard.dataset.sev]?.[parseInt(selectedCard.dataset.key.split(/-(.+)/)[1])]?.selectors?.css;
    if(sel) navigator.clipboard.writeText(sel);
  }
});

renderListAsync();

})();
`;
}

export { exportToHTML };
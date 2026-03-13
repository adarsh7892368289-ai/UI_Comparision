import logger from '../infrastructure/logger.js';
import { popupState } from './popup-state.js';
import { TabAdapter } from '../infrastructure/chrome-tabs.js';
import { sendToBackground, MessageTypes } from '../infrastructure/chrome-messaging.js';
import {
  loadAllReports, deleteReport, deleteAllReports
} from '../application/report-manager.js';
import {
  exportReport, exportAllReports,
  exportComparison, EXPORT_FORMAT
} from '../application/export-workflow.js';
import { importReportFromFile } from '../application/import-workflow.js';

logger.init();
logger.setContext({ script: 'popup' });



class ToastManager {
  _init() {
    this._root = this._root ?? document.getElementById('toast-root');
  }

  show(message, type = 'info', duration = 3000) {
    this._init();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const text = document.createElement('span');
    text.textContent = message;

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => this._dismiss(toast));

    toast.appendChild(text);
    toast.appendChild(close);
    this._root.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast-visible'));

    if (duration > 0) {setTimeout(() => this._dismiss(toast), duration);}

    while (this._root.children.length > 3) {
      this._dismiss(this._root.firstChild);
    }
  }

  _dismiss(toast) {
    if (!toast?.isConnected) {return;}
    toast.classList.remove('toast-visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }

  success(msg) { this.show(msg, 'success', 3000); }
  error(msg)   { this.show(msg, 'error', 0); }
  warning(msg) { this.show(msg, 'warning', 4000); }
  info(msg)    { this.show(msg, 'info', 3000); }
}

class ModalManager {
  _init() {
    if (this._ready) {return;}
    this._overlay = document.getElementById('modal-overlay');
    this._box     = document.getElementById('modal-box');
    this._resolve = null;
    this._ready   = true;

    this._overlay.addEventListener('click', e => {
      if (e.target === this._overlay) {this._close(false);}
    });
    document.addEventListener('keydown', e => {
      if (!this._resolve) {return;}
      if (e.key === 'Escape') {this._close(false);}
    });
  }

  confirm(title, message, { confirmText = 'Confirm', destructive = false } = {}) {
    this._init();
    return new Promise(resolve => {
      this._resolve = resolve;
      this._box.innerHTML = `
        <p class="modal-title" id="modal-title">${sanitize(title)}</p>
        <p class="modal-message">${sanitize(message)}</p>
        <div class="modal-actions">
          <button class="btn-ghost modal-cancel">Cancel</button>
          <button class="btn-${destructive ? 'destructive' : 'primary'} btn-sm modal-confirm">
            ${sanitize(confirmText)}
          </button>
        </div>`;
      this._overlay.classList.remove('hidden');
      this._box.querySelector('.modal-confirm').focus();
      this._box.querySelector('.modal-cancel').addEventListener('click',  () => this._close(false));
      this._box.querySelector('.modal-confirm').addEventListener('click', () => this._close(true));
    });
  }

  _close(result) {
    this._overlay?.classList.add('hidden');
    const res    = this._resolve;
    this._resolve = null;
    res?.(result);
  }
}

class ProgressManager {
  show(id, label = 'Working…') {
    const wrap = document.getElementById(`${id}-progress`);
    if (wrap) {wrap.classList.remove('hidden');}
    this.update(id, 0, label);
  }

  update(id, pct, label) {
    const bar   = document.getElementById(`${id}-progress-bar`);
    const lbl   = document.getElementById(`${id}-progress-label`);
    const wrap  = document.getElementById(`${id}-progress`);
    if (bar)  { bar.style.width = `${pct}%`; bar.setAttribute('aria-valuenow', pct); }
    if (lbl && label) {lbl.textContent = label;}
    if (wrap) {wrap.setAttribute('aria-valuenow', pct);}
  }

  hide(id) {
    const wrap = document.getElementById(`${id}-progress`);
    if (wrap) {wrap.classList.add('hidden');}
    this.update(id, 0, '');
  }

  simulate(id, estimatedMs, stages = []) {
    const defaultStages = [
      { at: 8,  label: 'Scanning DOM…' },
      { at: 25, label: 'Processing elements…' },
      { at: 55, label: 'Generating selectors…' },
      { at: 80, label: 'Normalizing styles…' },
      { at: 92, label: 'Saving report…' }
    ];
    const activeStages = stages.length ? stages : defaultStages;
    const stepMs = estimatedMs / 100;
    let frame = 0;
    let stopped = false;

    this.show(id, activeStages[0].label);

    const tick = () => {
      if (stopped) {return;}
      frame = Math.min(frame + 1, 92);
      const stage = [...activeStages].reverse().find(s => frame >= s.at);
      this.update(id, frame, stage?.label ?? '');
      setTimeout(tick, stepMs);
    };

    setTimeout(tick, stepMs);

    return {
      done: () => {
        stopped = true;
        this.update(id, 100, 'Complete');
        setTimeout(() => this.hide(id), 500);
      }
    };
  }
}

const Toast    = new ToastManager();
const Modal    = new ModalManager();
const Progress = new ProgressManager();

function sanitize(value) {
  const el = document.createElement('span');
  el.textContent = String(value ?? '');
  return el.innerHTML;
}

function relativeTime(isoString) {
  const mins = Math.floor((Date.now() - new Date(isoString).getTime()) / 60000);
  if (mins < 1)   {return 'just now';}
  if (mins < 60)  {return `${mins}m ago`;}
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   {return `${hrs}h ago`;}
  return `${Math.floor(hrs / 24)}d ago`;
}

function getFilters() {
  const pick = id => document.getElementById(id)?.value.trim();
  const filters = {};
  const cls = pick('filter-class'); if (cls) {filters.class = cls;}
  const id  = pick('filter-id');    if (id)  {filters.id    = id;}
  const tag = pick('filter-tag');   if (tag) {filters.tag   = tag;}
  return Object.keys(filters).length ? filters : null;
}

function hostFromUrl(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

const STAGE_RE = /\b(stage|staging|dev|test|qa|uat|preview|sandbox|canary)\b/i;

function envTag(url) {
  try { return STAGE_RE.test(new URL(url).hostname) ? 'STAGE' : 'PROD'; } catch { return 'PROD'; }
}

function lastPathSegment(url) {
  try {
    const seg = new URL(url).pathname.replace(/\/$/, '').split('/').filter(Boolean).pop();
    return seg ? `/${seg}` : '/';
  } catch { return ''; }
}

function filterLabel(filters) {
  if (!filters) return null;
  return filters.class || filters.id || filters.tag || null;
}

const EXTRACTION_TIMEOUT_MS = 300_000;
const EXTRACTION_POLL_INTERVAL_MS = 3_000;
const EXTRACTION_POLL_MAX_WAIT_MS = 360_000;

async function pollForNewReport(knownIds, maxWaitMs = EXTRACTION_POLL_MAX_WAIT_MS) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, EXTRACTION_POLL_INTERVAL_MS));
    try {
      const reports = await loadAllReports();
      const newReport = reports.find(r => !knownIds.has(r.id));
      if (newReport) {return newReport;}
    } catch {
    }
  }
  return null;
}

async function handleExtraction() {
  const btn = document.getElementById('extract-btn');
  const sim = Progress.simulate('extract', EXTRACTION_TIMEOUT_MS * 0.6, [
    { at: 5,  label: 'Scanning DOM…'           },
    { at: 20, label: 'Processing elements…'     },
    { at: 45, label: 'Generating selectors…'    },
    { at: 70, label: 'Normalizing styles…'      },
    { at: 88, label: 'Saving report…'           }
  ]);
  btn.disabled = true;

  try {
    const response = await sendToBackground(
      MessageTypes.EXTRACT_ELEMENTS,
      { filters: getFilters() },
      EXTRACTION_TIMEOUT_MS
    );
    const {report} = response.data;
    sim.done();
    popupState.dispatch('EXTRACTION_COMPLETE', { report });
    await refreshReports();
    Toast.success(`Extracted ${report.totalElements} elements in ${report.duration}ms`);
  } catch (err) {
    sim.done();
    const errorMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = errorMsg.toLowerCase().includes('timeout');

    if (isTimeout) {
      Toast.info('Extraction is taking longer than expected — waiting for results…');
      const knownIds = new Set(popupState.get().reports.map(r => r.id));
      const report = await pollForNewReport(knownIds);
      if (report) {
        popupState.dispatch('EXTRACTION_COMPLETE', { report });
        await refreshReports();
        Toast.success(`Extracted ${report.totalElements} elements`);
        btn.disabled = false;
        return;
      }
    }

    popupState.dispatch('EXTRACTION_FAILED', { error: errorMsg });
    Toast.error(errorMsg);
    logger.error('Extraction failed', { error: errorMsg });
  } finally {
    btn.disabled = false;
  }
}

async function handleComparison() {
  const state = popupState.get();
  if (!state.selectedBaseline || !state.selectedCompare) {
    Toast.warning('Select both baseline and compare reports');
    return;
  }
  if (state.selectedBaseline === state.selectedCompare) {
    Toast.warning('Select two different reports to compare');
    return;
  }

  const btn = document.getElementById('compare-btn');
  btn.disabled = true;

  Progress.show('compare', 'Connecting…');

  let port = null;
  let portDisconnected = false;

  const cleanup = () => {
    if (port) { try { port.disconnect(); } catch (_) {} port = null; }
    btn.disabled = false;
  };

  const fail = (msg) => {
    cleanup();
    Progress.hide('compare');
    popupState.dispatch('COMPARISON_FAILED', { error: msg });
    Toast.error(msg);
    logger.error('Comparison failed', { error: msg });
  };

  try {
    const baselineReport = state.reports.find(r => r.id === state.selectedBaseline);
    const compareReport  = state.reports.find(r => r.id === state.selectedCompare);
    let baselineTabId = null, compareTabId = null;

    if (baselineReport?.url || compareReport?.url) {
      const allTabs = await chrome.tabs.query({ windowType: 'normal' });
      if (baselineReport?.url) {
        baselineTabId = allTabs.find(t => t.url === baselineReport.url)?.id ?? null;
      }
      if (compareReport?.url) {
        compareTabId = allTabs.find(
          t => t.url === compareReport.url && t.id !== baselineTabId
        )?.id ?? allTabs.find(t => t.url === compareReport.url)?.id ?? null;
      }
    }

    const includeScreenshots = document.getElementById('visual-diff-toggle')?.checked ?? true;

    const baselineIsImported = baselineReport?.source === 'imported';
    const compareIsImported  = compareReport?.source  === 'imported';

    let resolvedIncludeScreenshots = includeScreenshots;
    if (includeScreenshots && (baselineIsImported || compareIsImported)) {
      resolvedIncludeScreenshots = false;
      const toggle = document.getElementById('visual-diff-toggle');
      if (toggle) { toggle.checked = false; toggle.disabled = true; }
      Toast.info('Visual diff disabled — imported reports have no live tab');
    }

    port = chrome.runtime.connect({ name: 'comparison' });

    port.onDisconnect.addListener(() => {
      portDisconnected = true;
      if (btn.disabled) {
        fail('Connection to background lost. The comparison may still complete — check back in a moment.');
      }
    });

    port.onMessage.addListener((msg) => {
      if (msg.type === MessageTypes.COMPARISON_PROGRESS) {
        Progress.update('compare', msg.pct ?? 50, msg.label ?? 'Working…');
        return;
      }

      if (msg.type === MessageTypes.COMPARISON_COMPLETE) {
        const {result} = msg;
        cleanup();
        Progress.update('compare', 100, 'Complete');
        setTimeout(() => Progress.hide('compare'), 500);
        popupState.dispatch('COMPARISON_COMPLETE', { result, cachedAt: null });
        const diffs = result?.comparison?.summary?.propertyDiffCount ?? result?.comparison?.summary?.totalDifferences ?? 0;
        Toast.success(`Done — ${diffs} CSS change${diffs !== 1 ? 's' : ''} found`);
        return;
      }

      if (msg.type === 'comparisonError') {
        fail(msg.error || 'Comparison failed in background');
        
      }
    });

    port.postMessage({
      type:             MessageTypes.START_COMPARISON,
      baselineId:       state.selectedBaseline,
      compareId:        state.selectedCompare,
      mode:             state.compareMode,
      baselineTabId,
      compareTabId,
      includeScreenshots: resolvedIncludeScreenshots
    });

    Progress.update('compare', 5, 'Loading reports…');

  } catch (err) {
    fail(err.message || String(err));
  }
}


async function handleDeleteAll() {
  const confirmed = await Modal.confirm(
    'Delete all reports',
    'This permanently deletes all saved reports. This cannot be undone.',
    { confirmText: 'Delete All', destructive: true }
  );
  if (!confirmed) {return;}

  try {
    const result = await deleteAllReports();
    if (result.success) {
      await refreshReports();
      Toast.success(`Deleted ${result.count} report${result.count !== 1 ? 's' : ''}`);
    } else {
      Toast.error(result.error ?? 'Delete failed');
    }
  } catch (err) {
    Toast.error(err.message);
  }
}

async function handleDeleteReport(report) {
  const confirmed = await Modal.confirm(
    'Delete report',
    `Delete "${report.title || 'Untitled'}"? This cannot be undone.`,
    { confirmText: 'Delete', destructive: true }
  );
  if (!confirmed) {return;}

  try {
    const result = await deleteReport(report.id);
    if (result.success) {
      await refreshReports();
      Toast.success('Report deleted');
    } else {
      Toast.error(result.error ?? 'Delete failed');
    }
  } catch (err) {
    Toast.error(err.message);
  }
}

async function handleImportReport(file, slot) {
  let result = await importReportFromFile(file);

  if (!result.success && result.isDuplicate) {
    const confirmed = await Modal.confirm(
      'Duplicate report',
      `A report from "${result.existingReport.url}" already exists. Replace it?`,
      { confirmText: 'Replace' }
    );
    if (!confirmed) return;
    result = await importReportFromFile(file, { forceReplace: true });
  }

  if (!result.success) {
    Toast.error(result.error);
    return;
  }

  await refreshReports();

  const stateKey = slot === 'baseline' ? 'BASELINE_SELECTED' : 'COMPARE_SELECTED';
  popupState.dispatch(stateKey, { id: result.report.id });
  const selId = slot === 'baseline' ? 'baseline-report' : 'compare-report';
  const sel   = document.getElementById(selId);
  if (sel) sel.value = result.report.id;
  syncCompareButton();

  Toast.success(`Report imported — ${result.report.totalElements} elements`);

  if (result.warning) {
    Toast.warning(result.warning);
  }
}

async function handleExportAll() {
  const format = document.getElementById('export-all-format')?.value ?? 'csv';
  try {
    const result = await exportAllReports(format);
    if (result.success) {
      Toast.success(`Exported ${result.count} reports as ${format.toUpperCase()}`);
    } else {
      Toast.error(result.error ?? 'Export failed');
    }
  } catch (err) {
    Toast.error(err.message);
  }
}

async function handleExportReport(report, format) {
  try {
    if (format === 'json') {
      await exportReport(report, 'json');
    } else if (format === 'excel') {
      await exportReport(report, 'excel');
    } else {
      await exportReport(report, 'csv');
    }
    Toast.success(`Exported as ${format.toUpperCase()}`);
  } catch (err) {
    Toast.error(`Export failed: ${err.message}`);
  }
}

async function handleExportComparison() {
  const state  = popupState.get();
  const result = state.comparisonResult;
  if (!result) { Toast.error('No comparison result to export'); return; }

  const format = document.getElementById('export-format-select')?.value ?? EXPORT_FORMAT.EXCEL;

  if (format === EXPORT_FORMAT.HTML) {
    await _exportHTMLViaBackground(state);
    return;
  }

  const res = await exportComparison(result, format);
  if (res.success) {
    Toast.success(`Exported as ${format.toUpperCase()}`);
  } else {
    Toast.error(`Export failed: ${res.error}`);
  }
}

async function _exportHTMLViaBackground(state) {
  if (!state.selectedBaseline || !state.selectedCompare) {
    Toast.error('No comparison selected');
    return;
  }

  const btn = document.getElementById('export-comparison-btn');
  const vBtn = document.getElementById('view-report-btn');
  if (btn)  {btn.disabled  = true;}
  if (vBtn) {vBtn.disabled = true;}

  try {
    await sendToBackground(MessageTypes.EXPORT_COMPARISON_HTML, {
      baselineId: state.selectedBaseline,
      compareId:  state.selectedCompare,
      mode:       state.compareMode
    }, 120000);
    Toast.success('HTML report downloaded');
  } catch (err) {
    const msg = err.message || 'Export failed';
    Toast.error(`Export failed: ${msg}`);
    logger.error('HTML export via background failed', { error: msg });
  } finally {
    if (btn)  {btn.disabled  = false;}
    if (vBtn) {vBtn.disabled = false;}
  }
}

async function refreshReports() {
  try {
    const reports = await loadAllReports();
    popupState.dispatch('REPORTS_LOADED', { reports });
  } catch (err) {
    logger.error('Failed to refresh reports', { error: err.message });
  }
}

function renderReportCard(report, displayIndex, showEnvBadge) {
  const card = document.createElement('div');
  card.className = 'report-card';
  card.setAttribute('role', 'listitem');

  const host    = hostFromUrl(report.url);
  const path    = lastPathSegment(report.url);
  const filter  = filterLabel(report.filters);
  const env     = envTag(report.url);
  const envHtml = showEnvBadge
    ? `<span class="env-badge env-badge--${env.toLowerCase()}">${sanitize(env)}</span>`
    : '';
  const idxHtml = `<span class="report-index">R${displayIndex}</span>`;

  card.innerHTML = `
    <div class="report-card-body">
      <div class="report-card-header">
        ${idxHtml}
        ${envHtml}
        <span class="meta-host" title="${sanitize(report.url)}">${sanitize(host)}</span>
      </div>
      <div class="report-card-meta">
        <span>${sanitize(report.totalElements)} el</span>
        <span class="meta-sep">·</span>
        <span class="meta-path">${sanitize(path)}</span>
        ${filter ? `<span class="meta-sep">·</span><span class="meta-filter" title="Extraction filter">${sanitize(filter)}</span>` : ''}
        <span class="meta-sep">·</span>
        <span>${relativeTime(report.timestamp)}</span>
        ${report.source === 'imported' ? `<span class="meta-sep">·</span><span class="meta-imported-badge" title="Uploaded from file">↑ imported</span>` : ''}
      </div>
    </div>
    <div class="report-card-actions">
      <details class="export-dropdown">
        <summary class="btn-ghost btn-sm" title="Export options">Export ▾</summary>
        <div class="export-menu">
          <button class="export-menu-item" data-format="excel">Excel</button>
          <button class="export-menu-item" data-format="json">JSON</button>
          <button class="export-menu-item" data-format="csv">CSV</button>
        </div>
      </details>
      <button class="btn-icon-danger" title="Delete report" aria-label="Delete report from ${sanitize(host)}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>
        </svg>
      </button>
    </div>`;

  card.querySelectorAll('.export-menu-item').forEach(btn => {
    btn.addEventListener('click', () => {
      card.querySelector('details').removeAttribute('open');
      handleExportReport(report, btn.dataset.format);
    });
  });

  card.querySelector('.btn-icon-danger').addEventListener('click', () => handleDeleteReport(report));
  return card;
}

function displayReports(reports, searchQuery) {
  const list  = document.getElementById('reports-list');
  const empty = document.getElementById('reports-empty');
  if (!list) {return;}

  const q        = searchQuery?.toLowerCase() ?? '';
  const filtered = q
    ? reports.filter(r =>
        (r.title || '').toLowerCase().includes(q) ||
        (r.url   || '').toLowerCase().includes(q))
    : reports;

  list.textContent = '';

  if (filtered.length === 0) {
    empty?.classList.remove('hidden');
    return;
  }

  empty?.classList.add('hidden');

  const envTags     = reports.map(r => envTag(r.url));
  const hasMultiEnv = envTags.some(e => e === 'STAGE');
  const total       = reports.length;

  const frag = document.createDocumentFragment();
  filtered.forEach(r => {
    const posInAll   = reports.indexOf(r);
    const displayIdx = total - posInAll;
    frag.appendChild(renderReportCard(r, displayIdx, hasMultiEnv));
  });
  list.appendChild(frag);
}

function populateReportSelectors(reports) {
  const total       = reports.length;
  const envTags     = reports.map(r => envTag(r.url));
  const hasMultiEnv = envTags.some(e => e === 'STAGE');

  ['baseline-report', 'compare-report'].forEach(selId => {
    const sel = document.getElementById(selId);
    if (!sel) {return;}
    const current = sel.value;
    sel.textContent = '';
    const placeholder = new Option('Select report…', '');
    sel.appendChild(placeholder);
    reports.forEach((r, i) => {
      const displayIdx = total - i;
      const host       = hostFromUrl(r.url);
      const path       = lastPathSegment(r.url);
      const filter     = filterLabel(r.filters);
      const envPrefix  = hasMultiEnv ? `${envTag(r.url)} · ` : '';
      const importedPrefix = r.source === 'imported' ? '[↑] ' : '';
      const label      = `${importedPrefix}R${displayIdx} · ${envPrefix}${host}${path}${filter ? ` · ${filter}` : ''}`;
      const tooltip    = `R${displayIdx} · ${r.url} · ${r.totalElements} el${filter ? ` · ${filter}` : ''} · ${relativeTime(r.timestamp)}`;
      const opt        = new Option(label, r.id);
      opt.title        = tooltip;
      if (r.id === current) {opt.selected = true;}
      sel.appendChild(opt);
    });
  });
  syncCompareButton();
}

function elementDetailRow(el, status) {
  const tag    = (el.tagName  || 'unknown').toLowerCase();
  const idStr  = el.elementId ? `#${el.elementId}` : '';
  const cls    = el.className?.trim()
    ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
    : '';
  const label  = `${tag}${idStr}${cls}` || 'unknown';
  const hpid   = el.hpid ? `<span class="el-hpid" title="HPID">${sanitize(el.hpid)}</span>` : '';
  const text   = el.textContent?.trim()
    ? `<span class="el-text">"${sanitize(el.textContent.trim().slice(0, 60))}${el.textContent.trim().length > 60 ? '…' : ''}"</span>`
    : '';
  const sel    = el.cssSelector
    ? `<span class="el-sel" title="${sanitize(el.cssSelector)}">${sanitize(el.cssSelector.slice(0, 50))}${el.cssSelector.length > 50 ? '…' : ''}</span>`
    : '';
  const badgeCls = status === 'added' ? 'badge-added' : 'badge-removed';
  const badgeTxt = status === 'added' ? '+' : '−';

  return `<div class="el-row">
    <span class="el-badge ${badgeCls}">${badgeTxt}</span>
    <div class="el-info">
      <span class="el-label">${sanitize(label)}</span>
      ${hpid}${text}${sel}
    </div>
  </div>`;
}

function displayComparisonResults(result, cachedAt = null) {
  const container = document.getElementById('compare-results');
  if (!container || !result) {return;}

  const { matching, comparison, mode, duration } = result;
  const { summary: { severityCounts, severityBreakdown, totalDifferences, propertyDiffCount, modifiedElements, unchangedElements } } = comparison;
  const { critical, high, medium, low } = severityBreakdown ?? severityCounts;
  // severityCounts now counts elements by overallSeverity (not per-property events).
  // Use their sum as the severity bar denominator — accurate element-level percentages.
  const sevTotal = critical + high + medium + low || 1;

  const added   = result.unmatchedElements?.compare  ?? [];
  const removed = result.unmatchedElements?.baseline ?? [];

  const severityRow = (label, count, type) => count === 0 ? '' : `
    <div class="sev-row">
      <span class="badge badge-${type}">${label}</span>
      <div class="sev-bar-wrap">
        <div class="sev-bar-fill sev-${type}"
             style="width:${sevTotal > 0 ? ((count / sevTotal) * 100).toFixed(1) : 0}%">
        </div>
      </div>
      <span class="sev-count">${count}</span>
    </div>`;

  const rateClass = critical > 0 ? 'rate-critical' : high > 0 ? 'rate-high' : 'rate-ok';

  const totalElements   = matching.totalMatched + matching.unmatchedBaseline + matching.unmatchedCompare;
  const unmatchedTotal  = matching.unmatchedBaseline + matching.unmatchedCompare;

  // Added/removed element detail panels (capped at 20 to keep popup lean)
  const DETAIL_CAP = 20;
  const addedRows   = added.slice(0, DETAIL_CAP).map(el => elementDetailRow(el, 'added')).join('');
  const removedRows = removed.slice(0, DETAIL_CAP).map(el => elementDetailRow(el, 'removed')).join('');
  const addedOverflow   = added.length   > DETAIL_CAP ? `<div class="el-overflow">+${added.length   - DETAIL_CAP} more — export for full list</div>` : '';
  const removedOverflow = removed.length > DETAIL_CAP ? `<div class="el-overflow">+${removed.length - DETAIL_CAP} more — export for full list</div>` : '';

  container.innerHTML = `
    <div class="result-card">
      <div class="result-header">
        <div class="result-match-rate ${rateClass}">
          <span class="rate-value">${matching.matchRate}%</span>
          <span class="rate-label">matched</span>
        </div>
        <div class="result-meta">
          <span class="result-mode-badge">${sanitize(mode)}</span>
          <span class="result-duration">${duration}ms</span>
          ${cachedAt ? `<span class="result-cached-badge" title="Loaded from cache — run Compare to refresh">Cached · ${relativeTime(cachedAt)}</span>` : ''}
        </div>
      </div>

      <!-- Matching breakdown -->
      <div class="match-breakdown">
        <div class="match-breakdown-title">Element Coverage — ${totalElements} total</div>
        <div class="match-breakdown-row">
          <div class="mbr-item mbr-matched">
            <div class="mbr-val">${matching.totalMatched}</div>
            <div class="mbr-lbl">Matched</div>
          </div>
          <div class="mbr-item mbr-modified">
            <div class="mbr-val">${modifiedElements}</div>
            <div class="mbr-lbl">Modified</div>
          </div>
          <div class="mbr-item mbr-unchanged">
            <div class="mbr-val">${unchangedElements}</div>
            <div class="mbr-lbl">Unchanged</div>
          </div>
          <div class="mbr-item mbr-unmatched">
            <div class="mbr-val">${unmatchedTotal}</div>
            <div class="mbr-lbl">Unmatched</div>
          </div>
        </div>
        <div class="match-bar-wrap">
          <div class="match-bar-seg match-bar-unchanged"
               style="width:${totalElements > 0 ? (unchangedElements / totalElements * 100).toFixed(1) : 0}%"
               title="${unchangedElements} unchanged"></div>
          <div class="match-bar-seg match-bar-modified"
               style="width:${totalElements > 0 ? (modifiedElements / totalElements * 100).toFixed(1) : 0}%"
               title="${modifiedElements} modified"></div>
          <div class="match-bar-seg match-bar-added"
               style="width:${totalElements > 0 ? (added.length / totalElements * 100).toFixed(1) : 0}%"
               title="${added.length} added"></div>
          <div class="match-bar-seg match-bar-removed"
               style="width:${totalElements > 0 ? (removed.length / totalElements * 100).toFixed(1) : 0}%"
               title="${removed.length} removed"></div>
        </div>
      </div>

      ${sevTotal > 0 ? `
        <div class="severity-section">
          <div class="severity-section-title">Severity — ${propertyDiffCount ?? totalDifferences} CSS property change${(propertyDiffCount ?? totalDifferences) !== 1 ? 's' : ''} across ${critical+high+medium+low} modified element${(critical+high+medium+low) !== 1 ? 's' : ''}</div>
          ${severityRow('Critical', critical, 'critical')}
          ${severityRow('High', high, 'high')}
          ${severityRow('Medium', medium, 'medium')}
          ${severityRow('Low', low, 'low')}
        </div>` : '<div class="no-diffs">✓ No style differences in matched elements</div>'}

      ${added.length > 0 ? `
        <details class="el-section">
          <summary class="el-section-summary">
            <span class="badge badge-added">+${added.length}</span>
            Added in compare
          </summary>
          <div class="el-list">${addedRows}${addedOverflow}</div>
        </details>` : ''}

      ${removed.length > 0 ? `
        <details class="el-section">
          <summary class="el-section-summary">
            <span class="badge badge-removed">−${removed.length}</span>
            Removed from baseline
          </summary>
          <div class="el-list">${removedRows}${removedOverflow}</div>
        </details>` : ''}

      ${matching.ambiguousCount > 0 ? `
        <div class="ambiguous-note">
          ⚠ ${matching.ambiguousCount} element${matching.ambiguousCount !== 1 ? 's' : ''} had ambiguous matches — see full report for details
        </div>` : ''}

      <div class="result-actions">
        <div class="export-format-row">
          <select class="select" id="export-format-select" aria-label="Export format">
            <option value="excel">Excel</option>
            <option value="csv">CSV</option>
            <option value="html">HTML</option>
            <option value="json">JSON</option>
          </select>
          <button class="btn-ghost btn-sm" id="export-comparison-btn">Export</button>
        </div>
        <button class="btn-primary btn-sm" id="view-report-btn">Full Report</button>
      </div>
    </div>`;

  container.querySelector('#export-comparison-btn')
    ?.addEventListener('click', handleExportComparison);
  container.querySelector('#view-report-btn')
    ?.addEventListener('click', () => _exportHTMLViaBackground(popupState.get()));
}

function displayReportsFooter(count) {
  const footer = document.getElementById('reports-footer');
  if (!footer) {return;}
  footer.textContent = count === 0 ? '' : `${count} report${count !== 1 ? 's' : ''} saved`;
}

async function tryLoadCachedComparison() {
  const state = popupState.get();
  if (!state.selectedBaseline || !state.selectedCompare) {return;}

  try {
    const response = await sendToBackground(MessageTypes.LOAD_CACHED_COMPARISON, {
      baselineId: state.selectedBaseline,
      compareId:  state.selectedCompare,
      mode:       state.compareMode
    });
    const cached = response?.data?.cached;

    if (cached) {
      const reconstructed = {
        baseline:          cached.baseline,
        compare:           cached.compare,
        mode:              cached.mode,
        matching:          cached.matching,
        comparison:        { summary: cached.summary, results: cached.results ?? [] },
        unmatchedElements: cached.unmatchedElements,
        duration:          cached.duration,
        timestamp:         cached.timestamp,
        visualDiffs:       cached.visualDiffs ?? null,
        visualDiffStatus:  cached.visualDiffStatus ?? null
      };
      popupState.dispatch('COMPARISON_COMPLETE', {
        result:   reconstructed,
        cachedAt: cached.timestamp
      });
    } else {
      popupState.dispatch('RESET_COMPARISON', {});
    }
  } catch (err) {
    logger.warn('Failed to load cached comparison', { error: err instanceof Error ? err.message : String(err) });
    popupState.dispatch('RESET_COMPARISON', {});
  }
}

function syncCompareButton() {
  const state = popupState.get();
  const btn   = document.getElementById('compare-btn');
  if (btn) {btn.disabled = !state.selectedBaseline || !state.selectedCompare;}
}

function updateUIFromState(state, type) {
  switch (type) {
    case 'TAB_CHANGED': {
      document.querySelectorAll('[role="tab"]').forEach(t => {
        const active = t.dataset.tab === state.activeTab;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('[role="tabpanel"]').forEach(p => {
        p.hidden = p.id !== `panel-${state.activeTab}`;
      });
      break;
    }
    case 'REPORTS_LOADED':
    case 'REPORT_DELETED':
      displayReports(state.reports, state.search);
      populateReportSelectors(state.reports);
      displayReportsFooter(state.reports.length);
      break;
    case 'SEARCH_CHANGED':
      displayReports(state.reports, state.search);
      break;
    case 'COMPARISON_COMPLETE':
      displayComparisonResults(state.comparisonResult, state.cachedAt);
      break;
    case 'BASELINE_SELECTED':
    case 'COMPARE_SELECTED':
      syncCompareButton();
      break;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  logger.info('Popup opened');

  const tab = await TabAdapter.getActiveTab();
  if (tab?.url) {
    const urlEl = document.getElementById('header-url');
    if (urlEl) {
      urlEl.textContent = hostFromUrl(tab.url);
      urlEl.title       = tab.url;
    }
  }

  document.querySelectorAll('[role="tab"]').forEach(btn => {
    btn.addEventListener('click', () => popupState.dispatch('TAB_CHANGED', { tab: btn.dataset.tab }));
  });

  document.getElementById('extract-btn')?.addEventListener('click', handleExtraction);
  document.getElementById('compare-btn')?.addEventListener('click', handleComparison);
  document.getElementById('delete-all-btn')?.addEventListener('click', handleDeleteAll);
  document.getElementById('export-all-btn')?.addEventListener('click', handleExportAll);

  ['baseline', 'compare'].forEach(slot => {
    const input = document.getElementById(`${slot}-upload`);
    if (!input) return;
    input.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      input.value = '';
      handleImportReport(file, slot);
    });
  });

  document.getElementById('baseline-report')?.addEventListener('change', e => {
    popupState.dispatch('BASELINE_SELECTED', { id: e.target.value });
    tryLoadCachedComparison();
  });
  document.getElementById('compare-report')?.addEventListener('change', e => {
    popupState.dispatch('COMPARE_SELECTED', { id: e.target.value });
    tryLoadCachedComparison();
  });
  document.querySelectorAll('[name="compare-mode"]').forEach(r => {
    r.addEventListener('change', e => {
      if (e.target.checked) {
        popupState.dispatch('MODE_CHANGED', { mode: e.target.value });
        tryLoadCachedComparison();
      }
    });
  });

  let searchDebounce;
  document.getElementById('search-reports')?.addEventListener('input', e => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      popupState.dispatch('SEARCH_CHANGED', { query: e.target.value });
    }, 250);
  });

  document.addEventListener('keydown', e => {
    const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (inInput) {return;}

    if (e.key === '1') {popupState.dispatch('TAB_CHANGED', { tab: 'extract' });}
    if (e.key === '2') {popupState.dispatch('TAB_CHANGED', { tab: 'compare' });}
    if (e.key === '/') {
      e.preventDefault();
      document.getElementById('search-reports')?.focus();
    }
    if (e.key === 'Escape') {
      const search = document.getElementById('search-reports');
      if (search?.value) {
        search.value = '';
        popupState.dispatch('SEARCH_CHANGED', { query: '' });
      }
    }
  });

  popupState.subscribe((state, type) => updateUIFromState(state, type));

  await refreshReports();

  try {
    const session = await chrome.storage.session.get('pendingComparison');
    const handoff = session?.pendingComparison;
    const HANDOFF_TTL_MS = 30_000;
    const isStale = !handoff?.timestamp || (Date.now() - handoff.timestamp > HANDOFF_TTL_MS);

    if (handoff?.baselineId && handoff?.compareId && !isStale) {
      const baselineSel = document.getElementById('baseline-report');
      const compareSel  = document.getElementById('compare-report');
      if (baselineSel) baselineSel.value = handoff.baselineId;
      if (compareSel)  compareSel.value  = handoff.compareId;
      popupState.dispatch('BASELINE_SELECTED', { id: handoff.baselineId });
      popupState.dispatch('COMPARE_SELECTED',  { id: handoff.compareId });
      if (handoff.mode) popupState.dispatch('MODE_CHANGED', { mode: handoff.mode });
      popupState.dispatch('TAB_CHANGED', { tab: 'compare' });
      await tryLoadCachedComparison();
      await chrome.storage.session.remove('pendingComparison');
    } else {
      if (handoff) {
        await chrome.storage.session.remove('pendingComparison');
      }
      await tryLoadCachedComparison();
    }
  } catch {
    await tryLoadCachedComparison();
  }

  logger.info('Popup initialized');
});
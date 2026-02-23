import { get } from '../../config/defaults.js';

const T0_TAGS = new Set([
  'SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT', 'BR', 'HR',
  'HEAD', 'TITLE', 'BASE', 'TEMPLATE', 'SLOT', 'WBR', 'PARAM',
  'TRACK', 'SOURCE', 'AREA', 'COL', 'COLGROUP'
]);

const T3_TAGS = new Set([
  'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'A', 'DIALOG',
  'DETAILS', 'OUTPUT', 'METER', 'PROGRESS', 'OPTION', 'OPTGROUP'
]);

const T3_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'textbox', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab',
  'treeitem', 'gridcell'
]);

const T2_TAGS = new Set([
  'P', 'SPAN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'IMG', 'SVG',
  'CANVAS', 'VIDEO', 'AUDIO', 'PICTURE', 'BLOCKQUOTE', 'PRE', 'CODE',
  'STRONG', 'EM', 'FIGURE', 'FIGCAPTION', 'TIME', 'ADDRESS', 'Q',
  'MARK', 'INS', 'DEL', 'ABBR', 'CITE', 'DFN', 'KBD', 'SAMP', 'VAR',
  'SMALL', 'SUB', 'SUP', 'DL', 'DT', 'DD', 'IFRAME'
]);

const SKELETON_CLASS_PATTERNS = /\b(?:skeleton|shimmer|placeholder|loading|spinner)\b/i;

function isTierZero(element) {
  return T0_TAGS.has(element.tagName);
}

function classifyTier(element) {
  const tag = element.tagName;

  if (T0_TAGS.has(tag)) {
    return 'T0';
  }

  if (T3_TAGS.has(tag)) {
    return 'T3';
  }

  const role = element.getAttribute('role');
  if (role && T3_ROLES.has(role)) {
    return 'T3';
  }

  if (T2_TAGS.has(tag)) {
    return 'T2';
  }

  return 'T1';
}

function isVisible(computedStyle, rect) {
  if (!computedStyle) {
    return false;
  }
  return (
    computedStyle.display !== 'none' &&
    computedStyle.visibility !== 'hidden' &&
    parseFloat(computedStyle.opacity) > 0 &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function hasSkeleton(element) {
  const cls = element.getAttribute('class') ?? '';
  return SKELETON_CLASS_PATTERNS.test(cls);
}

function matchesFilters(element, filters) {
  if (!filters) {
    return true;
  }

  const { class: classFilter, id: idFilter, tag: tagFilter } = filters;

  if (classFilter) {
    const filterClasses = classFilter.split(',').map(c => c.trim().replace(/^\./, '')).filter(Boolean);
    if (filterClasses.length > 0) {
      const elementClasses = (element.getAttribute('class') ?? '').split(/\s+/);
      const hasMatch = filterClasses.some(fc => elementClasses.includes(fc));
      if (!hasMatch) {
        return false;
      }
    }
  }

  if (idFilter) {
    const filterIds = idFilter.split(',').map(i => i.trim().replace(/^#/, '')).filter(Boolean);
    if (filterIds.length > 0 && !filterIds.includes(element.id)) {
      return false;
    }
  }

  if (tagFilter) {
    const filterTags = tagFilter.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
    if (filterTags.length > 0 && !filterTags.includes(element.tagName)) {
      return false;
    }
  }

  return true;
}

function shouldSkipTag(element) {
  const irrelevantTags = get('extraction.irrelevantTags');
  return irrelevantTags.includes(element.tagName.toUpperCase());
}

export { isTierZero, classifyTier, isVisible, hasSkeleton, matchesFilters, shouldSkipTag, T0_TAGS };
import { get } from '../../config/defaults.js';

function shouldSkipElement(element) {
  return get('extraction.irrelevantTags').includes(element.tagName.toUpperCase());
}

function matchesClass(element, classFilter) {
  if (!classFilter) return true;
  const classes = classFilter.split(',').map(c => c.trim()).filter(Boolean);
  if (classes.length === 0) return true;
  if (typeof element.className !== 'string') return false;
  const elementClasses = element.className.split(/\s+/);
  return classes.some(fc => {
    const name = fc.startsWith('.') ? fc.slice(1) : fc;
    return elementClasses.includes(name);
  });
}

function matchesId(element, idFilter) {
  if (!idFilter) return true;
  const ids = idFilter.split(',').map(i => i.trim()).filter(Boolean);
  if (ids.length === 0) return true;
  if (!element.id) return false;
  return ids.some(fi => {
    const id = fi.startsWith('#') ? fi.slice(1) : fi;
    return element.id === id;
  });
}

function matchesTag(element, tagFilter) {
  if (!tagFilter) return true;
  const tags = tagFilter.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  if (tags.length === 0) return true;
  return tags.includes(element.tagName.toUpperCase());
}

function matchesFilters(element, filters) {
  if (!filters) return true;
  return (
    matchesClass(element, filters.class) &&
    matchesId(element, filters.id) &&
    matchesTag(element, filters.tag)
  );
}

export { shouldSkipElement, matchesClass, matchesId, matchesTag, matchesFilters };
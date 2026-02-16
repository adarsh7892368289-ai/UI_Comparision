function matchesTag(element, tagFilter) {
  if (!tagFilter) return true;

  const tags = tagFilter
    .split(',')
    .map(t => t.trim().toUpperCase())
    .filter(t => t.length > 0);

  if (tags.length === 0) return true;

  const elementTag = element.tagName.toUpperCase();
  return tags.includes(elementTag);
}

export { matchesTag };
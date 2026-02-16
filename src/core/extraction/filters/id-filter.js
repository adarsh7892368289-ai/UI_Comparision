function matchesId(element, idFilter) {
  if (!idFilter) return true;

  const ids = idFilter
    .split(',')
    .map(i => i.trim())
    .filter(i => i.length > 0);

  if (ids.length === 0) return true;

  const elementId = element.id;
  if (!elementId) return false;

  return ids.some(filterId => {
    const id = filterId.startsWith('#') 
      ? filterId.slice(1) 
      : filterId;
    return elementId === id;
  });
}

export { matchesId };
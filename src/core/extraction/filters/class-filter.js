function matchesClass(element, classFilter) {
  if (!classFilter) return true;

  const classes = classFilter
    .split(',')
    .map(c => c.trim())
    .filter(c => c.length > 0);

  if (classes.length === 0) return true;

  const elementClasses = element.className;
  if (typeof elementClasses !== 'string') return false;

  return classes.some(filterClass => {
    const className = filterClass.startsWith('.') 
      ? filterClass.slice(1) 
      : filterClass;
    return elementClasses.split(/\s+/).includes(className);
  });
}

export { matchesClass };
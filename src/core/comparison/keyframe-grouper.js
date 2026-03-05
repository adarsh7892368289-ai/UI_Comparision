const KF_PREFIX = 'kf';

function elementCenterY(element) {
  return element.documentY + element.height / 2;
}

function clampScrollY(raw, viewportHeight, documentHeight) {
  if (documentHeight <= viewportHeight) return 0;
  return Math.floor(Math.max(0, Math.min(raw, documentHeight - viewportHeight)));
}

function buildGroup(index, anchorCy, viewportHeight, viewportWidth, documentHeight) {
  const rawScroll = anchorCy - viewportHeight / 2;
  return {
    id:             `${KF_PREFIX}_${index}`,
    scrollY:        clampScrollY(rawScroll, viewportHeight, documentHeight),
    viewportWidth,
    viewportHeight,
    elementIds:     [],
    anchorCy
  };
}

function toPublicGroup(group) {
  const { anchorCy, ...rest } = group;
  return rest;
}

function groupIntoKeyframes(elements, viewportHeight, viewportWidth, documentHeight) {
  if (!elements || elements.length === 0) return [];

  const sorted    = [...elements].sort((a, b) => elementCenterY(a) - elementCenterY(b));
  const threshold = viewportHeight * 0.5;
  const groups    = [];

  for (const el of sorted) {
    const cy   = elementCenterY(el);
    const last = groups[groups.length - 1];

    if (last && cy - last.anchorCy <= threshold) {
      last.elementIds.push(el.id);
    } else {
      const group = buildGroup(groups.length, cy, viewportHeight, viewportWidth, documentHeight);
      group.elementIds.push(el.id);
      groups.push(group);
    }
  }

  return groups.map(toPublicGroup);
}

export { groupIntoKeyframes };
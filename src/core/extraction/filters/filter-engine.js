import { get } from '../../../config/defaults.js';

function shouldSkipElement(element) {
  const irrelevantTags = get('extraction.irrelevantTags', []);
  return irrelevantTags.includes(element.tagName.toUpperCase());
}

export { shouldSkipElement };

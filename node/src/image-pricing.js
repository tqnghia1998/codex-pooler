// Reviewed 2026-11-09 against the official model pages and pricing feed.
// USD per million tokens. Do not use host Responses token counts as image usage.
export const IMAGE_PRICING = Object.freeze({
  'gpt-image-2.6-flare': Object.freeze({ textInput: 5, cachedTextInput: 1.25, imageInput: 8, cachedImageInput: 2, imageOutput: 30 }),
  'gpt-image-2.6-sunburst': Object.freeze({ textInput: 5, cachedTextInput: 1.25, imageInput: 8, cachedImageInput: 2, imageOutput: 30 })
});
export const IMAGE_PRICING_SOURCES = Object.freeze([
  'https://developers.openai.com/api/docs/models/gpt-image-2.6-flare',
  'https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst'
]);

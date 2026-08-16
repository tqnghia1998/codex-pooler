const OPTIONAL_FIELDS = Object.freeze({
  codex: Object.freeze(['max_output_tokens', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_p']),
  compass: Object.freeze(['temperature', 'top_k', 'top_p'])
});
const COMPATIBILITY_VALUE_KEYS = new Set(['unsupportedFields', 'adaptiveThinking']);

export function compatibilityOptionalFields(provider) {
  return OPTIONAL_FIELDS[provider] || [];
}

export function isCompatibilityOptionalField(provider, field) {
  return compatibilityOptionalFields(provider).includes(field);
}

export function safeCompatibilityValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !COMPATIBILITY_VALUE_KEYS.has(key))) return false;
  if (value.adaptiveThinking !== undefined && value.adaptiveThinking !== true) return false;
  return value.unsupportedFields === undefined || Array.isArray(value.unsupportedFields)
    && value.unsupportedFields.length <= 5
    && value.unsupportedFields.every((field) => typeof field === 'string' && /^[a-z_]{1,40}$/.test(field));
}

export function validCompatibilityFeature(provider, feature, value) {
  if (!safeCompatibilityValue(value)) return false;
  if (feature === 'adaptive_thinking') return provider === 'compass' && value.adaptiveThinking === true;
  const field = typeof feature === 'string' && feature.startsWith('unsupported_field:')
    ? feature.slice('unsupported_field:'.length)
    : '';
  return isCompatibilityOptionalField(provider, field) && value.unsupportedFields?.includes(field);
}

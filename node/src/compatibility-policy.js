const CODEX_OPTIONAL_FIELDS = Object.freeze(['max_output_tokens', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_p']);
const COMPASS_OPTIONAL_FIELDS = Object.freeze({
  messages: Object.freeze(['temperature', 'top_k', 'top_p']),
  chat_completions: Object.freeze(['temperature', 'top_p']),
  responses: Object.freeze(['temperature', 'top_p'])
});
const COMPATIBILITY_VALUE_KEYS = new Set(['unsupportedFields', 'adaptiveThinking']);

export function compatibilityOptionalFields(provider, route = '') {
  if (provider === 'codex') return CODEX_OPTIONAL_FIELDS;
  if (provider !== 'compass') return [];
  const routeClass = compatibilityRouteClass(route);
  if (routeClass) return COMPASS_OPTIONAL_FIELDS[routeClass] || [];
  return [...new Set(Object.values(COMPASS_OPTIONAL_FIELDS).flat())];
}

export function isCompatibilityOptionalField(provider, field, route = '') {
  return compatibilityOptionalFields(provider, route).includes(field);
}

export function safeCompatibilityValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !COMPATIBILITY_VALUE_KEYS.has(key))) return false;
  if (value.adaptiveThinking !== undefined && value.adaptiveThinking !== true) return false;
  return value.unsupportedFields === undefined || Array.isArray(value.unsupportedFields)
    && value.unsupportedFields.length <= 5
    && value.unsupportedFields.every((field) => typeof field === 'string' && /^[a-z_]{1,40}$/.test(field));
}

export function validCompatibilityFeature(provider, feature, value, route = '') {
  if (!safeCompatibilityValue(value)) return false;
  if (feature === 'adaptive_thinking') return provider === 'compass' && compatibilityRouteClass(route) === 'messages' && value.adaptiveThinking === true;
  const field = typeof feature === 'string' && feature.startsWith('unsupported_field:')
    ? feature.slice('unsupported_field:'.length)
    : '';
  return isCompatibilityOptionalField(provider, field, route)
    && value.unsupportedFields?.includes(field)
    && value.unsupportedFields.every((name) => isCompatibilityOptionalField(provider, name, route));
}

function compatibilityRouteClass(route) {
  if (route === '/v1/messages' || route === 'messages') return 'messages';
  if (route === '/v1/chat/completions' || route === 'chat_completions') return 'chat_completions';
  if (route === '/v1/responses' || route === 'responses') return 'responses';
  if (route === '/v1/responses/compact' || route === 'responses_compact') return 'responses_compact';
  return '';
}

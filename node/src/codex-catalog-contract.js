import { createHash } from 'node:crypto';

export const CODEX_CATALOG_VERIFIED_RANGE = Object.freeze(['0.154.0', '0.162.0']);
const string = (value) => typeof value === 'string';
const bool = (value) => typeof value === 'boolean';
const effort = (value) => string(value) && value.length > 0;
const i64 = (value) => {
  if (!Number.isInteger(value) || Math.abs(value) > 9223372036854775808) return false;
  // Check the decimal sent on the wire, not the rounded binary number.
  const encoded = BigInt(JSON.stringify(value));
  return encoded >= -9223372036854775808n && encoded <= 9223372036854775807n;
};
const i32 = (value) => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
const enumeration = (...values) => (value) => values.includes(value)
  || object(value) && Object.keys(value).length === 1 && values.includes(Object.keys(value)[0]) && Object.values(value)[0] === null;
const list = (check) => (value) => Array.isArray(value) && value.every((item) => item !== null && check(item));
// Positional serde structs and fields added inside the window stay unjudged.
const struct = (fields) => (value) => Array.isArray(value) || object(value) && validFields(value, fields);
const required = (check) => ['required', check];
const optional = (check) => ['optional', check];
const defaulted = (check) => ['defaulted', check];
const fields = {
  slug: required(string), display_name: required(string), description: optional(string),
  default_reasoning_level: optional(effort),
  supported_reasoning_levels: required(list(struct({ effort: required(effort), description: required(string) }))),
  shell_type: required(enumeration('unified_exec', 'disabled', 'default', 'local', 'shell_command')),
  visibility: required(enumeration('list', 'hide', 'none')), supported_in_api: required(bool), priority: required(i32),
  additional_speed_tiers: defaulted(list(string)),
  service_tiers: defaulted(list(struct({ id: required(string), name: required(string), description: required(string) }))),
  default_service_tier: optional(string), availability_nux: optional(struct({ message: required(string) })),
  upgrade: optional(struct({ model: required(string), migration_markdown: required(string) })),
  model_messages: optional(struct({ instructions_template: optional(string) })),
  include_skills_usage_instructions: defaulted(bool), include_plugin_usage_instructions: defaulted(bool),
  include_apps_usage_instructions: defaulted(bool), supports_reasoning_summary_parameter: defaulted(bool),
  default_reasoning_summary: defaulted(enumeration('auto', 'concise', 'detailed', 'none')),
  support_verbosity: required(bool), default_verbosity: optional(enumeration('low', 'medium', 'high')),
  apply_patch_tool_type: optional(enumeration('freeform')), web_search_tool_type: defaulted(enumeration('text', 'text_and_image')),
  truncation_policy: required(struct({ mode: required(enumeration('bytes', 'tokens')), limit: required(i64) })),
  supports_image_detail_original: defaulted(bool), context_window: optional(i64), max_context_window: optional(i64),
  auto_compact_token_limit: optional(i64), comp_hash: optional(string), effective_context_window_percent: defaulted(i64),
  experimental_supported_tools: required(list(string)), input_modalities: defaulted(list(enumeration('text', 'image', 'audio'))),
  supports_search_tool: defaulted(bool), use_responses_lite: defaulted(bool), node_repl_auto_review_required: defaulted(bool),
  node_repl_disabled: defaulted(bool), auto_review_model_override: optional(string), model_specialty: optional(string),
  tool_mode: optional(string), multi_agent_version: optional(string), multi_agent_reasoning_effort: optional(effort),
  base_instructions: optional(string)
};

export function codexCatalogDecodable(model) {
  return object(model) && validFields(model, fields) && (string(model.base_instructions)
    || string(model.model_messages?.instructions_template) || Array.isArray(model.model_messages));
}

export function codexCatalogRepresentation(userAgent) {
  if (typeof userAgent !== 'string' || /[\x00-\x1f\x7f]/.test(userAgent) || userAgent.length > 1024) return 'verbatim';
  const named = /^([^/]{1,64})\/(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?=[\s(+-]|$)(.*)$/.exec(userAgent);
  const match = named && (/^codex(?:[ _-]|$)/i.test(named[1]) || /^\S*\s\([^();]+;[^();]+\)/.test(named[5]))
    ? named.slice(2, 5)
    : /^[^\x00-\x1f\x7f]{1,512}?\/(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:[-+][0-9A-Za-z.+-]{0,64})?\s\([^();]+;[^();]+\)/.exec(userAgent)?.slice(1, 4);
  if (!match) return 'verbatim';
  const version = match.map(Number);
  if (compare(version, [0, 154, 0]) >= 0 && compare(version, [0, 162, 0]) <= 0) return 'decode_checked';
  return compare(version, [0, 148, 0]) >= 0 ? 'instructions_template' : 'verbatim';
}

export function projectCodexCatalog(catalog, userAgent) {
  if (!catalog) return catalog;
  const representation = codexCatalogRepresentation(userAgent);
  if (representation === 'verbatim') return catalog;
  const nativeModels = catalog.nativeModels.filter((model) => representation !== 'decode_checked' || codexCatalogDecodable(model))
    .map((model) => {
      if (!string(model.model_messages?.instructions_template)) return model;
      const { base_instructions: _base, ...rest } = model;
      return rest;
    });
  const etag = `W/"cp-models-v1-${createHash('sha256').update(canonicalJson({ models: nativeModels })).digest('hex')}"`;
  return { ...catalog, nativeModels, etag };
}

function validFields(value, specification) {
  return Object.entries(specification).every(([key, [presence, check]]) => {
    if (!Object.hasOwn(value, key)) return presence !== 'required';
    if (value[key] === null) return presence === 'optional';
    return check(value[key]);
  });
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function compare(left, right) { for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i]; return 0; }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

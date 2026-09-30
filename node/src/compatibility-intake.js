import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  COMPATIBILITY_FIXTURE_PROFILES,
  summarizeJsonShape,
  validateCompatibilityFixture,
  withUpdatedCompatibilityExpectation
} from './compatibility-fixtures.js';

export const COMPATIBILITY_CAPTURE_SCHEMA_VERSION = 1;

const PROFILE_SET = new Set(COMPATIBILITY_FIXTURE_PROFILES);
const CAPTURE_ROOT_KEYS = new Set(['schemaVersion', 'profile', 'client', 'request', 'response']);
const CLIENT_KEYS = new Set(['family', 'version']);
const REQUEST_KEYS = new Set(['path', 'headers', 'body', 'generate']);
const RESPONSE_KEYS = new Set(['status', 'body']);
const NEGOTIATION_HEADERS = new Set(['version', 'originator', 'openai-beta', 'anthropic-version', 'anthropic-beta']);
const CODEX_NEGOTIATION_HEADERS = new Set(['version', 'originator', 'openai-beta']);
const COMPASS_NEGOTIATION_HEADERS = new Set(['anthropic-version', 'anthropic-beta']);
const NO_NEGOTIATION_HEADERS = new Set();
const DROP_KEYS = /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|host|chatgpt[-_]?account[-_]?id|x[-_]?api[-_]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|client[-_]?secret|project[-_]?key|project[-_]?id|account[-_]?id|password|token|secret)$/i;
const CONTENT_KEYS = /^(?:text|content|input|instructions|message|detail|system|prompt|description|output|value)$/i;
const ID_KEYS = /(?:^|_)(?:id|identifier)$/i;
const NAME_KEYS = /^(?:name|filename)$/i;
const URL_KEYS = /(?:url|uri)$/i;
const BINARY_KEYS = /^(?:data|file_data|audio|image)$/i;
const ENUM_KEYS = new Set([
  'type', 'role', 'effort', 'service_tier', 'include', 'status', 'format', 'execution',
  'tool_choice', 'verbosity', 'mode', 'purpose'
]);
const DYNAMIC_KEYS = new Set([
  'properties', 'patternProperties', '$defs', 'definitions', 'metadata',
  'arguments', 'value', 'output'
]);
const RECURSIVE_DYNAMIC_KEYS = new Set(['metadata', 'arguments', 'value', 'output']);
const SCHEMA_NAME_ARRAY_KEYS = new Set(['required']);
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._=:+/-]{0,255}$/;
const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]{0,127}$/;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_STRING_BYTES = 64 * 1024;
const MAX_DEPTH = 20;
const MAX_NODES = 8192;
const MAX_ARRAY_ITEMS = 32;
const PROFILE_ROUTES = Object.freeze({
  'codex-public-http': { path: '/v1/responses', sourcePath: '/v1/responses', originalPath: '/v1/responses' },
  'codex-public-sse': { path: '/v1/responses', sourcePath: '/v1/responses', originalPath: '/v1/responses' },
  'codex-native-http': { path: '/backend-api/codex/responses', sourcePath: '/v1/responses', originalPath: '/backend-api/codex/responses' },
  'codex-compact-http': { path: '/backend-api/codex/responses/compact', sourcePath: '/v1/responses/compact', originalPath: '/backend-api/codex/responses/compact' },
  'codex-public-websocket': { path: '/v1/responses', sourcePath: '/v1/responses', originalPath: '/v1/responses' },
  'codex-native-websocket': { path: '/backend-api/codex/responses', sourcePath: '/v1/responses', originalPath: '/backend-api/codex/responses' },
  'compass-anthropic-messages': { path: '/v1/messages', sourcePath: '/v1/messages', originalPath: '/v1/messages' }
});

export async function loadCompatibilityCapture(path) {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_CAPTURE_BYTES) throw new Error('Compatibility capture exceeds 256 KiB');
  let capture;
  try {
    capture = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Compatibility capture is not valid JSON');
  }
  validateCompatibilityCapture(capture);
  return capture;
}

export function validateCompatibilityCapture(capture) {
  assertObject(capture, 'capture');
  assertKnownKeys(capture, CAPTURE_ROOT_KEYS, 'capture');
  if (capture.schemaVersion !== COMPATIBILITY_CAPTURE_SCHEMA_VERSION) fail('capture.schemaVersion is unsupported');
  if (!PROFILE_SET.has(capture.profile)) fail('capture.profile is invalid');
  assertObject(capture.client, 'capture.client');
  assertKnownKeys(capture.client, CLIENT_KEYS, 'capture.client');
  const expectedFamily = capture.profile.startsWith('codex-') ? 'codex' : 'claude-code';
  if (capture.client.family !== expectedFamily) fail('capture.client.family does not match profile');
  assertToken(capture.client.version, 'capture.client.version');
  assertObject(capture.request, 'capture.request');
  assertKnownKeys(capture.request, REQUEST_KEYS, 'capture.request');
  if (capture.request.path !== PROFILE_ROUTES[capture.profile].path) fail('capture.request.path does not match profile');
  assertObject(capture.request.headers, 'capture.request.headers');
  assertObject(capture.request.body, 'capture.request.body');
  if (capture.request.generate !== undefined && typeof capture.request.generate !== 'boolean') fail('capture.request.generate must be boolean');
  if (capture.response !== undefined) {
    assertObject(capture.response, 'capture.response');
    assertKnownKeys(capture.response, RESPONSE_KEYS, 'capture.response');
    if (!Number.isInteger(capture.response.status) || capture.response.status < 100 || capture.response.status > 599) fail('capture.response.status is invalid');
    if (capture.response.body !== undefined) assertObject(capture.response.body, 'capture.response.body');
  }
  validateRawBounds(capture);
  return capture;
}

export function sanitizeCompatibilityCapture(capture) {
  validateCompatibilityCapture(capture);
  const state = sanitizerState();
  const route = PROFILE_ROUTES[capture.profile];
  const rawBody = capture.profile === 'codex-public-websocket'
    ? publicWebSocketBody(capture.request.body)
    : capture.request.body;
  const generate = capture.request.generate !== undefined
    ? capture.request.generate
    : capture.profile === 'codex-public-websocket' && typeof capture.request.body.generate === 'boolean'
      ? capture.request.body.generate
      : undefined;
  const body = sanitizeValue(rawBody, '', '$', state, 0);
  const rejection = structuredRejection(capture.response, capture.request.body);
  const fingerprintSeed = canonicalJson({
    profile: capture.profile,
    version: capture.client.version,
    headers: sanitizeHeaders(capture.request.headers, capture.profile),
    shape: summarizeJsonShape(wireJson(body)),
    generate,
    rejection
  });
  const fixture = {
    schemaVersion: 1,
    id: `${capture.profile}-${slug(capture.client.version)}-${createHash('sha256').update(fingerprintSeed).digest('hex').slice(0, 10)}`,
    client: { family: capture.client.family, version: capture.client.version },
    profile: capture.profile,
    negotiation: { headers: sanitizeHeaders(capture.request.headers, capture.profile) },
    request: {
      sourcePath: route.sourcePath,
      originalPath: route.originalPath,
      body,
      ...(generate !== undefined ? { generate } : {})
    },
    ...rejection
  };
  validateCompatibilityFixture(fixture, { requireExpected: false });
  return fixture;
}

export function analyzeCompatibilityCapture(capture, baselineEntries) {
  const draft = sanitizeCompatibilityCapture(capture);
  const baseline = closestCompatibilityFixture(draft, baselineEntries);
  let projectionError = null;
  try {
    Object.assign(draft, withUpdatedCompatibilityExpectation(draft));
  } catch (error) {
    projectionError = {
      code: safeErrorToken(error?.code) || 'projection_failed',
      param: safeErrorToken(error?.param) || null
    };
  }
  const changes = compatibilityIntakeChanges(draft, baseline?.fixture || null, projectionError);
  const classification = classifyChanges(draft, baseline?.fixture || null, changes, projectionError);
  const suggestions = reviewSuggestions(classification);
  const status = projectionError
    ? 'adapter_change_required'
    : classification.includes('structured_rejection_review')
      ? 'rejection_review'
      : classification.length ? 'review' : 'exact';
  return {
    schemaVersion: 1,
    status,
    capture: {
      fixtureId: draft.id,
      profile: draft.profile,
      clientVersion: draft.client.version,
      draftReady: !projectionError
    },
    baseline: baseline
      ? { fixtureId: baseline.fixture.id, clientVersion: baseline.fixture.client.version, similarity: baseline.similarity }
      : null,
    classification,
    changes,
    suggestions,
    ...(projectionError ? { projectionError } : {}),
    draft
  };
}

export function closestCompatibilityFixture(draft, entries) {
  const candidates = entries
    .map((entry) => entry.fixture || entry)
    .filter((fixture) => fixture.profile === draft.profile);
  if (!candidates.length) return null;
  const draftShape = summarizeJsonShape(wireJson(draft.request.body));
  return candidates
    .map((fixture) => ({
      fixture,
      similarity: shapeSimilarity(draftShape, summarizeJsonShape(wireJson(fixture.request.body)))
    }))
    .sort((left, right) => right.similarity - left.similarity || left.fixture.id.localeCompare(right.fixture.id))[0];
}

export function renderCompatibilityIntakeReport(result, { format = 'markdown' } = {}) {
  const report = { ...result };
  delete report.draft;
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  const lines = [
    '# Compatibility Intake Report',
    '',
    `Status: ${report.status}`,
    `Capture: ${report.capture.fixtureId}`,
    `Profile: ${report.capture.profile}`,
    `Client version: ${report.capture.clientVersion}`,
    `Draft ready: ${report.capture.draftReady ? 'yes' : 'no'}`,
    `Baseline: ${report.baseline ? `${report.baseline.fixtureId} (${report.baseline.similarity})` : 'none'}`
  ];
  if (report.classification.length) {
    lines.push('', '## Classification', '');
    for (const item of report.classification) lines.push(`- ${item}`);
  }
  if (report.changes.length) {
    lines.push('', '## Changes', '');
    for (const change of report.changes) {
      lines.push(`- ${change.category}: ${change.summary}`);
      if (change.added?.length) lines.push(`  Added: ${change.added.join(', ')}`);
      if (change.removed?.length) lines.push(`  Removed: ${change.removed.join(', ')}`);
    }
  }
  if (report.suggestions.length) {
    lines.push('', '## Review', '');
    for (const suggestion of report.suggestions) lines.push(`- ${suggestion.code}: ${suggestion.summary}`);
  }
  return `${lines.join('\n')}\n`;
}

function compatibilityIntakeChanges(draft, baseline, projectionError) {
  if (!baseline) return [{ category: 'baseline', summary: 'No committed fixture exists for this profile' }];
  const changes = [];
  if (draft.client.version !== baseline.client.version) {
    changes.push({ category: 'client_version', summary: `${baseline.client.version} -> ${draft.client.version}` });
  }
  const requestDiff = shapeDiff(
    summarizeJsonShape(wireJson(baseline.request.body)),
    summarizeJsonShape(wireJson(draft.request.body))
  );
  appendShapeChanges(changes, 'request_shape', requestDiff);
  if (projectionError) {
    changes.push({
      category: 'adapter_projection',
      summary: `Live projection rejected the draft with ${projectionError.code}${projectionError.param ? ` at ${projectionError.param}` : ''}`
    });
    return changes;
  }
  if (draft.expected.fingerprint.hash !== baseline.expected.fingerprint.hash) {
    changes.push({
      category: 'protocol_fingerprint',
      summary: `${baseline.expected.fingerprint.hash} -> ${draft.expected.fingerprint.hash}`
    });
  }
  appendShapeChanges(changes, 'projected_shape', shapeDiff(baseline.expected.projection, draft.expected.projection));
  const rejectionDiff = objectDiff(baseline.expected.rejection?.fields || {}, draft.expected.rejection?.fields || {});
  if (baseline.expected.rejection?.status !== draft.expected.rejection?.status || rejectionDiff.added.length || rejectionDiff.removed.length) {
    changes.push({
      category: 'structured_rejection',
      summary: `Structured rejection changed from ${baseline.expected.rejection?.status || 'none'} to ${draft.expected.rejection?.status || 'none'}`,
      added: rejectionDiff.added,
      removed: rejectionDiff.removed
    });
  }
  return changes;
}

function appendShapeChanges(changes, prefix, diff) {
  if (diff.paths.added.length || diff.paths.removed.length) {
    changes.push({
      category: prefix,
      summary: 'JSON path/type structure changed',
      added: diff.paths.added,
      removed: diff.paths.removed
    });
  }
  if (diff.typeValues.added.length || diff.typeValues.removed.length) {
    changes.push({
      category: `${prefix}_discriminators`,
      summary: '`type` discriminator values changed',
      added: diff.typeValues.added,
      removed: diff.typeValues.removed
    });
  }
}

function classifyChanges(draft, baseline, changes, projectionError) {
  if (!baseline) return ['new_transport_profile'];
  const classes = [];
  if (draft.client.version !== baseline.client.version) classes.push('new_client_version');
  if (projectionError) classes.push('adapter_change_required');
  if (changes.some((change) => change.category === 'protocol_fingerprint')) classes.push('protocol_negotiation_review');
  if (changes.some((change) => change.category === 'request_shape' && change.added?.length)) classes.push('request_shape_addition');
  if (changes.some((change) => change.category === 'request_shape' && change.removed?.length)) classes.push('request_shape_removal');
  if (changes.some((change) => change.category === 'request_shape_discriminators' && change.added?.length)) classes.push('new_request_discriminator');
  if (changes.some((change) => change.category === 'projected_shape' && change.added?.length)) classes.push('projected_shape_addition');
  if (changes.some((change) => change.category === 'projected_shape' && change.removed?.length)) classes.push('projected_shape_removal');
  if (changes.some((change) => change.category === 'projected_shape_discriminators' && change.added?.length)) classes.push('new_projected_discriminator');
  if (changes.some((change) => change.category === 'structured_rejection')) {
    classes.push('structured_rejection_review');
    const fields = draft.rejection?.fields || {};
    if (fields['error.param'] || fields['response.error.param']) classes.push('unsupported_field_rejection');
  }
  return classes;
}

function reviewSuggestions(classification) {
  const suggestions = [];
  const add = (code, summary) => {
    if (!suggestions.some((item) => item.code === code)) suggestions.push({ code, summary });
  };
  if (classification.includes('adapter_change_required')) add('review_adapter_projection', 'Update and test the adapter only if the new client shape should be supported');
  if (classification.includes('protocol_negotiation_review')) add('review_protocol_fingerprint', 'Verify the client negotiation change before changing proxy defaults');
  if (classification.some((item) => item.includes('shape_') || item.includes('discriminator'))) add('add_regression_fixture', 'Review the sanitized draft and commit it only after its projected behavior is intentional');
  if (classification.includes('structured_rejection_review')) add('review_structured_rejection', 'Review the structured rejection; do not expand fallback allowlists automatically');
  if (classification.includes('unsupported_field_rejection')) add('review_fallback_boundary', 'Confirm the rejected parameter is optional and safe before changing a fixed fallback allowlist');
  if (classification.includes('new_transport_profile')) add('define_transport_contract', 'Define routing and projection ownership before accepting a new transport profile');
  if (!suggestions.length) add('no_action', 'The capture matches the closest committed fixture');
  return suggestions;
}

function sanitizeHeaders(headers, profile) {
  const allowed = profile === 'compass-anthropic-messages'
    ? COMPASS_NEGOTIATION_HEADERS
    : profile.includes('native')
      ? CODEX_NEGOTIATION_HEADERS
      : NO_NEGOTIATION_HEADERS;
  const normalized = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!NEGOTIATION_HEADERS.has(name) || !allowed.has(name) || typeof rawValue !== 'string') continue;
    const tokens = name.endsWith('-beta') ? rawValue.split(',').map((value) => value.trim()) : [rawValue.trim()];
    const safe = tokens.filter((value) => SAFE_TOKEN.test(value));
    if (safe.length) normalized[name] = name.endsWith('-beta') ? [...new Set(safe)].sort().join(',') : safe[0];
  }
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)));
}

function sanitizeValue(value, key, path, state, depth, dynamicContext = '') {
  state.nodes += 1;
  if (state.nodes > MAX_NODES || depth > MAX_DEPTH) fail('capture body exceeds sanitization bounds');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return canonicalNumber(key);
  if (typeof value === 'string') return sanitizeString(value, key, state);
  if (Array.isArray(value)) {
    const sanitized = [];
    const seen = new Set();
    for (const item of value) {
      const next = sanitizeValue(item, key, `${path}[]`, state, depth + 1, dynamicContext);
      const signature = canonicalJson(next);
      if (!seen.has(signature)) {
        if (sanitized.length >= MAX_ARRAY_ITEMS) fail('capture array contains too many distinct sanitized shapes');
        seen.add(signature);
        sanitized.push(next);
      }
    }
    return sanitized;
  }
  if (!plainObject(value)) return null;
  const output = {};
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  for (const [rawChildKey, child] of entries) {
    if (DROP_KEYS.test(rawChildKey)) continue;
    const invalidChildKey = !SAFE_KEY.test(rawChildKey) || UNSAFE_OBJECT_KEYS.has(rawChildKey);
    const safeChildKey = !invalidChildKey
      ? rawChildKey
      : dynamicName(rawChildKey, `invalid:${path}`, state);
    const childKey = dynamicContext ? dynamicName(safeChildKey, dynamicContext, state) : safeChildKey;
    const childDynamic = RECURSIVE_DYNAMIC_KEYS.has(dynamicContext)
      ? dynamicContext
      : invalidChildKey ? 'value'
        : DYNAMIC_KEYS.has(childKey) ? childKey : '';
    output[childKey] = sanitizeValue(child, childKey, `${path}.${childKey}`, state, depth + 1, childDynamic);
  }
  if (plainObject(value.properties) && Array.isArray(value.required)) {
    const names = Object.keys(output.properties || {});
    output.required = names;
  }
  return output;
}

function sanitizeString(value, key, state) {
  if (Buffer.byteLength(value) > MAX_STRING_BYTES) return 'fixture-value';
  if (key === 'model') return 'fixture-model';
  if (key === '$ref') return sanitizeRef(value, state);
  if (CONTENT_KEYS.test(key)) return key === 'instructions' ? 'fixture-instructions' : 'fixture-text';
  if (ID_KEYS.test(key)) return 'fixture-identifier';
  if (NAME_KEYS.test(key)) return 'fixture-name';
  if (URL_KEYS.test(key)) return mediaMarker(key);
  if (BINARY_KEYS.test(key)) return binaryMarker(key);
  if (ENUM_KEYS.has(key) && SAFE_TOKEN.test(value)) return value;
  if (SCHEMA_NAME_ARRAY_KEYS.has(key)) return 'fixture-field-1';
  if (key === 'enum' || key === 'const') return `fixture-enum-${++state.enumValues}`;
  return 'fixture-value';
}

function publicWebSocketBody(body) {
  if (body.type !== 'response.create') return body;
  const { type: _type, generate: _generate, stream_id: _streamId, ...request } = body;
  return request;
}

function structuredRejection(response, requestBody) {
  if (!response || response.status < 400 || response.status > 599 || !plainObject(response.body)) return {};
  const fields = {};
  for (const prefix of ['error', 'response.error']) {
    const source = prefix === 'error' ? response.body.error : response.body.response?.error;
    if (!plainObject(source)) continue;
    for (const field of ['type', 'code', 'param']) {
      const value = safeErrorToken(source[field]);
      if (value && (field !== 'param' || Object.hasOwn(requestBody, value))) fields[`${prefix}.${field}`] = value;
    }
  }
  if (!Object.keys(fields).length) return {};
  return { rejection: { status: response.status, fields: Object.fromEntries(Object.entries(fields).sort(([left], [right]) => left.localeCompare(right))) } };
}

function shapeDiff(left, right) {
  return {
    paths: rowDiff(left.paths, right.paths, (row) => `${row.path}:${row.type}`),
    typeValues: rowDiff(left.typeValues, right.typeValues, (row) => `${row.path}=${row.value}`)
  };
}

function rowDiff(left, right, key) {
  const leftSet = new Set(left.map(key));
  const rightSet = new Set(right.map(key));
  return {
    added: [...rightSet].filter((value) => !leftSet.has(value)).sort(),
    removed: [...leftSet].filter((value) => !rightSet.has(value)).sort()
  };
}

function objectDiff(left, right) {
  const leftRows = Object.entries(left).map(([key, value]) => `${key}=${value}`);
  const rightRows = Object.entries(right).map(([key, value]) => `${key}=${value}`);
  return rowDiff(leftRows, rightRows, (value) => value);
}

function shapeSimilarity(left, right) {
  const leftSet = shapeTokenSet(left);
  const rightSet = shapeTokenSet(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (!union.size) return 1;
  let intersection = 0;
  for (const token of leftSet) if (rightSet.has(token)) intersection += 1;
  return Number((intersection / union.size).toFixed(4));
}

function shapeTokenSet(shape) {
  return new Set([
    ...shape.paths.map((row) => `path:${row.path}:${row.type}`),
    ...shape.typeValues.map((row) => `type:${row.path}:${row.value}`)
  ]);
}

function validateRawBounds(value) {
  let nodes = 0;
  const visit = (entry, depth) => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) fail('capture exceeds depth or node bounds');
    if (typeof entry === 'string' && Buffer.byteLength(entry) > MAX_STRING_BYTES) fail('capture contains an oversized string');
    if (Array.isArray(entry)) {
      if (entry.length > MAX_ARRAY_ITEMS * 8) fail('capture contains an oversized array');
      entry.forEach((item) => visit(item, depth + 1));
    } else if (plainObject(entry)) {
      Object.values(entry).forEach((item) => visit(item, depth + 1));
    }
  };
  visit(value, 0);
}

function sanitizerState() {
  return {
    nodes: 0,
    dynamicNames: 0,
    definitionNames: 0,
    enumValues: 0,
    dynamicMap: new Map()
  };
}

function dynamicName(value, context, state) {
  const key = `${context}:${value}`;
  if (!state.dynamicMap.has(key)) {
    const prefix = context === '$defs' || context === 'definitions' ? 'fixture-definition' : 'fixture-field';
    const counter = prefix === 'fixture-definition' ? ++state.definitionNames : ++state.dynamicNames;
    state.dynamicMap.set(key, `${prefix}-${counter}`);
  }
  return state.dynamicMap.get(key);
}

function sanitizeRef(value, state) {
  const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(value);
  if (!match) return '#/$defs/fixture-definition-1';
  return `#/${match[1]}/${dynamicName(match[2], match[1], state)}`;
}

function mediaMarker(key) {
  if (key === 'image_url') return 'data:image/png;base64,AA==';
  if (key === 'audio_url') return 'data:audio/wav;base64,AA==';
  return 'fixture-url';
}

function binaryMarker(key) {
  if (key === 'file_data') return 'data:text/plain;base64,QQ==';
  if (key === 'data') return 'AA==';
  return 'fixture-value';
}

function canonicalNumber(key) {
  if (/temperature|top_p/i.test(key)) return 0.5;
  if (/top_k/i.test(key)) return 1;
  if (/tokens|limit|count|threshold|max|min|budget/i.test(key)) return 256;
  return 1;
}

function safeErrorToken(value) {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : '';
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unknown';
}

function wireJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertKnownKeys(value, allowed, label) {
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(`${label} contains an unknown field`);
}

function assertObject(value, label) {
  if (!plainObject(value)) fail(`${label} must be an object`);
}

function assertToken(value, label) {
  if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) fail(`${label} is invalid`);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new Error(message);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

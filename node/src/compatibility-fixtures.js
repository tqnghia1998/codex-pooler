import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { adaptResponsesRequest } from './openai-adapters.js';
import { compatibilityProtocolFingerprint } from './protocol-compat.js';
import { projectProxyRequest, projectPublicWebSocketFrame } from './proxy.js';

export const COMPATIBILITY_FIXTURE_SCHEMA_VERSION = 1;
export const COMPATIBILITY_FIXTURE_PROFILES = Object.freeze([
  'codex-public-http',
  'codex-public-sse',
  'codex-native-http',
  'codex-compact-http',
  'codex-public-websocket',
  'codex-native-websocket',
  'compass-anthropic-messages'
]);

const PROFILE_SET = new Set(COMPATIBILITY_FIXTURE_PROFILES);
const ROOT_KEYS = new Set(['schemaVersion', 'id', 'client', 'profile', 'negotiation', 'request', 'rejection', 'expected']);
const CLIENT_KEYS = new Set(['family', 'version']);
const NEGOTIATION_KEYS = new Set(['headers']);
const REQUEST_KEYS = new Set(['sourcePath', 'originalPath', 'body', 'codexBody', 'compatibility', 'generate']);
const COMPATIBILITY_KEYS = new Set(['unsupportedFields', 'adaptiveThinking']);
const EXPECTED_KEYS = new Set(['targetPath', 'fingerprint', 'projection', 'rejection']);
const FINGERPRINT_KEYS = new Set(['version', 'hash', 'values']);
const PROJECTION_KEYS = new Set(['paths', 'typeValues']);
const REJECTION_KEYS = new Set(['status', 'fields']);
const ALLOWED_NEGOTIATION_HEADERS = new Set(['version', 'originator', 'openai-beta', 'anthropic-version', 'anthropic-beta']);
const FORBIDDEN_KEYS = /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|host|chatgpt[-_]?account[-_]?id|x[-_]?api[-_]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|client[-_]?secret|project[-_]?key|project[-_]?id|account[-_]?id|password|secret)$/i;
const CONTENT_KEYS = /^(?:text|content|input|instructions|message|detail|system|prompt)$/i;
const ID_KEYS = /(?:^|_)(?:id|identifier)$/i;
const ENUM_KEYS = new Set([
  'type', 'role', 'effort', 'service_tier', 'include', 'status', 'format', 'execution',
  'tool_choice', 'verbosity', 'mode', 'purpose'
]);
const DYNAMIC_OBJECT_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'metadata']);
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._=:+/-]{0,255}$/;
const SAFE_JSON_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]{0,127}$/;
const SAFE_JSON_PATH = /^\$(?:(?:\[\])|(?:\.[A-Za-z_$][A-Za-z0-9_$-]{0,127}))*$/;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SAFE_LOCAL_REF = /^#\/(?:\$defs|definitions)\/fixture-definition-[1-9][0-9]*$/;
const SAFE_MEDIA_VALUES = new Map([
  ['image_url', new Set(['data:image/png;base64,AA=='])],
  ['audio_url', new Set(['data:audio/wav;base64,AA=='])],
  ['file_data', new Set(['data:text/plain;base64,QQ=='])],
  ['data', new Set(['AA=='])]
]);
const MAX_FIXTURE_BYTES = 128 * 1024;
const MAX_STRING_BYTES = 1024;
const MAX_DEPTH = 16;
const MAX_NODES = 4096;

export async function loadCompatibilityFixtures(directory, { ignoreExpected = false } = {}) {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.json'))
    .sort();
  const fixtures = [];
  const ids = new Set();
  for (const name of names) {
    const path = join(directory, name);
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_FIXTURE_BYTES) throw fixtureError(name, 'file exceeds 128 KiB');
    let fixture;
    try {
      fixture = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw fixtureError(name, 'file is not valid JSON');
    }
    validateCompatibilityFixture(fixture, { filename: name, requireExpected: false, ignoreExpected });
    if (ids.has(fixture.id)) throw fixtureError(name, 'fixture ID is duplicated');
    ids.add(fixture.id);
    fixtures.push({ path, fixture });
  }
  if (!fixtures.length) throw new Error('No compatibility fixtures found');
  return fixtures;
}

export function validateCompatibilityFixture(fixture, { filename = 'fixture', requireExpected = true, ignoreExpected = false } = {}) {
  assertObject(fixture, filename);
  assertKnownKeys(fixture, ROOT_KEYS, filename);
  if (fixture.schemaVersion !== COMPATIBILITY_FIXTURE_SCHEMA_VERSION) fail(filename, 'schemaVersion is unsupported');
  if (!SAFE_ID.test(fixture.id || '')) fail(filename, 'id is invalid');
  assertObject(fixture.client, `${filename}.client`);
  assertKnownKeys(fixture.client, CLIENT_KEYS, `${filename}.client`);
  if (!['codex', 'claude-code'].includes(fixture.client.family)) fail(filename, 'client.family is invalid');
  assertBoundedString(fixture.client.version, `${filename}.client.version`, SAFE_TOKEN);
  if (!PROFILE_SET.has(fixture.profile)) fail(filename, 'profile is invalid');
  if (fixture.profile.startsWith('codex-') !== (fixture.client.family === 'codex')) fail(filename, 'client.family does not match profile');

  assertObject(fixture.negotiation, `${filename}.negotiation`);
  assertKnownKeys(fixture.negotiation, NEGOTIATION_KEYS, `${filename}.negotiation`);
  assertObject(fixture.negotiation.headers, `${filename}.negotiation.headers`);
  for (const [name, value] of Object.entries(fixture.negotiation.headers)) {
    if (!ALLOWED_NEGOTIATION_HEADERS.has(name)) fail(filename, `negotiation header ${name} is not allowed`);
    validateNegotiationHeader(name, value, `${filename}.negotiation.headers.${name}`);
  }

  assertObject(fixture.request, `${filename}.request`);
  assertKnownKeys(fixture.request, REQUEST_KEYS, `${filename}.request`);
  assertBoundedString(fixture.request.sourcePath, `${filename}.request.sourcePath`);
  assertBoundedString(fixture.request.originalPath, `${filename}.request.originalPath`);
  assertObject(fixture.request.body, `${filename}.request.body`);
  validateProfileRequest(fixture, filename);
  validateSanitizedValue(fixture.request.body, `${filename}.request.body`);
  if (fixture.request.codexBody !== undefined) {
    assertObject(fixture.request.codexBody, `${filename}.request.codexBody`);
    validateSanitizedValue(fixture.request.codexBody, `${filename}.request.codexBody`);
  }
  if (fixture.request.compatibility !== undefined) {
    assertObject(fixture.request.compatibility, `${filename}.request.compatibility`);
    assertKnownKeys(fixture.request.compatibility, COMPATIBILITY_KEYS, `${filename}.request.compatibility`);
    const fields = fixture.request.compatibility.unsupportedFields;
    if (fields !== undefined && (!Array.isArray(fields) || fields.some((field) => typeof field !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(field)))) {
      fail(filename, 'request.compatibility.unsupportedFields is invalid');
    }
    if (fixture.request.compatibility.adaptiveThinking !== undefined && fixture.request.compatibility.adaptiveThinking !== true) {
      fail(filename, 'request.compatibility.adaptiveThinking must be true');
    }
  }
  if (fixture.request.generate !== undefined && typeof fixture.request.generate !== 'boolean') fail(filename, 'request.generate must be boolean');

  if (fixture.rejection !== undefined) validateRejection(fixture.rejection, `${filename}.rejection`);
  if (fixture.expected === undefined) {
    if (requireExpected) fail(filename, 'expected is required');
  } else if (!ignoreExpected) {
    validateExpected(fixture.expected, `${filename}.expected`);
  }
  return fixture;
}

export function replayCompatibilityFixture(fixture, { ignoreExpected = false } = {}) {
  validateCompatibilityFixture(fixture, { requireExpected: false, ignoreExpected });
  const profile = fixture.profile;
  const headers = fixture.negotiation.headers;
  const codex = profile.startsWith('codex-');
  const websocket = profile.endsWith('websocket');
  const native = profile.includes('native');
  const fingerprint = compatibilityProtocolFingerprint(codex ? 'codex' : 'compass', {
    req: { headers },
    inheritClient: native,
    websocket,
    anthropicVersion: headers['anthropic-version'],
    anthropicBeta: headers['anthropic-beta'],
    env: {}
  });
  let targetPath;
  let projected;
  if (profile === 'codex-public-websocket') {
    targetPath = '/backend-api/codex/responses';
    projected = projectPublicWebSocketFrame(adaptResponsesRequest(fixture.request.body), {
      generate: fixture.request.generate ?? true,
      compatibility: fixture.request.compatibility || {}
    });
  } else if (profile === 'codex-native-websocket') {
    targetPath = '/backend-api/codex/responses';
    projected = structuredClone(fixture.request.body);
  } else {
    const result = projectProxyRequest({
      upstreamType: codex ? 'codex' : 'compass',
      sourcePath: fixture.request.sourcePath,
      originalPath: fixture.request.originalPath,
      payload: fixture.request.body,
      codexPayload: fixture.request.codexBody
        || (profile === 'codex-public-http' || profile === 'codex-public-sse'
          ? adaptResponsesRequest(fixture.request.body)
          : fixture.request.body),
      compatibility: fixture.request.compatibility || {}
    });
    targetPath = result.targetPath;
    projected = result.body;
  }
  projected = wireJson(projected);
  return {
    targetPath,
    fingerprint,
    projection: summarizeJsonShape(projected),
    ...(fixture.rejection ? { rejection: normalizeRejection(fixture.rejection) } : {})
  };
}

export function compareCompatibilityFixture(fixture) {
  validateCompatibilityFixture(fixture);
  const actual = replayCompatibilityFixture(fixture);
  const drifts = [];
  compareSection('target_route', fixture.expected.targetPath, actual.targetPath, drifts);
  compareSection('protocol_fingerprint', fixture.expected.fingerprint, actual.fingerprint, drifts);
  compareSection('projected_shape', fixture.expected.projection, actual.projection, drifts);
  compareSection('rejection_contract', fixture.expected.rejection, actual.rejection, drifts);
  return { id: fixture.id, profile: fixture.profile, actual, drifts };
}

export function compatibilityFixtureReport(entries) {
  const results = [];
  for (const entry of entries) {
    const fixture = entry.fixture || entry;
    try {
      const result = compareCompatibilityFixture(fixture);
      results.push({ id: fixture.id, profile: fixture.profile, status: result.drifts.length ? 'drift' : 'ok', drifts: result.drifts });
    } catch (error) {
      results.push({
        id: typeof fixture?.id === 'string' ? fixture.id : basename(entry.path || 'fixture'),
        profile: typeof fixture?.profile === 'string' ? fixture.profile : 'unknown',
        status: 'invalid',
        drifts: [{ category: 'invalid_fixture', expected: null, actual: error.message }]
      });
    }
  }
  results.sort((left, right) => left.id.localeCompare(right.id));
  const counts = {
    fixtures: results.length,
    passed: results.filter((result) => result.status === 'ok').length,
    drifted: results.filter((result) => result.status === 'drift').length,
    invalid: results.filter((result) => result.status === 'invalid').length
  };
  return { schemaVersion: 1, status: counts.drifted || counts.invalid ? 'drift' : 'ok', counts, results };
}

export function renderCompatibilityFixtureReport(report, { format = 'markdown' } = {}) {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  const lines = [
    '# Compatibility Fixture Report',
    '',
    `Status: ${report.status}`,
    `Fixtures: ${report.counts.fixtures}; passed: ${report.counts.passed}; drifted: ${report.counts.drifted}; invalid: ${report.counts.invalid}`
  ];
  for (const result of report.results) {
    lines.push('', `## ${result.id}`, '', `Profile: ${result.profile}`, `Status: ${result.status}`);
    for (const drift of result.drifts) {
      lines.push(`- ${drift.category}: expected ${canonicalJson(drift.expected)}, actual ${canonicalJson(drift.actual)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function withUpdatedCompatibilityExpectation(fixture) {
  validateCompatibilityFixture(fixture, { requireExpected: false, ignoreExpected: true });
  return { ...fixture, expected: replayCompatibilityFixture(fixture, { ignoreExpected: true }) };
}

export function summarizeJsonShape(value) {
  const paths = new Map();
  const typeValues = new Map();
  let nodes = 0;
  const visit = (entry, path, depth) => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('Projected fixture shape exceeds bounds');
    paths.set(`${path}\0${jsonType(entry)}`, { path, type: jsonType(entry) });
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, `${path}[]`, depth + 1);
      return;
    }
    if (!plainObject(entry)) return;
    for (const key of Object.keys(entry).sort()) {
      const child = entry[key];
      const childPath = `${path}.${key}`;
      if (key === 'type' && typeof child === 'string') {
        typeValues.set(`${childPath}\0${child}`, { path: childPath, value: child });
      }
      visit(child, childPath, depth + 1);
    }
  };
  visit(value, '$', 0);
  return {
    paths: [...paths.values()].sort(comparePathRows),
    typeValues: [...typeValues.values()].sort(comparePathRows)
  };
}

function validateProfileRequest(fixture, filename) {
  const routes = {
    'codex-public-http': ['/v1/responses', '/v1/responses'],
    'codex-public-sse': ['/v1/responses', '/v1/responses'],
    'codex-native-http': ['/v1/responses', '/backend-api/codex/responses'],
    'codex-compact-http': ['/v1/responses/compact', '/backend-api/codex/responses/compact'],
    'codex-public-websocket': ['/v1/responses', '/v1/responses'],
    'codex-native-websocket': ['/v1/responses', '/backend-api/codex/responses'],
    'compass-anthropic-messages': ['/v1/messages', '/v1/messages']
  };
  const expected = routes[fixture.profile];
  if (fixture.request.sourcePath !== expected[0] || fixture.request.originalPath !== expected[1]) fail(filename, 'request routes do not match profile');
  if (fixture.profile === 'codex-public-http' && fixture.request.body.stream === true) fail(filename, 'public HTTP fixture must not request streaming');
  if (fixture.profile === 'codex-public-sse' && fixture.request.body.stream !== true) fail(filename, 'public SSE fixture must request streaming');
  if (fixture.profile === 'codex-public-websocket' && fixture.request.body.type === 'response.create') {
    fail(filename, 'WebSocket request.body must omit the transport envelope');
  }
}

function validateSanitizedValue(value, label) {
  let nodes = 0;
  const visit = (entry, key, path, depth) => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) fail(label, 'JSON value exceeds bounds');
    if (entry === null || typeof entry === 'boolean') return;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) fail(label, `${path} is not finite`);
      return;
    }
    if (typeof entry === 'string') {
      assertBoundedString(entry, `${label}.${path}`);
      if (/\bBearer\s/i.test(entry) || /https?:\/\//i.test(entry) || /^[^.]+\.[^.]+\.[^.]+$/.test(entry) || /@/.test(entry)) fail(label, `${path} contains secret-like or external content`);
      if (key === '$ref' && SAFE_LOCAL_REF.test(entry)) return;
      if (SAFE_MEDIA_VALUES.get(key)?.has(entry)) return;
      if (CONTENT_KEYS.test(key) && !['fixture-text', 'fixture-instructions'].includes(entry)) fail(label, `${path} must use a fixed fixture content marker`);
      if (key === 'model' && entry !== 'fixture-model') fail(label, `${path} must use fixture-model`);
      if (ID_KEYS.test(key) && !entry.startsWith('fixture-')) fail(label, `${path} must use a fixture- identifier`);
      if (ENUM_KEYS.has(key) && !SAFE_TOKEN.test(entry)) fail(label, `${path} must use a token-shaped enum`);
      if (!ENUM_KEYS.has(key) && !entry.startsWith('fixture-')) fail(label, `${path} must use a fixture- marker`);
      return;
    }
    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index += 1) visit(entry[index], key, `${path}[${index}]`, depth + 1);
      return;
    }
    if (!plainObject(entry)) fail(label, `${path} contains an unsupported value`);
    const dynamicKeys = DYNAMIC_OBJECT_KEYS.has(key);
    for (const [childKey, child] of Object.entries(entry)) {
      if (!SAFE_JSON_KEY.test(childKey)) fail(label, `${path} contains an invalid field name`);
      if (UNSAFE_OBJECT_KEYS.has(childKey)) fail(label, `${path}.${childKey} is unsafe`);
      if (FORBIDDEN_KEYS.test(childKey)) fail(label, `${path}.${childKey} is forbidden`);
      if (dynamicKeys && !childKey.startsWith('fixture-')) fail(label, `${path} dynamic field names must use fixture- markers`);
      visit(child, childKey, `${path}.${childKey}`, depth + 1);
    }
  };
  visit(value, '', '$', 0);
}

function validateExpected(expected, label) {
  assertObject(expected, label);
  assertKnownKeys(expected, EXPECTED_KEYS, label);
  assertBoundedString(expected.targetPath, `${label}.targetPath`);
  assertObject(expected.fingerprint, `${label}.fingerprint`);
  assertKnownKeys(expected.fingerprint, FINGERPRINT_KEYS, `${label}.fingerprint`);
  if (!Number.isInteger(expected.fingerprint.version) || expected.fingerprint.version < 1) fail(label, 'fingerprint.version is invalid');
  if (!/^[a-f0-9]{32}$/.test(expected.fingerprint.hash || '')) fail(label, 'fingerprint.hash is invalid');
  assertObject(expected.fingerprint.values, `${label}.fingerprint.values`);
  validateFingerprintValues(expected.fingerprint.values, `${label}.fingerprint.values`);
  assertObject(expected.projection, `${label}.projection`);
  assertKnownKeys(expected.projection, PROJECTION_KEYS, `${label}.projection`);
  validateShapeRows(expected.projection.paths, `${label}.projection.paths`, 'type');
  validateShapeRows(expected.projection.typeValues, `${label}.projection.typeValues`, 'value');
  if (expected.rejection !== undefined) validateRejection(expected.rejection, `${label}.rejection`);
}

function validateShapeRows(rows, label, valueKey) {
  if (!Array.isArray(rows)) fail(label, 'must be an array');
  for (const row of rows) {
    assertObject(row, label);
    assertKnownKeys(row, new Set(['path', valueKey]), label);
    if (typeof row.path !== 'string' || !SAFE_JSON_PATH.test(row.path)) fail(label, 'path is invalid');
    if (valueKey === 'type') {
      if (!['array', 'boolean', 'null', 'number', 'object', 'string'].includes(row.type)) fail(label, 'type is invalid');
    } else {
      assertBoundedString(row.value, `${label}.value`, SAFE_TOKEN);
    }
  }
}

function validateFingerprintValues(values, label) {
  const codexKeys = new Set(['user-agent', 'originator', 'version', 'openai-beta']);
  const compassKeys = new Set(['version', 'beta']);
  const codex = Object.hasOwn(values, 'user-agent') || Object.hasOwn(values, 'originator');
  assertKnownKeys(values, codex ? codexKeys : compassKeys, label);
  for (const [key, value] of Object.entries(values)) {
    if (key === 'beta') {
      if (!Array.isArray(value)) fail(label, 'beta must be an array');
      for (const token of value) assertBoundedString(token, `${label}.beta`, SAFE_TOKEN);
    } else {
      assertBoundedString(value, `${label}.${key}`, SAFE_TOKEN);
    }
  }
}

function validateRejection(rejection, label) {
  assertObject(rejection, label);
  assertKnownKeys(rejection, REJECTION_KEYS, label);
  if (!Number.isInteger(rejection.status) || rejection.status < 400 || rejection.status > 599) fail(label, 'status is invalid');
  assertObject(rejection.fields, `${label}.fields`);
  for (const [path, value] of Object.entries(rejection.fields)) {
    if (!/^(?:error|response\.error)\.(?:type|code|param)$/.test(path)) fail(label, `field path ${path} is not allowed`);
    if (value !== null) assertBoundedString(value, `${label}.fields.${path}`, SAFE_TOKEN);
  }
}

function normalizeRejection(rejection) {
  return {
    status: rejection.status,
    fields: Object.fromEntries(Object.entries(rejection.fields).sort(([left], [right]) => left.localeCompare(right)))
  };
}

function compareSection(category, expected, actual, drifts) {
  if (canonicalJson(expected) !== canonicalJson(actual)) drifts.push({ category, expected: expected ?? null, actual: actual ?? null });
}

function comparePathRows(left, right) {
  return left.path.localeCompare(right.path) || canonicalJson(left).localeCompare(canonicalJson(right));
}

function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}

function wireJson(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Projected fixture has no JSON wire representation');
  return JSON.parse(encoded);
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail(label, 'contains an unknown field');
}

function assertObject(value, label) {
  if (!plainObject(value)) fail(label, 'must be an object');
}

function assertBoundedString(value, label, pattern = null) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_STRING_BYTES || /[\x00-\x1f\x7f]/.test(value)) fail(label, 'must be a bounded printable string');
  if (pattern && !pattern.test(value)) fail(label, 'has an invalid format');
}

function validateNegotiationHeader(name, value, label) {
  assertBoundedString(value, label);
  const tokens = name === 'openai-beta' || name === 'anthropic-beta' ? value.split(',') : [value];
  if (tokens.some((token) => !SAFE_TOKEN.test(token.trim()))) fail(label, 'has an invalid format');
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fixtureError(filename, message) {
  return new Error(`${filename}: ${message}`);
}

function fail(label, message) {
  throw new Error(`${label}: ${message}`);
}

function canonicalJson(value) {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

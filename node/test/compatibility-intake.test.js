import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeCompatibilityCapture,
  closestCompatibilityFixture,
  loadCompatibilityCapture,
  renderCompatibilityIntakeReport,
  sanitizeCompatibilityCapture,
  validateCompatibilityCapture
} from '../src/compatibility-intake.js';
import { loadCompatibilityFixtures, validateCompatibilityFixture } from '../src/compatibility-fixtures.js';
import { intakeCompatibilityCapture } from '../scripts/intake-compatibility-capture.js';

const FIXTURE_DIRECTORY = fileURLToPath(new URL('../fixtures/compatibility/', import.meta.url));
const CAPTURE_DIRECTORY = fileURLToPath(new URL('../fixtures/compatibility-intake/', import.meta.url));

test('sanitizes raw captures deterministically without retaining credentials or content', async () => {
  const capture = await loadCompatibilityCapture(join(CAPTURE_DIRECTORY, 'codex-future-sse.capture.json'));
  const first = sanitizeCompatibilityCapture(capture);
  const second = sanitizeCompatibilityCapture(capture);
  assert.deepEqual(first, second);
  validateCompatibilityFixture(first, { requireExpected: false });
  const serialized = JSON.stringify(first);
  for (const secret of ['fixture-auth-value', 'fixture-cookie-value', 'fixture-client-secret', 'fixture-session-token', 'gpt-private-preview', 'synthetic customer prompt', 'private_tool_name']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.equal(serialized.includes('client_secret'), false);
  assert.equal(serialized.includes('sessionToken'), false);
  assert.equal(first.request.body.model, 'fixture-model');
  assert.equal(first.request.body.input[0].content[0].text, 'fixture-text');
  assert.equal(first.request.body.tools[0].type, 'future_tool');
  assert.equal(first.request.body.tools[0].name, 'fixture-name');
  assert.deepEqual(first.negotiation.headers, {});
});

test('retains only structured rejection fields and classifies future Claude content blocks', async () => {
  const [capture, baselines] = await Promise.all([
    loadCompatibilityCapture(join(CAPTURE_DIRECTORY, 'claude-future-block.capture.json')),
    loadCompatibilityFixtures(FIXTURE_DIRECTORY)
  ]);
  const result = analyzeCompatibilityCapture(capture, baselines);
  assert.equal(result.status, 'rejection_review');
  assert.equal(result.baseline.fixtureId, 'compass-anthropic-messages-1.0.0');
  assert.ok(result.classification.includes('new_client_version'));
  assert.ok(result.classification.includes('new_request_discriminator'));
  assert.ok(result.classification.includes('structured_rejection_review'));
  assert.ok(result.classification.includes('unsupported_field_rejection'));
  assert.deepEqual(result.draft.rejection, {
    status: 400,
    fields: {
      'error.code': 'unsupported_content_block',
      'error.param': 'messages',
      'error.type': 'invalid_request_error'
    }
  });
  const report = renderCompatibilityIntakeReport(result);
  assert.equal(report.includes('provider-private'), false);
  assert.equal(JSON.stringify(result.draft).includes('synthetic customer request'), false);
  assert.match(report, /review_structured_rejection/);
  assert.match(report, /review_fallback_boundary/);
});

test('drops structured rejection params that do not name a top-level request field', async () => {
  const capture = baseCapture({
    model: 'private-model',
    input: 'private prompt',
    stream: false
  });
  capture.response = {
    status: 400,
    body: {
      error: {
        type: 'invalid_request_error',
        code: 'invalid_schema',
        param: 'customer_email',
        message: 'private detail'
      }
    }
  };
  const result = analyzeCompatibilityCapture(capture, await loadCompatibilityFixtures(FIXTURE_DIRECTORY));
  assert.equal(Object.hasOwn(result.draft.rejection.fields, 'error.param'), false);
  assert.equal(JSON.stringify(result).includes('customer_email'), false);
});

test('reports stable adapter errors without echoing the rejected capture', async () => {
  const [capture, baselines] = await Promise.all([
    loadCompatibilityCapture(join(CAPTURE_DIRECTORY, 'codex-unsupported-mcp.capture.json')),
    loadCompatibilityFixtures(FIXTURE_DIRECTORY)
  ]);
  const result = analyzeCompatibilityCapture(capture, baselines);
  assert.equal(result.status, 'adapter_change_required');
  assert.equal(result.capture.draftReady, false);
  assert.ok(result.classification.includes('adapter_change_required'));
  assert.equal(result.projectionError.code, 'invalid_request');
  assert.equal(result.projectionError.param, 'tools');
  const report = renderCompatibilityIntakeReport(result, { format: 'json' });
  assert.equal(report.includes('private.example.test'), false);
  assert.equal(report.includes('nested-secret'), false);
});

test('matches the closest same-profile fixture deterministically', async () => {
  const baselines = await loadCompatibilityFixtures(FIXTURE_DIRECTORY);
  const capture = await loadCompatibilityCapture(join(CAPTURE_DIRECTORY, 'codex-future-sse.capture.json'));
  const draft = sanitizeCompatibilityCapture(capture);
  const closest = closestCompatibilityFixture(draft, [...baselines].reverse());
  assert.equal(closest.fixture.id, 'codex-public-sse-0.146.1');
  assert.ok(closest.similarity > 0.5 && closest.similarity < 1);
});

test('reports exact when a capture sanitizes to an existing fixture contract', async () => {
  const baselines = await loadCompatibilityFixtures(FIXTURE_DIRECTORY);
  const fixture = baselines.find(({ fixture: item }) => item.id === 'codex-public-sse-0.146.1').fixture;
  const capture = {
    schemaVersion: 1,
    profile: fixture.profile,
    client: fixture.client,
    request: {
      path: '/v1/responses',
      headers: { authorization: 'Bearer ignored' },
      body: structuredClone(fixture.request.body)
    }
  };
  const result = analyzeCompatibilityCapture(capture, baselines);
  assert.equal(result.status, 'exact');
  assert.deepEqual(result.classification, []);
  assert.equal(result.suggestions[0].code, 'no_action');
});

test('classifies native negotiation-only changes without request-shape churn', async () => {
  const baselines = await loadCompatibilityFixtures(FIXTURE_DIRECTORY);
  const fixture = baselines.find(({ fixture: item }) => item.profile === 'codex-native-http').fixture;
  const capture = {
    schemaVersion: 1,
    profile: fixture.profile,
    client: { family: 'codex', version: '0.200.0' },
    request: {
      path: '/backend-api/codex/responses',
      headers: {
        version: '0.200.0',
        originator: 'codex_cli_rs',
        'openai-beta': 'future_responses=2026-08-16',
        authorization: 'Bearer ignored'
      },
      body: structuredClone(fixture.request.body)
    }
  };
  const result = analyzeCompatibilityCapture(capture, baselines);
  assert.ok(result.classification.includes('new_client_version'));
  assert.ok(result.classification.includes('protocol_negotiation_review'));
  assert.equal(result.classification.includes('request_shape_addition'), false);
  assert.equal(result.classification.includes('request_shape_removal'), false);
});

test('preserves strict schema relationships with synthetic property and reference names', async () => {
  const capture = baseCapture({
    model: 'private-model',
    input: 'private prompt',
    stream: false,
    tools: [{
      type: 'function',
      name: 'private_function',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          customer_email: { $ref: '#/$defs/private_contact' }
        },
        required: ['customer_email'],
        additionalProperties: false,
        $defs: {
          private_contact: { type: 'string' }
        }
      }
    }]
  });
  const draft = sanitizeCompatibilityCapture(capture);
  const parameters = draft.request.body.tools[0].parameters;
  const propertyName = Object.keys(parameters.properties)[0];
  const definitionName = Object.keys(parameters.$defs)[0];
  assert.equal(propertyName, parameters.required[0]);
  assert.equal(parameters.properties[propertyName].$ref, `#/$defs/${definitionName}`);
  const result = analyzeCompatibilityCapture(capture, await loadCompatibilityFixtures(FIXTURE_DIRECTORY));
  assert.equal(result.capture.draftReady, true);
  assert.notEqual(result.status, 'adapter_change_required');
});

test('infers public WebSocket generate and strips the transport envelope', () => {
  const capture = {
    schemaVersion: 1,
    profile: 'codex-public-websocket',
    client: { family: 'codex', version: '0.200.0' },
    request: {
      path: '/v1/responses',
      headers: {},
      body: {
        type: 'response.create',
        model: 'private-model',
        input: 'private prompt',
        stream_id: 'private-lane',
        generate: false
      }
    }
  };
  const draft = sanitizeCompatibilityCapture(capture);
  assert.equal(draft.request.generate, false);
  assert.equal(Object.hasOwn(draft.request.body, 'type'), false);
  assert.equal(Object.hasOwn(draft.request.body, 'stream_id'), false);
});

test('uses adapter-valid content-free media placeholders', async () => {
  const capture = baseCapture({
    model: 'private-model',
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_image', image_url: 'https://private.example.test/image.png' },
        { type: 'input_file', filename: 'private-notes.txt', file_data: 'data:text/plain;base64,cHJpdmF0ZQ==' }
      ]
    }],
    stream: false
  });
  const result = analyzeCompatibilityCapture(capture, await loadCompatibilityFixtures(FIXTURE_DIRECTORY));
  assert.equal(result.capture.draftReady, true);
  const parts = result.draft.request.body.input[0].content;
  assert.equal(parts[0].image_url, 'data:image/png;base64,AA==');
  assert.equal(parts[1].filename, 'fixture-name');
  assert.equal(parts[1].file_data, 'data:text/plain;base64,QQ==');
  assert.equal(JSON.stringify(result.draft).includes('private.example.test'), false);
});

test('anonymizes arbitrary keys inside tool arguments, metadata, and JSON values', () => {
  const capture = baseCapture({
    model: 'private-model',
    input: [{
      type: 'custom_tool_call',
      call_id: 'private-call',
      name: 'private-tool',
      arguments: {
        customer_email: 'person@example.test',
        nested_profile: { legal_name: 'Private Person' }
      },
      metadata: {
        private_tenant_name: 'Private Tenant'
      }
    }],
    stream: false
  });
  const draft = sanitizeCompatibilityCapture(capture);
  const serialized = JSON.stringify(draft);
  for (const value of ['customer_email', 'nested_profile', 'legal_name', 'private_tenant_name', 'person@example.test', 'Private Person', 'Private Tenant']) {
    assert.equal(serialized.includes(value), false, value);
  }
  assert.match(serialized, /fixture-field-/);
});

test('renames prototype-sensitive capture keys without mutating object prototypes', () => {
  const body = JSON.parse('{"model":"private-model","input":"private prompt","stream":false,"__proto__":{"polluted":true},"constructor":{"private":"value"},"prototype":{"private":"value"}}');
  const draft = sanitizeCompatibilityCapture(baseCapture(body));
  const serialized = JSON.stringify(draft);
  assert.equal(Object.hasOwn(draft.request.body, '__proto__'), false);
  assert.equal(Object.hasOwn(draft.request.body, 'constructor'), false);
  assert.equal(Object.hasOwn(draft.request.body, 'prototype'), false);
  assert.equal({}.polluted, undefined);
  assert.equal(serialized.includes('"polluted"'), false);
  assert.match(serialized, /fixture-field-/);
});

test('CLI helper writes a sanitized draft only when an output path is supplied', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'compatibility-intake-cli-'));
  try {
    const outputPath = join(directory, 'draft.json');
    const capturePath = join(CAPTURE_DIRECTORY, 'codex-future-sse.capture.json');
    const result = await intakeCompatibilityCapture({
      capturePath,
      outputPath,
      fixtureDirectory: FIXTURE_DIRECTORY,
      format: 'json'
    });
    assert.equal(result.result.status, 'review');
    const draft = JSON.parse(await readFile(outputPath, 'utf8'));
    validateCompatibilityFixture(draft);
    await assert.rejects(() => intakeCompatibilityCapture({
      capturePath,
      outputPath,
      fixtureDirectory: FIXTURE_DIRECTORY
    }), /EEXIST/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects malformed, oversized, and profile-mismatched captures', async () => {
  assert.throws(() => validateCompatibilityCapture({
    schemaVersion: 1,
    profile: 'codex-public-http',
    client: { family: 'claude-code', version: '1.0.0' },
    request: { path: '/v1/responses', headers: {}, body: {} }
  }), /family does not match/);
  assert.throws(() => validateCompatibilityCapture({
    schemaVersion: 1,
    profile: 'codex-public-http',
    client: { family: 'codex', version: '1.0.0' },
    request: { path: '/wrong', headers: {}, body: {} }
  }), /path does not match/);
  assert.throws(() => validateCompatibilityCapture({
    schemaVersion: 1,
    profile: 'codex-public-http',
    client: { family: 'codex', version: '1.0.0' },
    request: {
      path: '/v1/responses',
      headers: {},
      body: { input: Array.from({ length: 257 }, () => 'private') }
    }
  }), /oversized array/);

  const repeated = baseCapture({
    model: 'private-model',
    input: Array.from({ length: 200 }, () => ({ type: 'message', role: 'user', content: 'private prompt' })),
    stream: false
  });
  assert.equal(sanitizeCompatibilityCapture(repeated).request.body.input.length, 1);

  const distinct = baseCapture({
    model: 'private-model',
    input: Array.from({ length: 33 }, (_, index) => ({ type: `future_${index}`, value: index })),
    stream: false
  });
  assert.throws(() => sanitizeCompatibilityCapture(distinct), /too many distinct sanitized shapes/);

  const directory = mkdtempSync(join(tmpdir(), 'compatibility-intake-bounds-'));
  try {
    const path = join(directory, 'capture.json');
    writeFileSync(path, ' '.repeat(256 * 1024 + 1));
    await assert.rejects(() => loadCompatibilityCapture(path), /exceeds 256 KiB/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function baseCapture(body) {
  return {
    schemaVersion: 1,
    profile: 'codex-public-http',
    client: { family: 'codex', version: '0.200.0' },
    request: { path: '/v1/responses', headers: {}, body }
  };
}

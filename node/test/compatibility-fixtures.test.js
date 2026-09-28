import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPATIBILITY_FIXTURE_PROFILES,
  compareCompatibilityFixture,
  compatibilityFixtureReport,
  loadCompatibilityFixtures,
  renderCompatibilityFixtureReport,
  replayCompatibilityFixture,
  validateCompatibilityFixture,
  withUpdatedCompatibilityExpectation
} from '../src/compatibility-fixtures.js';
import { checkCompatibilityFixtures } from '../scripts/check-compatibility-fixtures.js';

const FIXTURE_DIRECTORY = fileURLToPath(new URL('../fixtures/compatibility/', import.meta.url));

test('loads and replays every compatibility transport fixture without drift', async () => {
  const entries = await loadCompatibilityFixtures(FIXTURE_DIRECTORY);
  assert.deepEqual(
    [...new Set(entries.map(({ fixture }) => fixture.profile))].sort(),
    [...COMPATIBILITY_FIXTURE_PROFILES].sort()
  );
  const report = compatibilityFixtureReport(entries);
  assert.deepEqual(report.counts, {
    fixtures: entries.length,
    passed: entries.length,
    drifted: 0,
    invalid: 0
  });
  assert.equal(report.status, 'ok');
  for (const { fixture } of entries) {
    assert.deepEqual(replayCompatibilityFixture(fixture), fixture.expected, fixture.id);
  }
});

test('produces deterministic JSON and Markdown reports', async () => {
  const entries = await loadCompatibilityFixtures(FIXTURE_DIRECTORY);
  const report = compatibilityFixtureReport([...entries].reverse());
  const json = renderCompatibilityFixtureReport(report, { format: 'json' });
  const markdown = renderCompatibilityFixtureReport(report);
  assert.equal(json, renderCompatibilityFixtureReport(compatibilityFixtureReport(entries), { format: 'json' }));
  assert.equal(markdown, renderCompatibilityFixtureReport(compatibilityFixtureReport(entries)));
  assert.match(markdown, /^# Compatibility Fixture Report\n\nStatus: ok/m);
  assert.equal(json.includes('fixture-text'), false);
  assert.equal(markdown.includes('fixture-text'), false);
});

test('categorizes target, fingerprint, projection, and structured rejection drift', async () => {
  const entries = await loadCompatibilityFixtures(FIXTURE_DIRECTORY);
  const fixture = clone(entries.find(({ fixture: item }) => item.id === 'compass-anthropic-messages-1.0.0').fixture);
  fixture.expected.targetPath = '/changed';
  fixture.expected.fingerprint.hash = '0'.repeat(32);
  fixture.expected.projection.paths.pop();
  fixture.expected.rejection.fields['error.param'] = 'temperature';
  assert.deepEqual(
    compareCompatibilityFixture(fixture).drifts.map(({ category }) => category),
    ['target_route', 'protocol_fingerprint', 'projected_shape', 'rejection_contract']
  );
});

test('rejects secrets, real content, provider messages, unknown fields, and oversized files', async () => {
  const entries = await loadCompatibilityFixtures(FIXTURE_DIRECTORY);
  const base = entries.find(({ fixture }) => fixture.profile === 'codex-public-http').fixture;
  const cases = [
    [mutate(base, (fixture) => { fixture.request.body.authorization = 'Bearer fixture-secret'; }), /authorization is forbidden/],
    [mutate(base, (fixture) => { fixture.request.body.input = 'real customer prompt'; }), /must use a fixed fixture content marker/],
    [mutate(base, (fixture) => { fixture.rejection = { status: 400, fields: { 'error.message': 'fixture-text' } }; }), /field path error\.message is not allowed/],
    [mutate(base, (fixture) => { fixture.request.unknown = true; }), /contains an unknown field/],
    [mutate(base, (fixture) => { fixture.request.body.model = 'gpt-private'; }), /must use fixture-model/],
    [mutate(base, (fixture) => { fixture.negotiation.headers.authorization = 'fixture-secret'; }), /negotiation header authorization is not allowed/],
    [mutate(base, (fixture) => { fixture.request.body.tools[0].parameters.properties.customer_name = { type: 'string' }; }), /dynamic field names must use fixture- markers/],
    [mutate(base, (fixture) => { fixture.request.body.tools[0].type = 'customer secret'; }), /must use a token-shaped enum/],
    [mutate(base, (fixture) => { fixture.request.body.tools[0].parameters = JSON.parse('{"type":"object","properties":{},"__proto__":{"polluted":true}}'); }), /__proto__ is unsafe/],
    [mutate(base, (fixture) => { fixture.expected.projection.paths[0].path = '$.customer name'; }), /path is invalid/]
  ];
  for (const [fixture, pattern] of cases) assert.throws(() => validateCompatibilityFixture(fixture), pattern);

  const directory = mkdtempSync(join(tmpdir(), 'compatibility-fixtures-oversized-'));
  try {
    writeFileSync(join(directory, 'oversized.json'), ' '.repeat(128 * 1024 + 1));
    await assert.rejects(() => loadCompatibilityFixtures(directory), /exceeds 128 KiB/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects duplicate fixture IDs before reporting', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'compatibility-fixtures-duplicate-'));
  try {
    const source = await readFile(join(FIXTURE_DIRECTORY, 'codex-public-http.json'), 'utf8');
    writeFileSync(join(directory, 'first.json'), source);
    writeFileSync(join(directory, 'second.json'), source);
    await assert.rejects(() => loadCompatibilityFixtures(directory), /fixture ID is duplicated/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('updates structural expectations explicitly and then reports cleanly', async () => {
  const entries = await loadCompatibilityFixtures(FIXTURE_DIRECTORY);
  const fixture = clone(entries.find(({ fixture: item }) => item.profile === 'codex-public-websocket').fixture);
  delete fixture.expected;
  fixture.request.body.max_output_tokens = 333;
  const updated = withUpdatedCompatibilityExpectation(fixture);
  assert.equal(updated.expected.targetPath, '/backend-api/codex/responses');
  assert.ok(updated.expected.projection.paths.some(({ path }) => path === '$.max_output_tokens'));
  assert.equal(compareCompatibilityFixture(updated).drifts.length, 0);
});

test('CLI helper returns drift without rewriting unless update is explicit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'compatibility-fixtures-cli-'));
  try {
    const source = join(FIXTURE_DIRECTORY, 'codex-public-http.json');
    const fixture = JSON.parse(await readFile(source, 'utf8'));
    fixture.expected.targetPath = '/drifted';
    const target = join(directory, 'fixture.json');
    writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);

    let result = await checkCompatibilityFixtures({ directory, format: 'json' });
    assert.equal(result.report.status, 'drift');
    assert.equal(JSON.parse(await readFile(target, 'utf8')).expected.targetPath, '/drifted');

    result = await checkCompatibilityFixtures({ directory, update: true, format: 'json' });
    assert.equal(result.report.status, 'ok');
    assert.equal(JSON.parse(await readFile(target, 'utf8')).expected.targetPath, '/backend-api/codex/responses');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function mutate(value, operation) {
  const copy = clone(value);
  operation(copy);
  return copy;
}

function clone(value) {
  return structuredClone(value);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCompatibilityReleaseClient } from '../src/compatibility-release-client.js';
import {
  clientProcessFailure,
  fetchPackageMetadata,
  loadCompatibilityReleaseManifest,
  networkIsolation,
  prepareReviewedPackage,
  renderCompatibilityReleaseReport,
  runCompatibilityReleaseGate,
  validateCompatibilityReleaseManifest,
  verifyPublishedVersion
} from '../src/compatibility-release-gate.js';
import { loadCompatibilityCapture } from '../src/compatibility-intake.js';

const MANIFEST_PATH = fileURLToPath(new URL('../fixtures/compatibility-releases.json', import.meta.url));
const FIXTURE_DIRECTORY = fileURLToPath(new URL('../fixtures/compatibility/', import.meta.url));
const FAKE_CLIENT = fileURLToPath(new URL('../fixtures/compatibility-release-clients/fake-client.js', import.meta.url));

test('validates the reviewed release manifest and rejects identity or extraction changes', async () => {
  const manifest = await loadCompatibilityReleaseManifest(MANIFEST_PATH);
  assert.deepEqual(manifest.clients.map(({ id }) => id), ['codex', 'claude-code']);
  const changedIdentity = structuredClone(manifest);
  changedIdentity.clients[0].package = '@example/codex';
  assert.throws(() => validateCompatibilityReleaseManifest(changedIdentity), /identity is invalid/);
  const traversal = structuredClone(manifest);
  traversal.clients[0].platforms['darwin-arm64'].executable = '../../private';
  assert.throws(() => validateCompatibilityReleaseManifest(traversal), /executable is invalid/);
  const unknown = structuredClone(manifest);
  unknown.clients[0].unexpected = true;
  assert.throws(() => validateCompatibilityReleaseManifest(unknown), /not allowed/);
  const registry = structuredClone(manifest);
  registry.registry = 'https://registry.example.test';
  assert.throws(() => validateCompatibilityReleaseManifest(registry), /registry is invalid/);
});

test('verifies exact published package provenance and rejects integrity or insecure tarballs', () => {
  const integrity = sri('package');
  const metadata = packageMetadata('@example/client', '1.2.3', integrity);
  assert.equal(verifyPublishedVersion(metadata, '@example/client', '1.2.3', integrity).version, '1.2.3');
  assert.throws(() => verifyPublishedVersion(metadata, '@example/client', '1.2.4', integrity), /reviewed_version_missing/);
  assert.throws(() => verifyPublishedVersion(metadata, '@example/client', '1.2.3', sri('changed')), /package_integrity_changed/);
  metadata.dist.tarball = 'http://registry.example.test/client.tgz';
  assert.throws(() => verifyPublishedVersion(metadata, '@example/client', '1.2.3', integrity), /package_tarball_invalid/);
});

test('bounds and validates registry metadata', async () => {
  const integrity = sri('package');
  const valid = await fetchPackageMetadata('https://registry.example.test', '@example/client', '1.2.3', async (url, options) => {
    assert.equal(url.href, 'https://registry.example.test/@example%2fclient/1.2.3');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.accept, 'application/json');
    return new Response(JSON.stringify(packageMetadata('@example/client', '1.2.3', integrity)));
  });
  assert.equal(valid.name, '@example/client');
  await assert.rejects(() => fetchPackageMetadata('https://registry.example.test', '@example/client', '1.2.3', async () => (
    new Response('x', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } })
  )), /registry_metadata_too_large/);
  await assert.rejects(() => fetchPackageMetadata('https://registry.example.test', '@example/client', '1.2.3', async () => (
    new Response(JSON.stringify({ name: '@wrong/client', version: '1.2.3', dist: {} }))
  )), /registry_metadata_invalid/);
  await assert.rejects(() => fetchPackageMetadata('https://registry.example.test', '@example/client', '1.2.3', async () => (
    new Response(new Uint8Array(2 * 1024 * 1024 + 1))
  )), /registry_metadata_too_large/);
});

test('downloads, verifies, and extracts only the reviewed executable member', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'compatibility-release-package-'));
  try {
    const source = join(directory, 'source');
    mkdirSync(join(source, 'package', 'bin'), { recursive: true });
    const executableBody = '#!/bin/sh\nexit 0\n';
    const executableSource = join(source, 'package', 'bin', 'client');
    writeFileSync(executableSource, executableBody);
    chmodSync(executableSource, 0o700);
    const archive = join(directory, 'client.tgz');
    const { status } = await import('node:child_process').then(({ spawnSync }) => (
      spawnSync('tar', ['-czf', archive, '-C', source, 'package'], { stdio: 'ignore' })
    ));
    assert.equal(status, 0);
    const archiveBytes = await readFile(archive);
    const integrity = `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`;
    const platformEntry = {
      package: '@example/client',
      version: '1.2.3',
      integrity,
      executable: 'bin/client'
    };
    const packageMetadataValue = packageMetadata(platformEntry.package, platformEntry.version, integrity);
    let downloads = 0;
    const prepare = () => prepareReviewedPackage({
      registry: 'https://registry.npmjs.org',
      platformEntry,
      packageMetadata: packageMetadataValue,
      cacheDirectory: join(directory, 'cache'),
      offline: false,
      fetchImpl: async () => {
        downloads += 1;
        return new Response(archiveBytes);
      }
    });
    const [extracted, concurrent] = await Promise.all([prepare(), prepare()]);
    assert.equal(concurrent, extracted);
    assert.equal(downloads, 1);
    assert.equal(await readFile(extracted, 'utf8'), executableBody);
    const offline = await prepareReviewedPackage({
      registry: 'https://registry.npmjs.org',
      platformEntry,
      packageMetadata: null,
      cacheDirectory: join(directory, 'cache'),
      offline: true
    });
    assert.equal(offline, extracted);
    writeFileSync(join(extracted, '..', 'package.tgz'), 'corrupt archive');
    await assert.rejects(() => prepareReviewedPackage({
      registry: 'https://registry.npmjs.org',
      platformEntry,
      packageMetadata: null,
      cacheDirectory: join(directory, 'cache'),
      offline: true
    }), /package_cache_invalid/);
    await assert.rejects(() => prepareReviewedPackage({
      registry: 'https://registry.npmjs.org',
      platformEntry,
      packageMetadata: null,
      cacheDirectory: join(directory, 'empty-cache'),
      offline: true
    }), /package_cache_missing/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const family of ['codex', 'claude-code']) {
  test(`captures a bounded local ${family} request using a disposable synthetic client`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `compatibility-release-${family}-`));
    try {
      const capturePath = join(directory, 'capture.json');
      const result = await runCompatibilityReleaseClient({
        family,
        version: family === 'codex' ? '0.147.0' : '2.1.233',
        executable: process.execPath,
        capturePath,
        workingDirectory: directory,
        spawnImpl: (_command, args, options) => {
          assert.ok(args.length);
          return spawn(process.execPath, [FAKE_CLIENT, family], options);
        }
      });
      assert.equal(result.captured, true);
      const capture = await loadCompatibilityCapture(capturePath);
      assert.equal(capture.profile, family === 'codex' ? 'codex-public-sse' : 'compass-anthropic-messages');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('discovers newer releases without executing an unreviewed version', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'compatibility-release-gate-'));
  try {
    const manifest = await loadCompatibilityReleaseManifest(MANIFEST_PATH);
    const selected = manifest.clients.find(({ id }) => id === 'codex');
    let preparedVersion;
    let executedVersion;
    const report = await runCompatibilityReleaseGate({
      manifestPath: MANIFEST_PATH,
      fixtureDirectory: FIXTURE_DIRECTORY,
      cacheDirectory: directory,
      clientId: 'codex',
      platform: 'darwin-arm64',
      fetchImpl: metadataFetch(selected, '9.9.9'),
      preparePackage: async ({ platformEntry }) => {
        preparedVersion = platformEntry.version;
        return '/tmp/reviewed-client';
      },
      executeClient: async ({ client }) => {
        executedVersion = client.version;
        return { state: 'captured', intake: exactIntake(client) };
      }
    });
    assert.equal(report.status, 'review');
    assert.equal(report.results[0].releaseState, 'new_release');
    assert.equal(preparedVersion, '0.147.0-darwin-arm64');
    assert.equal(executedVersion, '0.147.0');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reports compatibility drift and sanitizes failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'compatibility-release-report-'));
  try {
    const manifest = await loadCompatibilityReleaseManifest(MANIFEST_PATH);
    const selected = manifest.clients.find(({ id }) => id === 'codex');
    const report = await runCompatibilityReleaseGate({
      manifestPath: MANIFEST_PATH,
      fixtureDirectory: FIXTURE_DIRECTORY,
      cacheDirectory: directory,
      clientId: 'codex',
      platform: 'darwin-arm64',
      fetchImpl: metadataFetch(selected, selected.version),
      preparePackage: async () => '/tmp/reviewed-client',
      executeClient: async ({ client }) => ({
        state: 'captured',
        intake: {
          ...exactIntake(client),
          status: 'review',
          classification: ['request_shape_addition'],
          changes: [{
            category: 'request_shape',
            summary: 'JSON path/type structure changed',
            added: Array.from({ length: 30 }, (_, index) => `$.field_${index}:string`),
            removed: ['$.old:string']
          }],
          suggestions: [{ code: 'add_regression_fixture', summary: 'Review the sanitized draft' }]
        }
      })
    });
    assert.equal(report.status, 'review');
    assert.equal(report.results[0].compatibility.classification[0], 'request_shape_addition');
    assert.equal(report.results[0].compatibility.changes[0].addedCount, 30);
    assert.equal(report.results[0].compatibility.changes[0].added.length, 24);
    assert.equal(report.results[0].compatibility.changes[0].removedCount, 1);
    const output = renderCompatibilityReleaseReport(report);
    assert.match(output, /add_regression_fixture/);
    assert.equal(output.includes('fixture-api-key'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fails closed when platform isolation is unavailable', () => {
  assert.equal(networkIsolation('linux-x64'), null);
  const isolation = networkIsolation('darwin-arm64');
  assert.equal(isolation.name, 'sandbox-exec-loopback');
  const command = isolation.command({ node: '/node', helperPath: '/helper', configPath: '/config' });
  assert.equal(command.command, '/usr/bin/sandbox-exec');
  assert.match(command.args[1], /deny network/);
  assert.match(command.args[1], /localhost/);
});

test('rejects missing, timed out, oversized, and nonzero client process results', () => {
  assert.equal(clientProcessFailure({ captured: false }), 'capture_missing');
  assert.equal(clientProcessFailure({ captured: true, timedOut: true, exitCode: 0 }), 'client_timeout');
  assert.equal(clientProcessFailure({ captured: true, outputLimitExceeded: true, exitCode: 0 }), 'client_output_limit');
  assert.equal(clientProcessFailure({ captured: true, signal: 'SIGKILL', exitCode: null }), 'client_exit_failure');
  assert.equal(clientProcessFailure({ captured: true, signal: null, exitCode: 7 }), 'client_exit_failure');
  assert.equal(clientProcessFailure({ captured: true, signal: null, exitCode: 0 }), null);
});

test('rejects oversized release manifests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'compatibility-release-manifest-'));
  try {
    const path = join(directory, 'manifest.json');
    writeFileSync(path, ' '.repeat(128 * 1024 + 1));
    await assert.rejects(() => loadCompatibilityReleaseManifest(path), /exceeds 128 KiB/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function metadataFetch(client, latestVersion) {
  const platform = client.platforms['darwin-arm64'];
  const latest = packageMetadata(client.package, latestVersion, client.integrity);
  const root = packageMetadata(client.package, client.version, client.integrity);
  const selected = packageMetadata(platform.package, platform.version, platform.integrity);
  return async (url) => {
    const name = decodeURIComponent(url.pathname.slice(1));
    const separator = name.lastIndexOf('/');
    const packageName = name.slice(0, separator);
    const version = name.slice(separator + 1);
    const metadata = version === 'latest'
      ? latest
      : packageName === client.package && version === client.version ? root : selected;
    return new Response(JSON.stringify(metadata));
  };
}

function packageMetadata(name, version, integrity) {
  return {
    name,
    version,
    dist: {
      integrity,
      tarball: `https://registry.npmjs.org/${name.replace('/', '-')}-${version}.tgz`
    }
  };
}

function exactIntake(client) {
  return {
    status: 'exact',
    capture: {
      fixtureId: `${client.id}-fixture`,
      profile: client.profile,
      clientVersion: client.version,
      draftReady: true
    },
    baseline: { fixtureId: 'baseline', clientVersion: client.version, similarity: 1 },
    classification: [],
    changes: [],
    suggestions: [{ code: 'no_action', summary: 'The capture matches the closest committed fixture' }]
  };
}

function sri(value) {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

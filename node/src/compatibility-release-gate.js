import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { analyzeCompatibilityCapture, loadCompatibilityCapture } from './compatibility-intake.js';
import { loadCompatibilityFixtures } from './compatibility-fixtures.js';

export const COMPATIBILITY_RELEASE_MANIFEST_SCHEMA_VERSION = 1;

const MANIFEST_KEYS = new Set(['schemaVersion', 'registry', 'clients']);
const CLIENT_KEYS = new Set(['id', 'family', 'package', 'version', 'integrity', 'profile', 'platforms']);
const PLATFORM_KEYS = new Set(['package', 'version', 'integrity', 'executable']);
const CLIENT_IDENTITIES = Object.freeze({
  codex: { family: 'codex', package: '@openai/codex', profile: 'codex-public-sse' },
  'claude-code': { family: 'claude-code', package: '@anthropic-ai/claude-code', profile: 'compass-anthropic-messages' }
});
const SUPPORTED_PLATFORMS = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const PACKAGE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const ARCHIVE_MEMBER = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = MAX_PACKAGE_BYTES;
const EXECUTION_TIMEOUT_MS = 60_000;
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;
const MAX_CHANGE_SAMPLES = 24;
const packagePreparationQueues = new Map();

export async function loadCompatibilityReleaseManifest(path) {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error('Release manifest exceeds 128 KiB');
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Release manifest is not valid JSON');
  }
  return validateCompatibilityReleaseManifest(manifest);
}

export function validateCompatibilityReleaseManifest(manifest) {
  assertObject(manifest, 'manifest');
  assertKnownKeys(manifest, MANIFEST_KEYS, 'manifest');
  if (manifest.schemaVersion !== COMPATIBILITY_RELEASE_MANIFEST_SCHEMA_VERSION) fail('manifest.schemaVersion is unsupported');
  const registry = new URL(manifest.registry);
  if (registry.href !== 'https://registry.npmjs.org/') fail('manifest.registry is invalid');
  if (!Array.isArray(manifest.clients) || !manifest.clients.length || manifest.clients.length > 2) fail('manifest.clients is invalid');
  const ids = new Set();
  for (const [index, client] of manifest.clients.entries()) {
    const label = `manifest.clients[${index}]`;
    assertObject(client, label);
    assertKnownKeys(client, CLIENT_KEYS, label);
    const identity = CLIENT_IDENTITIES[client.id];
    if (!identity || ids.has(client.id)) fail(`${label}.id is invalid`);
    ids.add(client.id);
    if (client.family !== identity.family || client.package !== identity.package || client.profile !== identity.profile) fail(`${label} identity is invalid`);
    assertToken(client.version, `${label}.version`);
    assertIntegrity(client.integrity, `${label}.integrity`);
    assertObject(client.platforms, `${label}.platforms`);
    const platformEntries = Object.entries(client.platforms);
    if (!platformEntries.length || platformEntries.length > SUPPORTED_PLATFORMS.size) fail(`${label}.platforms is invalid`);
    for (const [platform, item] of platformEntries) {
      const platformLabel = `${label}.platforms.${platform}`;
      if (!SUPPORTED_PLATFORMS.has(platform)) fail(`${platformLabel} is unsupported`);
      assertObject(item, platformLabel);
      assertKnownKeys(item, PLATFORM_KEYS, platformLabel);
      if (!PACKAGE.test(item.package)) fail(`${platformLabel}.package is invalid`);
      if (client.id === 'codex' && item.package !== '@openai/codex') fail(`${platformLabel}.package is invalid`);
      if (client.id === 'claude-code' && item.package !== `@anthropic-ai/claude-code-${platform}`) fail(`${platformLabel}.package is invalid`);
      assertToken(item.version, `${platformLabel}.version`);
      assertIntegrity(item.integrity, `${platformLabel}.integrity`);
      if (!ARCHIVE_MEMBER.test(item.executable)) fail(`${platformLabel}.executable is invalid`);
    }
  }
  return manifest;
}

export async function runCompatibilityReleaseGate({
  manifestPath,
  fixtureDirectory,
  cacheDirectory,
  clientId = '',
  offline = false,
  fetchImpl = globalThis.fetch,
  platform = `${process.platform}-${process.arch}`,
  executeClient = executeReviewedClient,
  preparePackage = prepareReviewedPackage
}) {
  const [manifest, baselines] = await Promise.all([
    loadCompatibilityReleaseManifest(manifestPath),
    loadCompatibilityFixtures(fixtureDirectory)
  ]);
  const clients = manifest.clients.filter((client) => !clientId || client.id === clientId);
  if (!clients.length) throw new Error('Requested client is not in the release manifest');
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const results = [];
  for (const client of clients) {
    results.push(await checkClientRelease({
      client,
      registry: manifest.registry,
      baselines,
      cacheDirectory,
      offline,
      fetchImpl,
      platform,
      executeClient,
      preparePackage
    }));
  }
  results.sort((left, right) => left.id.localeCompare(right.id));
  const counts = {
    clients: results.length,
    passed: results.filter((result) => result.status === 'ok').length,
    review: results.filter((result) => result.status === 'review').length,
    failed: results.filter((result) => result.status === 'failed').length
  };
  return {
    schemaVersion: 1,
    status: counts.failed ? 'failed' : counts.review ? 'review' : 'ok',
    platform,
    offline,
    counts,
    results
  };
}

export function renderCompatibilityReleaseReport(report, { format = 'markdown' } = {}) {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  const lines = [
    '# Client Release Compatibility Report',
    '',
    `Status: ${report.status}`,
    `Platform: ${report.platform}`,
    `Mode: ${report.offline ? 'offline' : 'online'}`,
    `Clients: ${report.counts.clients}; passed: ${report.counts.passed}; review: ${report.counts.review}; failed: ${report.counts.failed}`
  ];
  for (const result of report.results) {
    lines.push(
      '',
      `## ${result.id}`,
      '',
      `Status: ${result.status}`,
      `Reviewed version: ${result.reviewedVersion}`,
      `Latest version: ${result.latestVersion || 'not checked'}`,
      `Release state: ${result.releaseState}`,
      `Provenance: ${result.provenance}`,
      `Execution: ${result.execution}`
    );
    if (result.compatibility) {
      lines.push(`Compatibility: ${result.compatibility.status}`);
      for (const classification of result.compatibility.classification) lines.push(`- ${classification}`);
      for (const suggestion of result.compatibility.suggestions) lines.push(`- ${suggestion.code}: ${suggestion.summary}`);
    }
    if (result.failure) lines.push(`Failure: ${result.failure}`);
  }
  return `${lines.join('\n')}\n`;
}

async function checkClientRelease({
  client,
  registry,
  baselines,
  cacheDirectory,
  offline,
  fetchImpl,
  platform,
  executeClient,
  preparePackage
}) {
  const result = {
    id: client.id,
    family: client.family,
    reviewedVersion: client.version,
    latestVersion: null,
    releaseState: offline ? 'not_checked' : 'current',
    provenance: 'not_checked',
    execution: 'not_run',
    status: 'failed'
  };
  const platformEntry = client.platforms[platform];
  if (!platformEntry) return { ...result, failure: 'unsupported_platform' };
  try {
    let packageMetadata = null;
    if (!offline) {
      const [latestMetadata, rootMetadata, selectedMetadata] = await Promise.all([
        fetchPackageMetadata(registry, client.package, 'latest', fetchImpl),
        fetchPackageMetadata(registry, client.package, client.version, fetchImpl),
        fetchPackageMetadata(registry, platformEntry.package, platformEntry.version, fetchImpl)
      ]);
      result.latestVersion = latestMetadata.version || null;
      result.releaseState = result.latestVersion === client.version ? 'current' : 'new_release';
      verifyPublishedVersion(rootMetadata, client.package, client.version, client.integrity);
      verifyPublishedVersion(selectedMetadata, platformEntry.package, platformEntry.version, platformEntry.integrity);
      packageMetadata = selectedMetadata;
      result.provenance = 'verified';
    }
    const executable = await preparePackage({
      registry,
      platformEntry,
      packageMetadata,
      cacheDirectory,
      offline,
      fetchImpl
    });
    if (offline) result.provenance = 'cache_verified';
    const execution = await executeClient({ client, executable, platform, baselines });
    result.execution = execution.state;
    if (execution.state !== 'captured') {
      result.failure = execution.failure || 'client_execution_failed';
      return result;
    }
    result.compatibility = publicIntake(execution.intake);
    result.status = result.releaseState === 'new_release' || execution.intake.status !== 'exact' ? 'review' : 'ok';
    return result;
  } catch (error) {
    return {
      ...result,
      provenance: result.provenance === 'not_checked' ? 'failed' : result.provenance,
      failure: safeFailure(error)
    };
  }
}

export async function fetchPackageMetadata(registry, packageName, version, fetchImpl = globalThis.fetch) {
  if (!TOKEN.test(version)) throw new Error('registry_version_invalid');
  const url = new URL(`${registry.replace(/\/$/, '')}/${packageName.replace('/', '%2f')}/${version}`);
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    redirect: 'error'
  });
  if (!response.ok) throw new Error('registry_metadata_failed');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_REGISTRY_BYTES) throw new Error('registry_metadata_too_large');
  const bytes = await readBoundedResponse(response, MAX_REGISTRY_BYTES, 'registry_metadata_too_large');
  const metadata = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (metadata?.name !== packageName || !TOKEN.test(metadata.version || '') || !metadata.dist || typeof metadata.dist !== 'object') {
    throw new Error('registry_metadata_invalid');
  }
  return metadata;
}

export function verifyPublishedVersion(metadata, packageName, version, integrity) {
  if (!metadata || metadata.name !== packageName || metadata.version !== version) throw new Error('reviewed_version_missing');
  if (metadata.dist?.integrity !== integrity) throw new Error('package_integrity_changed');
  const tarball = new URL(metadata.dist.tarball);
  if (tarball.protocol !== 'https:' || tarball.username || tarball.password) throw new Error('package_tarball_invalid');
  return metadata;
}

export async function prepareReviewedPackage({
  registry,
  platformEntry,
  packageMetadata,
  cacheDirectory,
  offline,
  fetchImpl = globalThis.fetch
}) {
  const cacheKey = createHash('sha256')
    .update(`${platformEntry.package}\0${platformEntry.version}\0${platformEntry.integrity}`)
    .digest('hex');
  const queueKey = `${resolve(cacheDirectory)}\0${cacheKey}`;
  const previous = packagePreparationQueues.get(queueKey) || Promise.resolve();
  const preparation = previous.catch(() => {}).then(() => prepareReviewedPackageOnce({
    registry,
    platformEntry,
    packageMetadata,
    cacheDirectory,
    cacheKey,
    offline,
    fetchImpl
  }));
  packagePreparationQueues.set(queueKey, preparation);
  const clearPreparation = () => {
    if (packagePreparationQueues.get(queueKey) === preparation) packagePreparationQueues.delete(queueKey);
  };
  preparation.then(clearPreparation, clearPreparation);
  return preparation;
}

async function prepareReviewedPackageOnce({
  registry,
  platformEntry,
  packageMetadata,
  cacheDirectory,
  cacheKey,
  offline,
  fetchImpl
}) {
  const directory = join(cacheDirectory, cacheKey);
  const archive = join(directory, 'package.tgz');
  const executable = join(directory, 'executable');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await verifyFileIntegrity(archive, platformEntry.integrity, MAX_PACKAGE_BYTES);
  } catch (error) {
    if (offline) throw new Error(error?.code === 'ENOENT' ? 'package_cache_missing' : 'package_cache_invalid');
    await rm(archive, { force: true });
    const published = verifyPublishedVersion(packageMetadata, platformEntry.package, platformEntry.version, platformEntry.integrity);
    const tarballUrl = new URL(published.dist.tarball);
    if (tarballUrl.host !== new URL(registry).host) throw new Error('package_tarball_host_invalid');
    const response = await fetchImpl(tarballUrl, { redirect: 'error' });
    if (!response.ok) throw new Error('package_download_failed');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_PACKAGE_BYTES) throw new Error('package_too_large');
    const temporaryArchive = `${archive}.tmp-${randomUUID()}`;
    try {
      await writeVerifiedResponse(response, temporaryArchive, platformEntry.integrity, MAX_PACKAGE_BYTES);
      await rename(temporaryArchive, archive);
    } finally {
      await rm(temporaryArchive, { force: true });
    }
  }
  await extractExecutable(archive, platformEntry.executable, executable);
  await chmod(executable, 0o700);
  return executable;
}

export async function executeReviewedClient({ client, executable, platform, baselines }) {
  const isolation = networkIsolation(platform);
  if (!isolation) return { state: 'not_run', failure: 'isolation_unavailable' };
  const runDirectory = await temporaryRunDirectory(client.id);
  const helperPath = fileURLToPath(new URL('./compatibility-release-client.js', import.meta.url));
  const configPath = join(runDirectory, 'config.json');
  const capturePath = join(runDirectory, 'capture.json');
  await writeFile(configPath, `${JSON.stringify({
    family: client.family,
    version: client.version,
    executable,
    capturePath,
    workingDirectory: runDirectory
  })}\n`, { mode: 0o600 });
  try {
    const command = isolation.command({ node: process.execPath, helperPath, configPath });
    const processResult = await boundedCommand(command.command, command.args, {
      cwd: runDirectory,
      env: {
        HOME: runDirectory,
        TMPDIR: runDirectory,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8'
      }
    });
    if (processResult.timedOut) return { state: 'not_run', failure: 'client_timeout' };
    if (processResult.outputLimitExceeded) return { state: 'not_run', failure: 'client_output_limit' };
    let parsed;
    try {
      parsed = JSON.parse(processResult.stdout.trim());
    } catch {
      return { state: 'not_run', failure: 'client_runner_failed' };
    }
    const failure = clientProcessFailure(parsed);
    if (failure) return { state: 'not_run', failure };
    const capture = await loadCompatibilityCapture(capturePath);
    return { state: 'captured', intake: analyzeCompatibilityCapture(capture, baselines) };
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
}

export function networkIsolation(platform = `${process.platform}-${process.arch}`) {
  if (platform.startsWith('darwin-')) {
    const profile = [
      '(version 1)',
      '(allow default)',
      '(deny network*)',
      '(allow network-inbound (local ip "localhost:*"))',
      '(allow network-outbound (remote ip "localhost:*"))'
    ].join(' ');
    return {
      name: 'sandbox-exec-loopback',
      command: ({ node, helperPath, configPath }) => ({
        command: '/usr/bin/sandbox-exec',
        args: ['-p', profile, node, helperPath, configPath]
      })
    };
  }
  return null;
}

export function clientProcessFailure(result) {
  if (!result?.captured) return 'capture_missing';
  if (result.timedOut) return 'client_timeout';
  if (result.outputLimitExceeded) return 'client_output_limit';
  if (result.signal || result.exitCode !== 0) return 'client_exit_failure';
  return null;
}

async function extractExecutable(archive, member, destination) {
  if (!ARCHIVE_MEMBER.test(member)) throw new Error('package_executable_invalid');
  const archiveMember = `package/${member}`;
  const listing = await boundedCommand('tar', ['-tvzf', archive, archiveMember], {
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024
  });
  const entries = listing.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (listing.exitCode !== 0 || listing.timedOut || listing.outputLimitExceeded
    || entries.length !== 1 || !entries[0].startsWith('-') || !entries[0].endsWith(` ${archiveMember}`)) {
    throw new Error('package_executable_invalid');
  }
  const temporaryDestination = `${destination}.tmp-${randomUUID()}`;
  try {
    await extractArchiveMember(archive, archiveMember, temporaryDestination, MAX_EXECUTABLE_BYTES);
    await rename(temporaryDestination, destination);
  } finally {
    await rm(temporaryDestination, { force: true });
  }
}

async function extractArchiveMember(archive, member, destination, maxBytes) {
  const file = await open(destination, 'wx', 0o600);
  const child = spawn('tar', ['-xOzf', archive, member], {
    stdio: ['ignore', 'pipe', 'ignore']
  });
  let timedOut = false;
  let extractionError = null;
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 30_000);
  let bytes = 0;
  try {
    for await (const chunk of child.stdout) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        extractionError = new Error('package_executable_too_large');
        child.kill('SIGKILL');
        break;
      }
      await writeAll(file, chunk);
    }
    const result = await closed;
    if (extractionError) throw extractionError;
    if (timedOut || result.exitCode !== 0 || result.signal) throw new Error('package_extraction_failed');
  } catch (error) {
    child.kill('SIGKILL');
    await closed.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    await file.close();
  }
}

function boundedCommand(command, args, {
  cwd,
  env = process.env,
  timeoutMs = EXECUTION_TIMEOUT_MS,
  maxOutputBytes = MAX_HELPER_OUTPUT_BYTES
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = { stdout: [], stderr: [] };
    let bytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    const stop = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    const consume = (name) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        outputLimitExceeded = true;
        stop();
        return;
      }
      output[name].push(chunk);
    };
    child.stdout.on('data', consume('stdout'));
    child.stderr.on('data', consume('stderr'));
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    child.once('error', (error) => finish(reject, error));
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.once('close', (exitCode, signal) => {
      finish(resolve, {
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signal || null,
        timedOut,
        outputLimitExceeded,
        stdout: Buffer.concat(output.stdout).toString('utf8'),
        stderr: Buffer.concat(output.stderr).toString('utf8')
      });
    });
  });
}

async function verifyFileIntegrity(path, integrity, maxBytes) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error(stat.size > maxBytes ? 'package_too_large' : 'package_cache_invalid');
  const hash = createHash('sha512');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('package_too_large');
    hash.update(chunk);
  }
  verifyDigest(hash, integrity);
}

async function writeVerifiedResponse(response, path, integrity, maxBytes) {
  if (!response.body) throw new Error('package_download_failed');
  const file = await open(path, 'wx', 0o600);
  const hash = createHash('sha512');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error('package_too_large');
      hash.update(chunk);
      await writeAll(file, chunk);
    }
  } finally {
    await file.close();
  }
  verifyDigest(hash, integrity);
}

async function writeAll(file, chunk) {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
    if (!bytesWritten) throw new Error('package_download_failed');
    offset += bytesWritten;
  }
}

function verifyDigest(hash, integrity) {
  const actual = `sha512-${hash.digest('base64')}`;
  if (actual !== integrity) throw new Error('package_integrity_mismatch');
}

async function readBoundedResponse(response, maxBytes, errorCode) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error(errorCode);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

async function temporaryRunDirectory(id) {
  const root = join(tmpdir(), 'codex-pooler-compatibility-releases');
  const directory = resolve(root, `run-${id}-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function publicIntake(intake) {
  return {
    status: intake.status,
    capture: intake.capture,
    baseline: intake.baseline,
    classification: intake.classification,
    changes: intake.changes.map(compactChange),
    suggestions: intake.suggestions,
    ...(intake.projectionError ? { projectionError: intake.projectionError } : {})
  };
}

function compactChange(change) {
  const output = {
    category: change.category,
    summary: change.summary
  };
  for (const key of ['added', 'removed']) {
    if (!change[key]?.length) continue;
    output[`${key}Count`] = change[key].length;
    output[key] = change[key].slice(0, MAX_CHANGE_SAMPLES);
  }
  return output;
}

function safeFailure(error) {
  const token = String(error?.message || 'release_check_failed').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  return TOKEN.test(token) ? token : 'release_check_failed';
}

function assertKnownKeys(value, keys, label) {
  for (const key of Object.keys(value)) if (!keys.has(key)) fail(`${label}.${key} is not allowed`);
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertToken(value, label) {
  if (typeof value !== 'string' || !TOKEN.test(value)) fail(`${label} is invalid`);
}

function assertIntegrity(value, label) {
  if (typeof value !== 'string' || !INTEGRITY.test(value)) fail(`${label} is invalid`);
}

function fail(message) {
  throw new Error(message);
}

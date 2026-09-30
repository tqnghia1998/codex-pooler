import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderCompatibilityReleaseReport,
  runCompatibilityReleaseGate
} from '../src/compatibility-release-gate.js';

const DEFAULT_MANIFEST = fileURLToPath(new URL('../fixtures/compatibility-releases.json', import.meta.url));
const DEFAULT_FIXTURES = fileURLToPath(new URL('../fixtures/compatibility/', import.meta.url));
const DEFAULT_CACHE = join(homedir(), '.cache', 'codex-pooler', 'compatibility-releases');

export async function checkClientReleases({
  manifestPath = DEFAULT_MANIFEST,
  fixtureDirectory = DEFAULT_FIXTURES,
  cacheDirectory = DEFAULT_CACHE,
  clientId = '',
  offline = false,
  format = 'markdown',
  ...options
} = {}) {
  const report = await runCompatibilityReleaseGate({
    manifestPath,
    fixtureDirectory,
    cacheDirectory,
    clientId,
    offline,
    ...options
  });
  return { report, output: renderCompatibilityReleaseReport(report, { format }) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { report, output } = await checkClientReleases(options);
  process.stdout.write(output);
  if (report.status === 'failed' || (options.failOnReview && report.status !== 'ok')) process.exitCode = 1;
}

function parseArgs(args) {
  const options = {};
  for (const argument of args) {
    if (argument === '--json') options.format = 'json';
    else if (argument === '--offline') options.offline = true;
    else if (argument === '--fail-on-review') options.failOnReview = true;
    else if (argument.startsWith('--client=')) options.clientId = argument.slice('--client='.length);
    else if (argument.startsWith('--manifest=')) options.manifestPath = argument.slice('--manifest='.length);
    else if (argument.startsWith('--fixtures=')) options.fixtureDirectory = argument.slice('--fixtures='.length);
    else if (argument.startsWith('--cache=')) options.cacheDirectory = argument.slice('--cache='.length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

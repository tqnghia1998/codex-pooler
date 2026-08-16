import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  analyzeCompatibilityCapture,
  loadCompatibilityCapture,
  renderCompatibilityIntakeReport
} from '../src/compatibility-intake.js';
import { loadCompatibilityFixtures } from '../src/compatibility-fixtures.js';

const DEFAULT_FIXTURE_DIRECTORY = fileURLToPath(new URL('../fixtures/compatibility/', import.meta.url));

export async function intakeCompatibilityCapture({
  capturePath,
  outputPath = '',
  fixtureDirectory = DEFAULT_FIXTURE_DIRECTORY,
  format = 'markdown'
}) {
  if (!capturePath) throw new Error('--capture=<path> is required');
  const [capture, baselines] = await Promise.all([
    loadCompatibilityCapture(capturePath),
    loadCompatibilityFixtures(fixtureDirectory)
  ]);
  const result = analyzeCompatibilityCapture(capture, baselines);
  if (outputPath) await writeFile(outputPath, `${JSON.stringify(result.draft, null, 2)}\n`, { flag: 'wx' });
  return { result, output: renderCompatibilityIntakeReport(result, { format }) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { result, output } = await intakeCompatibilityCapture(options);
  process.stdout.write(output);
  if (options.failOnReview && result.status !== 'exact') process.exitCode = 1;
}

function parseArgs(args) {
  const values = {};
  for (const argument of args) {
    if (argument === '--json') values.format = 'json';
    else if (argument === '--fail-on-review') values.failOnReview = true;
    else if (argument.startsWith('--capture=')) values.capturePath = argument.slice('--capture='.length);
    else if (argument.startsWith('--output=')) values.outputPath = argument.slice('--output='.length);
    else if (argument.startsWith('--fixtures=')) values.fixtureDirectory = argument.slice('--fixtures='.length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return values;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

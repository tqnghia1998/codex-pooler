import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  compatibilityFixtureReport,
  loadCompatibilityFixtures,
  renderCompatibilityFixtureReport,
  withUpdatedCompatibilityExpectation
} from '../src/compatibility-fixtures.js';

const DEFAULT_DIRECTORY = fileURLToPath(new URL('../fixtures/compatibility/', import.meta.url));

export async function checkCompatibilityFixtures({
  directory = DEFAULT_DIRECTORY,
  update = false,
  format = 'markdown'
} = {}) {
  const entries = await loadCompatibilityFixtures(directory, { ignoreExpected: update });
  if (update) {
    for (const entry of entries) {
      const updated = withUpdatedCompatibilityExpectation(entry.fixture);
      await writeFile(entry.path, `${JSON.stringify(updated, null, 2)}\n`);
      entry.fixture = updated;
    }
  }
  const report = compatibilityFixtureReport(entries);
  return { report, output: renderCompatibilityFixtureReport(report, { format }) };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter((argument) => !['--update', '--json'].includes(argument));
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const { report, output } = await checkCompatibilityFixtures({
    update: args.has('--update'),
    format: args.has('--json') ? 'json' : 'markdown'
  });
  process.stdout.write(output);
  if (report.status !== 'ok') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

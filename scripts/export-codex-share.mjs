#!/usr/bin/env node

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, extname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const nodeRoot = join(workspaceRoot, 'node');
const productRoot = join(nodeRoot, 'pool');
const sharedRoot = join(nodeRoot, 'src');
const defaultTarget = '/Users/quangnghia.trinh/Documents/Git/codex-share';
const blockingTerms = /relaydeck|codex-pooler|icoretech/i;
const generatedPaths = [
  '.env.example',
  '.gitignore',
  'LICENSE.md',
  'README.md',
  'package-lock.json',
  'package.json',
  'public',
  'shared',
  'src',
  'test',
  'ui',
  'vite.config.js'
];

async function main() {
  const clean = exportOptions();
  const targetRoot = defaultTarget;
  await assertGitRepository(targetRoot);
  assertCleanWorktree(targetRoot);

  if (clean) {
    await cleanTarget(targetRoot);
  } else {
    await removeGeneratedPaths(targetRoot);
  }

  const sharedFiles = await sharedDependencyClosure();
  await Promise.all([
    copyProductSource(targetRoot),
    copyProductTests(targetRoot),
    copyUi(targetRoot),
    copySharedSource(targetRoot, sharedFiles),
    writeProjectFiles(targetRoot)
  ]);

  const matches = await findBlockingTerms(targetRoot);
  if (matches.length) {
    throw new Error(`Export still contains forbidden source references:\n${matches.join('\n')}`);
  }

  console.log(`Exported Codex Share to ${targetRoot}`);
  console.log(`Copied ${sharedFiles.size} shared gateway modules and the standalone product source.`);
}

function exportOptions() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) usage(0);
  if (args.some((argument) => argument !== '--clean')) usage(1);
  return args.includes('--clean');
}

function usage(code) {
  console.log(`Usage: node scripts/export-codex-share.mjs [--clean]

Exports to ${defaultTarget}. The target must be an existing, clean Git repository.
--clean removes all target files except .git before exporting; use it only for the
initial conversion of a placeholder repository.`);
  process.exit(code);
}

async function assertGitRepository(targetRoot) {
  try {
    const gitDir = execFileSync('git', ['-C', targetRoot, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).trim();
    if (!gitDir) throw new Error('empty Git directory');
  } catch {
    throw new Error(`Target is not a Git repository: ${targetRoot}`);
  }
}

function assertCleanWorktree(targetRoot) {
  const status = execFileSync('git', ['-C', targetRoot, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (status) {
    throw new Error(`Target has uncommitted changes. Commit, stash, or discard them before exporting:\n${status}`);
  }
}

async function cleanTarget(targetRoot) {
  for (const entry of await readdir(targetRoot)) {
    if (entry !== '.git') await rm(join(targetRoot, entry), { recursive: true, force: true });
  }
}

async function removeGeneratedPaths(targetRoot) {
  for (const entry of generatedPaths) {
    await rm(join(targetRoot, entry), { recursive: true, force: true });
  }
}

async function sharedDependencyClosure() {
  const files = new Set();
  const pending = [];
  for (const sourceFile of await filesIn(join(productRoot, 'src'))) {
    pending.push(...await sharedImports(sourceFile));
  }

  while (pending.length) {
    const sourceFile = pending.pop();
    if (files.has(sourceFile)) continue;
    files.add(sourceFile);
    pending.push(...await sharedImports(sourceFile));
  }
  return files;
}

async function sharedImports(sourceFile) {
  const source = await readFile(sourceFile, 'utf8');
  const imports = [];
  const expression = /\b(?:from|import)\s*['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(expression)) {
    const candidate = resolve(dirname(sourceFile), match[1]);
    if (candidate === sharedRoot || candidate.startsWith(`${sharedRoot}/`)) imports.push(candidate);
  }
  return imports;
}

async function copyProductSource(targetRoot) {
  for (const sourceFile of await filesIn(join(productRoot, 'src'))) {
    const destination = join(targetRoot, 'src', relative(join(productRoot, 'src'), sourceFile));
    let source = await readFile(sourceFile, 'utf8');
    source = source.replaceAll('../../src/', '../shared/');
    if (sourceFile.endsWith('/server.js')) source = standaloneServerSource(source);
    await writeText(destination, source);
  }
}

function standaloneServerSource(source) {
  return source
    .replace("const relaydeckDataDir = resolve(productRoot, '../.data');\n", '')
    .replace('const poolDataDir = requirePoolDataDir(dataDir);', 'const poolDataDir = resolve(dataDir);')
    .replace('  requirePoolDataDir(dataDir);\n', '')
    .replace(/\nfunction requirePoolDataDir\(dataDir\) \{\n  const resolved = resolve\(dataDir\);\n  if \(resolved === relaydeckDataDir\) \{\n    throw new Error\('POOL_DATA_DIR must not point to Relaydeck node\/\.data'\);\n  \}\n  return resolved;\n\}\n/, '\n');
}

async function copyProductTests(targetRoot) {
  for (const sourceFile of await filesIn(join(productRoot, 'test'))) {
    if (sourceFile.endsWith('/isolation.test.js')) continue;
    const destination = join(targetRoot, 'test', relative(join(productRoot, 'test'), sourceFile));
    let source = await readFile(sourceFile, 'utf8');
    source = source
      .replaceAll('../../src/', '../shared/')
      .replaceAll('Relaydeck compatibility routes', 'gateway compatibility routes');
    await writeText(destination, source);
  }
}

async function copyUi(targetRoot) {
  await cp(join(productRoot, 'ui'), join(targetRoot, 'ui'), {
    recursive: true,
    filter: (source) => !source.endsWith('.DS_Store')
  });
}

async function copySharedSource(targetRoot, sharedFiles) {
  for (const sourceFile of sharedFiles) {
    const destination = join(targetRoot, 'shared', relative(sharedRoot, sourceFile));
    let source = await readFile(sourceFile, 'utf8');
    source = source
      .replaceAll('relaydeckAdmission', 'gatewayAdmission')
      .replaceAll('relaydeckSettleAfterBody', 'gatewaySettleAfterBody')
      .replace(/export const OPENAI_PRICING_SOURCE_URL = "[^"]+";/, "export const OPENAI_PRICING_SOURCE_URL = 'local snapshot';");
    await writeText(destination, source);
  }
}

async function writeProjectFiles(targetRoot) {
  const sourcePackage = JSON.parse(await readFile(join(nodeRoot, 'package.json'), 'utf8'));
  const packageJson = {
    ...sourcePackage,
    name: 'codex-share',
    description: 'Share delegated Codex quota or AISwitch project budget without sharing provider credentials.',
    private: true,
    scripts: {
      build: 'vite build',
      start: 'npm run build && node --env-file=.env src/server.js',
      dev: 'npm run build && node --env-file=.env --watch src/server.js',
      test: 'node --test test/*.test.js'
    }
  };
  await writeText(join(targetRoot, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);

  const packageLock = JSON.parse(await readFile(join(nodeRoot, 'package-lock.json'), 'utf8'));
  packageLock.name = 'codex-share';
  packageLock.packages[''].name = 'codex-share';
  await writeText(join(targetRoot, 'package-lock.json'), `${JSON.stringify(packageLock, null, 2)}\n`);

  const viteConfig = (await readFile(join(productRoot, 'vite.config.js'), 'utf8'))
    .replace("root: 'pool/ui'", "root: 'ui'");
  await writeText(join(targetRoot, 'vite.config.js'), viteConfig);

  await writeText(join(targetRoot, '.gitignore'), 'node_modules/\npublic/\n.data/\n.env\n.DS_Store\n');
  await writeText(join(targetRoot, '.env.example'), standaloneEnvironment(await readFile(join(productRoot, '.env.example'), 'utf8')));
  await writeText(join(targetRoot, 'README.md'), standaloneReadme(await readFile(join(productRoot, 'README.md'), 'utf8')));
  await cp(join(workspaceRoot, 'LICENSE.md'), join(targetRoot, 'LICENSE.md'));
}

function standaloneEnvironment(source) {
  return source
    .replace('# Defaults to node/pool/.data when omitted.\n', '# Defaults to .data when omitted.\n')
    .replace("# It must not point to Relaydeck's node/.data.\n", '');
}

function standaloneReadme(source) {
  return source
    .replace('It has its own server, UI,\ncookies, environment, and runtime data. It reuses the Node gateway\'s provider\nadapters and proxy compatibility code, but it does not run inside Relaydeck and\nnever opens Relaydeck\'s `node/.data`.', 'It includes its own server, UI, cookies, environment, runtime data, provider adapters, and proxy compatibility code.')
    .replace('cd node\n', '')
    .replaceAll('npm run pool:start', 'npm start')
    .replaceAll('npm run pool:dev', 'npm run dev')
    .replaceAll('pool/.env', '.env')
    .replaceAll('pool/.data', '.data')
    .replaceAll('pool/src/', 'src/')
    .replaceAll('pool/ui/', 'ui/')
    .replaceAll('pool/public/', 'public/')
    .replace('`npm start` runs the server in Node watch mode; `npm run dev` is\nan alias.', '`npm start` starts the server. Use `npm run dev` for Node watch mode.')
    .replace("use the `POOL_*` prefix; Relaydeck's `CODEX_POOLER_*` variables are not product\nconfiguration.", 'use the `POOL_*` prefix.')
    .replace('Relaydeck uses `node/.data`, port `3000`, and its own operator authentication.\nStarting either product does not start, configure, migrate, or mutate the\nother. `POOL_DATA_DIR` must not point to `node/.data`; Codex Share startup\nrejects that configuration.\n\n', '')
    .replace('Personal-key model lists are the union of active-session catalogs. Ordinary\nRelaydeck API keys are rejected.', 'Personal-key model lists are the union of active-session catalogs. Only Codex Share API keys are accepted.')
    .replace('Codex Share dispatches the same Codex Responses, Chat Completions, streaming,\ntool-call, compaction, model-catalog, public file/audio/image, and native\nWebSocket implementations as Relaydeck. A share key limits candidate accounts\nand accounting; it does not create a second protocol adapter.', 'Codex Share supports Codex Responses, Chat Completions, streaming, tool calls,\ncompaction, model catalogs, public file/audio/image, and native WebSockets. A\nshare key limits candidate accounts and accounting; it does not create a second\nprotocol adapter.')
    .replace('Client-facing gateway route classification and dispatch live in\n`../src/gateway-dispatch.js`, shared with Relaydeck. Future proxy or\ncompatibility functionality must be added to that shared layer so it reaches\nboth products automatically; Codex Share-specific code is limited to share-key\nauthorization, session selection, and settlement.', 'Client-facing gateway route classification and dispatch live in\n`shared/gateway-dispatch.js`. Codex Share-specific code is limited to share-key\nauthorization, session selection, and settlement.');
}

async function findBlockingTerms(targetRoot) {
  const matches = [];
  for (const file of await filesIn(targetRoot)) {
    if (file.includes('/.git/')) continue;
    if (!['.js', '.jsx', '.json', '.md', '.example', '.svg'].includes(extname(file))) continue;
    const source = await readFile(file, 'utf8');
    if (blockingTerms.test(source)) matches.push(relative(targetRoot, file));
  }
  return matches;
}

async function filesIn(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function writeText(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

main().catch((error) => {
  console.error(`Codex Share export failed: ${error.message}`);
  process.exitCode = 1;
});

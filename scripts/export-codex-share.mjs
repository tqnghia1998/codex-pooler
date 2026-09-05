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
const standaloneOverlayFiles = [
  '.env.example',
  '.gitignore',
  'README.md',
  'package.json',
  'package-lock.json',
  'shared/master-key.js',
  'shared/redis-document-persistence.js',
  'src/kms-master-key.js',
  'src/server.js',
  'test/persistence-http.test.js',
  'test/kms-master-key.test.js'
];
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
  const { clean, targetRoot } = exportOptions();
  await assertGitRepository(targetRoot);
  assertCleanWorktree(targetRoot);
  const overlay = await readStandaloneOverlay(targetRoot);

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
    writeProjectFiles(targetRoot, overlay)
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
  let targetRoot = defaultTarget;
  let clean = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--clean') {
      clean = true;
    } else if (argument === '--target' && args[index + 1]) {
      targetRoot = resolve(args[++index]);
    } else {
      usage(1);
    }
  }
  return { clean, targetRoot };
}

function usage(code) {
  console.log(`Usage: node scripts/export-codex-share.mjs [--clean] [--target <directory>]

Exports to ${defaultTarget}. The target must be an existing, clean Git repository.
--clean removes all target files except .git before exporting; use it only for the
initial conversion of a repository that already contains the standalone overlay.
--target is useful for exporting to a local checkout or a verification copy.`);
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

async function readStandaloneOverlay(targetRoot) {
  const overlay = new Map();
  const missing = [];
  for (const relativePath of standaloneOverlayFiles) {
    try {
      overlay.set(relativePath, await readFile(join(targetRoot, relativePath)));
    } catch (error) {
      if (error.code === 'ENOENT') missing.push(relativePath);
      else throw error;
    }
  }
  if (missing.length) {
    throw new Error(`Standalone overlay is incomplete. Add these files before exporting:\n${missing.join('\n')}`);
  }
  return overlay;
}

async function cleanTarget(targetRoot) {
  await removeGeneratedPaths(targetRoot);
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
    if (standaloneOverlayFiles.includes(relative(targetRoot, destination))) continue;
    let source = await readFile(sourceFile, 'utf8');
    source = source.replaceAll('../../src/', '../shared/');
    await writeText(destination, source);
  }
}

async function copyProductTests(targetRoot) {
  for (const sourceFile of await filesIn(join(productRoot, 'test'))) {
    if (sourceFile.endsWith('/isolation.test.js')) continue;
    const destination = join(targetRoot, 'test', relative(join(productRoot, 'test'), sourceFile));
    if (standaloneOverlayFiles.includes(relative(targetRoot, destination))) continue;
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
    if (standaloneOverlayFiles.includes(relative(targetRoot, destination))) continue;
    let source = await readFile(sourceFile, 'utf8');
    source = source
      .replaceAll('relaydeckAdmission', 'gatewayAdmission')
      .replaceAll('relaydeckSettleAfterBody', 'gatewaySettleAfterBody')
      .replaceAll('codex-pooler-claude', 'codex-share-claude')
      .replaceAll('codex-pooler:claude-account-id', 'codex-share:claude-account-id')
      .replaceAll("'codex-pooler'", "'codex-share'")
      .replaceAll('codex-pooler-node/0.1.0', 'codex-share/0.1.0')
      .replace(/export const OPENAI_PRICING_SOURCE_URL = "[^"]+";/, "export const OPENAI_PRICING_SOURCE_URL = 'local snapshot';");
    await writeText(destination, source);
  }
}

async function writeProjectFiles(targetRoot, overlay) {
  const sourcePackage = JSON.parse(await readFile(join(nodeRoot, 'package.json'), 'utf8'));
  const standalonePackage = JSON.parse(overlay.get('package.json').toString('utf8'));
  const packageJson = {
    ...sourcePackage,
    ...standalonePackage,
    dependencies: mergePackageEntries(standalonePackage.dependencies, sourcePackage.dependencies),
    devDependencies: mergePackageEntries(standalonePackage.devDependencies, sourcePackage.devDependencies),
    name: 'codex-share',
    description: 'Share delegated Codex quota or AIS project budget without sharing provider credentials.',
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
  const standaloneLock = JSON.parse(overlay.get('package-lock.json').toString('utf8'));
  const rootPackage = {
    ...packageLock.packages[''],
    ...standaloneLock.packages[''],
    dependencies: mergePackageEntries(standaloneLock.packages[''].dependencies, packageLock.packages[''].dependencies),
    devDependencies: mergePackageEntries(standaloneLock.packages[''].devDependencies, packageLock.packages[''].devDependencies)
  };
  const lockDependencies = mergePackageEntries(standaloneLock.dependencies, packageLock.dependencies);
  Object.assign(packageLock, standaloneLock, {
    name: 'codex-share',
    packages: { ...standaloneLock.packages, ...packageLock.packages, '': { ...rootPackage, name: 'codex-share' } },
    ...(Object.keys(lockDependencies).length ? { dependencies: lockDependencies } : {})
  });
  await writeText(join(targetRoot, 'package-lock.json'), `${JSON.stringify(packageLock, null, 2)}\n`);

  const viteConfig = (await readFile(join(productRoot, 'vite.config.js'), 'utf8'))
    .replace("root: 'pool/ui'", "root: 'ui'");
  await writeText(join(targetRoot, 'vite.config.js'), viteConfig);

  await writeFile(join(targetRoot, '.gitignore'), overlay.get('.gitignore'));
  await writeFile(join(targetRoot, '.env.example'), overlay.get('.env.example'));
  await writeFile(join(targetRoot, 'README.md'), overlay.get('README.md'));
  const adminEventCursor = await productAdminEventCursor();
  for (const relativePath of standaloneOverlayFiles) {
    if (['.env.example', '.gitignore', 'README.md', 'package.json', 'package-lock.json'].includes(relativePath)) continue;
    const destination = join(targetRoot, relativePath);
    const source = relativePath === 'src/server.js'
      ? standaloneServerSource(overlay.get(relativePath).toString('utf8'), adminEventCursor)
      : overlay.get(relativePath);
    await writeFile(destination, source);
  }
  await cp(join(workspaceRoot, 'LICENSE.md'), join(targetRoot, 'LICENSE.md'));
}

async function productAdminEventCursor() {
  const source = await readFile(join(productRoot, 'src/server.js'), 'utf8');
  const start = source.indexOf('function adminEventCursor(url) {');
  const end = source.indexOf('\nfunction sharingListQuery(url) {', start);
  if (start < 0 || end < 0) throw new Error('Could not read admin event cursor from the product server');
  return source.slice(start, end);
}

function standaloneServerSource(source, adminEventCursor) {
  // Add missing imports
  if (!source.includes('isSupportedClaudeOAuthUpstream')) {
    source = source.replace(
      "import { exportUpstreamCredentials } from '../shared/domain.js';",
      "import { exportUpstreamCredentials, claudeOAuthInputError, isSupportedClaudeOAuthUpstream } from '../shared/domain.js';\nimport { ensureClaudeCredentialIdentity } from '../shared/claude-protocol.js';"
    );
  }

  // Update POST /auth/session if missing
  if (!source.includes("url.pathname === '/auth/session'")) {
    const logoutAnchor = "  if (req.method === 'POST' && url.pathname === '/auth/logout') {";
    const authSessionBlock = `  if (req.method === 'POST' && url.pathname === '/auth/session') {
    const input = await body(req);
    let sessionData = input?.session;
    if (typeof sessionData === 'string') {
      try {
        sessionData = JSON.parse(sessionData);
      } catch {
        sessionData = { sub: sessionData };
      }
    }
    if (!sessionData || typeof sessionData !== 'object') {
      throw new HttpError(400, 'invalid_request', 'session data is required');
    }
    const userObj = (sessionData.user && typeof sessionData.user === 'object') ? sessionData.user : {};
    const email = String(
      sessionData.email ||
      sessionData.login_email ||
      userObj.email ||
      userObj.login_email ||
      sessionData.mail ||
      ''
    ).trim();
    const username = String(
      userObj.username ||
      (typeof sessionData.username === 'string' ? sessionData.username : '') ||
      (typeof sessionData.user === 'string' ? sessionData.user : '') ||
      email.split('@')[0] ||
      ''
    ).trim();
    const name = String(
      userObj.full_name ||
      userObj.family_name ||
      userObj.given_name ||
      sessionData.displayName ||
      (typeof sessionData.name === 'string' ? sessionData.name : '') ||
      username ||
      email ||
      'Smart User'
    ).trim();
    const sub = String(
      sessionData.identity_uuid ||
      userObj.sub ||
      sessionData.sub ||
      sessionData.id ||
      sessionData.userId ||
      username ||
      email
    ).trim();
    if (!sub) throw new HttpError(400, 'invalid_request', 'session identifier is required');
    const finalEmail = email || (username ? \`\${username}@shopee.com\` : '');
    const account = productStore.upsertSmartAccount({ username, email: finalEmail, name, sub });
    const session = productStore.createAccountSession(account.id);
    setCookies(res, [
      cookie(COOKIE_NAMES.login, '', { httpOnly: true, secure: cookieSecure, maxAge: 0 }),
      cookie(COOKIE_NAMES.session, session.token, { httpOnly: true, secure: cookieSecure, maxAge: ACCOUNT_COOKIE_MAX_AGE_SECONDS }),
      cookie(COOKIE_NAMES.csrf, session.csrfToken, { secure: cookieSecure, maxAge: ACCOUNT_COOKIE_MAX_AGE_SECONDS })
    ]);
    sendJson(res, 200, { account, csrfToken: session.csrfToken });
    return;
  }
`;
    source = source.replace(logoutAnchor, `${authSessionBlock}${logoutAnchor}`);
  }

  // Update Claude upstream linking and updating
  if (!source.includes("resource === 'upstreams' && id === 'claude'")) {
    const aisPostAnchor = "  if (req.method === 'POST' && resource === 'upstreams' && id === 'aiswitch' && parts.length === 4) {";
    const claudePostBlock = `  if (req.method === 'POST' && resource === 'upstreams' && id === 'claude' && parts.length === 4) {
    const input = await body(req);
    const rawToken = String(input.token || input.accessToken || input.authJson || '').trim();
    let authJson = '';
    if (rawToken.startsWith('{')) {
      authJson = rawToken;
    } else {
      authJson = JSON.stringify({
        claudeAiOauth: {
          accessToken: rawToken,
          refreshToken: '',
          expiresAt: 0
        }
      });
    }

    const policyError = claudeOAuthInputError({ authJson });
    if (policyError) throw new HttpError(400, 'invalid_request', policyError);

    const upstream = store.create({
      type: 'claude',
      authJson
    });

    try {
      try {
        const credentials = store.credentials(upstream.id);
        if (isSupportedClaudeOAuthUpstream({ ...upstream, credentials })) {
          await ensureClaudeCredentialIdentity({ upstream, credentials, store, fetchImpl, refreshProfile: true });
        }
      } catch (error) {
        if (error?.statusCode === 401 || error?.statusCode === 403) {
          throw new HttpError(400, 'invalid_token', 'Failed to authenticate Claude token with Anthropic');
        }
        console.warn(\`[pool] Advisory Claude identity lookup failed on link for \${upstream.id}:\`, error?.message || error);
      }

      productStore.linkUpstream(accountId, upstream.id);
      const provider = productStore.providerSummary(accountId, upstream.id, store);
      sendJson(res, 201, {
        upstream: {
          ...upstream,
          providerIssue: providerIssue(upstream),
          sharing: provider.sharing,
          commitment: provider.commitment
        }
      });
    } catch (error) {
      productStore.cleanupUpstream(upstream.id);
      store.remove(upstream.id);
      throw error;
    }
    return;
  }
  if (req.method === 'POST' && resource === 'upstreams' && (id === 'ais' || id === 'aiswitch') && parts.length === 4) {
    const input = await body(req);
    const upstream = store.create({
      type: 'compass',
      quotaSource: 'ais',
      projectId: input.projectId,
      projectKey: input.projectKey
    });
    try {
      productStore.linkUpstream(accountId, upstream.id);
      const provider = productStore.providerSummary(accountId, upstream.id, store);
      sendJson(res, 201, {
        upstream: {
          ...upstream,
          providerIssue: providerIssue(upstream),
          sharing: provider.sharing,
          commitment: provider.commitment
        }
      });
    } catch (error) {
      productStore.cleanupUpstream(upstream.id);
      store.remove(upstream.id);
      throw error;
    }
    return;
  }
`;
    // Also replace the old PATCH and refresh-quota to support Claude
    const patchStart = source.indexOf("  if (req.method === 'PATCH' && resource === 'upstreams' && id && parts.length === 4) {");
    const patchEnd = source.indexOf("  if (req.method === 'POST' && resource === 'personal-keys' && id && action === 'reveal') {", patchStart);
    if (patchStart >= 0 && patchEnd >= 0) {
      const newPatchBlock = `  if (req.method === 'PATCH' && resource === 'upstreams' && id && parts.length === 4) {
    const input = await body(req);
    const upstream = store.get(id);
    if (!upstream || !productStore.accountOwnsUpstream(accountId, id)) {
      throw new HttpError(404, 'not_found', 'Not found');
    }
    const isAis = upstream.quotaSource === 'ais' || upstream.quotaSource === 'aiswitch';
    const isClaude = upstream.type === 'claude';
    if (!isAis && !isClaude) {
      throw new HttpError(400, 'invalid_request', 'Only AIS or Claude upstreams can be updated');
    }

    let updateFields = {};
    if (isAis) {
      updateFields = {
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.projectKey !== undefined ? { projectKey: input.projectKey } : {})
      };
    } else if (isClaude) {
      const rawToken = String(input.token || input.accessToken || input.authJson || '').trim();
      if (rawToken) {
        let authJson = '';
        if (rawToken.startsWith('{')) {
          authJson = rawToken;
        } else {
          authJson = JSON.stringify({
            claudeAiOauth: {
              accessToken: rawToken,
              refreshToken: '',
              expiresAt: 0
            }
          });
        }
        const policyError = claudeOAuthInputError({ authJson });
        if (policyError) throw new HttpError(400, 'invalid_request', policyError);
        updateFields = { authJson };
      }
    }

    const updated = store.update(id, updateFields);
    if (isClaude && updateFields.authJson) {
      try {
        const credentials = store.credentials(id);
        if (isSupportedClaudeOAuthUpstream({ ...updated, credentials })) {
          await ensureClaudeCredentialIdentity({ upstream: updated, credentials, store, fetchImpl, refreshProfile: true });
        }
      } catch (error) {
        if (error?.statusCode === 401 || error?.statusCode === 403) {
          throw new HttpError(400, 'invalid_token', 'Failed to authenticate Claude token with Anthropic');
        }
        console.warn(\`[pool] Advisory Claude identity lookup failed on update for \${id}:\`, error?.message || error);
      }
    }
    const provider = productStore.providerSummary(accountId, id, store);
    sendJson(res, 200, {
      upstream: {
        ...updated,
        providerIssue: providerIssue(updated),
        sharing: provider.sharing,
        commitment: provider.commitment
      }
    });
    return;
  }
`;
      source = source.slice(0, patchStart) + newPatchBlock + source.slice(patchEnd);
    }

    // Replace the aiswitch POST handler with claudePostBlock
    const aisPostIndex = source.indexOf(aisPostAnchor);
    const aisPostEnd = source.indexOf("  if (req.method === 'PATCH' && resource === 'upstreams' && id && parts.length === 4) {", aisPostIndex);
    if (aisPostIndex >= 0 && aisPostEnd >= 0) {
      source = source.slice(0, aisPostIndex) + claudePostBlock + source.slice(aisPostEnd);
    }
  }

  // Quota refresh Claude support
  if (source.includes("if (upstream.type !== 'codex') throw new HttpError(400, 'invalid_request', 'Only Codex accounts can refresh quota');")) {
    source = source.replace(
      "if (upstream.quotaSource === 'aiswitch') {\n      sendJson(res, 200, { upstream: store.getPublic(id), skipped: 'manual_share_budget' });\n      return;\n    }\n    if (upstream.type !== 'codex') throw new HttpError(400, 'invalid_request', 'Only Codex accounts can refresh quota');",
      "if (upstream.quotaSource === 'ais' || upstream.quotaSource === 'aiswitch') {\n      sendJson(res, 200, { upstream: store.getPublic(id), skipped: 'quota_unknown' });\n      return;\n    }\n    if (upstream.type !== 'codex' && upstream.type !== 'claude') throw new HttpError(400, 'invalid_request', 'Only Codex and Claude accounts can refresh quota');"
    );
  }

  // Remove manual-budget route from standalone server
  const manualBudgetRoute = "  if (req.method === 'PUT' && resource === 'upstreams' && id && action === 'manual-budget') {\n    sendJson(res, 200, { provider: productStore.setManualShareBudget(accountId, id, await body(req), store) });\n    return;\n  }\n";
  if (source.includes(manualBudgetRoute)) {
    source = source.replace(manualBudgetRoute, '');
  }

  // Upstreams listing manualShareBudgetMicros removal
  if (source.includes('.flatMap(({ upstreamId, manualShareBudgetMicros }) => {')) {
    source = source.replace(
      ".flatMap(({ upstreamId, manualShareBudgetMicros }) => {\n        const upstream = store.getPublic(upstreamId);\n        if (!upstream) return [];\n        const provider = productStore.providerSummary(accountId, upstreamId, store, { manualShareBudgetMicros });",
      ".flatMap(({ upstreamId }) => {\n        const upstream = store.getPublic(upstreamId);\n        if (!upstream) return [];\n        const provider = productStore.providerSummary(accountId, upstreamId, store);"
    );
  }

  const helper = 'function adminEventCursor(url) {';
  const anchor = '\nfunction sharingListQuery(url) {';
  const start = source.indexOf(helper);
  const end = start < 0 ? -1 : source.indexOf(anchor, start);
  if (start >= 0 && end < 0) throw new Error('Could not replace admin event cursor in the standalone server');
  if (start >= 0) source = `${source.slice(0, start)}${adminEventCursor}${source.slice(end)}`;
  else if (source.includes(anchor)) source = source.replace(anchor, `\n${adminEventCursor}${anchor}`);
  else throw new Error('Could not add admin event cursor to the standalone server');

  const legacyCall = 'productStore.adminAnalytics()';
  const cursorCall = 'productStore.adminAnalytics({ eventCursor: adminEventCursor(url) })';
  if (source.includes(legacyCall)) return source.replace(legacyCall, cursorCall);
  if (source.includes(cursorCall)) return source;
  throw new Error('Could not add event cursor to standalone admin analytics');
}

function mergePackageEntries(standalone, source) {
  return { ...(standalone || {}), ...(source || {}) };
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

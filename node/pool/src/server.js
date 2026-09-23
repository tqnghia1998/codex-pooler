import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/store.js';
import {
  deriveClaudeAccountId,
  parseClaudeAuthJson,
  claudeOAuthInputError,
  isSupportedClaudeOAuthUpstream,
  text
} from '../../src/domain.js';
import { claudeConfigFromEnv, normalizeClaudeConfig } from '../../src/claude-config.js';
import { ensureClaudeCredentialIdentity } from '../../src/claude-protocol.js';
import { createTokenRefreshScheduler, TOKEN_REFRESH_INTERVAL_MS } from '../../src/codex-token-refresh.js';
import { refreshAllUpstreamQuotas, refreshUpstreamQuota } from '../../src/upstream-quota-refresh.js';
import { shareSessionDenial } from '../../src/share-authorization.js';
import { HttpError, readJsonObjectBody } from '../../src/http-ingress.js';
import { dispatchGatewayRequest, gatewayRequestKind } from '../../src/gateway-dispatch.js';
import { errorEnvelope, openaiError } from '../../src/public-errors.js';
import { exportAllData, importAllData } from '../../src/data-portability.js';
import { firewallAllowed, hostAllowed, originAllowed } from '../../src/admission.js';
import { CodexHostHealth, codexHostHealthForStore, codexHostHealthOptionsFromEnv } from '../../src/codex-host-health.js';
import { modelCatalogForStore } from '../../src/codex-model-catalog.js';
import {
  attachWebSocketProxy,
  authenticateProxyRequest,
  testUpstreamConnection
} from '../../src/proxy.js';
import { codexGatewayOptions } from '../../src/codex-compatibility.js';
import { ProductStore } from './product-store.js';
import { CodexAuthImporter } from './codex-import.js';
import { createEmailScheduler, EMAIL_DELIVERY_INTERVAL_MS } from './email.js';
import { createSnapshotBackup, SNAPSHOT_BACKUP_INTERVAL_MS, snapshotBackupPath } from './backup.js';
import { providerIssue } from './provider-availability.js';
import {
  ADVISORY_QUOTA_REFRESH_INTERVAL_MS,
  advisoryProvider,
  advisoryQuotaClientFromEnv,
  refreshAccountAdvisoryQuotas,
  refreshAllAdvisoryQuotas
} from './advisory-quota.js';

const productRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const publicDir = join(productRoot, 'public');
const relaydeckDataDir = resolve(productRoot, '../.data');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};
const COOKIE_NAMES = {
  session: 'codex_pool_session',
  csrf: 'codex_pool_csrf'
};
export const QUOTA_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
export const PRODUCT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const ACCOUNT_COOKIE_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;
const ADMIN_EMAIL = 'quangnghia.trinh@shopee.com';
const SPACE_TOKEN_VALIDATE_URL = 'https://space.shopee.io/apis/space_auth/v1/token_validate';

export function createApp({
  store = new Store(resolve(productRoot, '.data')),
  productStore = new ProductStore(resolve(productRoot, '.data')),
  codexAuthImporter = new CodexAuthImporter({ sharingStore: productStore, upstreamStore: store }),
  fetchImpl = globalThis.fetch,
  ingress = poolIngress(),
  cookieSecure = envBoolean(process.env.POOL_COOKIE_SECURE, false),
  upstreamDeadlines = {},
  logger = console,
  codexHostHealth = codexHostHealthForStore(store),
  onCodexCredentialsImported = () => {},
  publicBasePath = process.env.POOL_PUBLIC_BASE_PATH,
  codexOptions = poolCodexGatewayOptions(ingress),
  claudeConfig = poolClaudeConfigFromEnv(),
  advisoryQuotaClient = advisoryQuotaClientFromEnv(process.env, { fetchImpl }),
  backupStatus = () => ({ enabled: false, lastBackupAt: null })
} = {}) {
  claudeConfig = normalizeClaudeConfig(claudeConfig);
  store.configureClaudeRuntime?.(claudeConfig);
  store.clearAisSpendingCaps();
  const modelCatalog = modelCatalogForStore(store);
  const basePath = normalizePublicBasePath(publicBasePath);
  const spaceSessionValidations = new Map();
  return async function app(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!hostAllowed(req.headers.host, ingress)) {
        sendJson(res, 403, { error: { type: 'permission_error', code: 'invalid_host', message: 'Invalid Host header' } });
        return;
      }
      if (isMutation(req.method) && !originAllowed(req.headers.origin, req.headers.host, ingress)) {
        sendJson(res, 403, { error: { type: 'permission_error', code: 'invalid_origin', message: 'Invalid Origin header' } });
        return;
      }
      if (url.pathname === '/healthz') {
        sendJson(res, 200, { status: 'ok', product: 'codex-share' });
        return;
      }
      if (url.pathname === '/readyz') {
        sendJson(res, 200, { status: 'ready', product: 'codex-share' });
        return;
      }
      if (url.pathname.startsWith('/auth/')) {
        await authRequest(req, res, url, {
          store,
          productStore,
          codexAuthImporter,
          cookieSecure,
          fetchImpl,
          spaceSessionValidations,
          onCodexCredentialsImported,
          logger
        });
        return;
      }
      if (url.pathname.startsWith('/api/pool/')) {
        await productApi(req, res, url, { store, productStore, fetchImpl, claudeConfig, advisoryQuotaClient, logger, backupStatus });
        return;
      }
      if (url.pathname === '/admin') {
        requireAdmin(accountSession(req, productStore, false).account);
        await staticFile(req, res, '/', ingress, basePath);
        return;
      }

      const gatewayKind = gatewayRequestKind(req.method, url.pathname);
      if (gatewayKind) {
        if (!firewallAllowed(req, ingress)) {
          sendJson(res, 403, { error: { type: 'permission_error', code: 'access_denied', message: 'Client IP is not allowed' } });
          return;
        }
        const auth = authenticateProxyRequest(req, store, null, {
          allowXApiKey: req.method === 'POST' && url.pathname === '/v1/messages',
          sharingStore: productStore,
          shareKeysOnly: true
        });
        if (!auth) {
          sendJson(res, 401, { error: { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid QuotaHub key' } }, { 'www-authenticate': 'Bearer' });
          return;
        }
        req.proxyAuth = auth;
        req.sharingStore = productStore;
        req.upstreamStore = store;
        const denial = shareSessionDenial(req.proxyAuth);
        if (denial) {
          sendJson(res, 403, { error: { type: 'permission_error', ...denial } });
          return;
        }
      }
      if (gatewayKind) {
        req.disablePacing = true;
        req.ignoreQuotaCooldown = true;
        req.allowUnknownQuota = true;
        await dispatchGatewayRequest({
          kind: gatewayKind,
          req,
          res,
          url,
          store,
          apiKey: null,
          fetchImpl,
          ingress,
          upstreamDeadlines,
          logger,
          codexHostHealth,
          modelCatalog,
          claudeConfig,
          codexOptions,
          sendJson,
          handleUsage: () => {
            if (url.searchParams.size) throw new HttpError(400, 'invalid_request', 'Usage query parameters are not supported');
            sendJson(res, 200, req.proxyAuth.kind === 'personal_share'
              ? productStore.personalKeyUsage(req.proxyAuth.accountId, store)
              : productStore.shareSessionUsage(req.proxyAuth.shareSessionId));
          }
        });
        return;
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/') || url.pathname.startsWith('/backend-api/')) {
        sendJson(res, 404, { error: { type: 'invalid_request_error', code: 'unsupported_endpoint', message: 'Unsupported QuotaHub endpoint' } });
        return;
      }
      await staticFile(req, res, url.pathname, ingress, basePath);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error.plainBadRequest) {
        res.writeHead(error.statusCode, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      const failure = poolErrorEnvelope(error);
      sendJson(res, failure.status, failure.body, failure.headers);
    }
  };
}

export function start(port = Number(process.env.POOL_PORT) || 3010, {
  dataDir = process.env.POOL_DATA_DIR || resolve(productRoot, '.data'),
  store = null,
  productStore = null,
  fetchImpl = globalThis.fetch,
  host = process.env.POOL_BIND_HOST || '127.0.0.1',
  ingress = poolIngress(),
  cookieSecure = envBoolean(process.env.POOL_COOKIE_SECURE, false),
  quotaRefreshIntervalMs = Number(process.env.POOL_QUOTA_REFRESH_INTERVAL_MS) || QUOTA_REFRESH_INTERVAL_MS,
  tokenRefreshIntervalMs = Number(process.env.POOL_TOKEN_REFRESH_INTERVAL_MS) || TOKEN_REFRESH_INTERVAL_MS,
  emailDeliveryIntervalMs = Number(process.env.POOL_EMAIL_DELIVERY_INTERVAL_MS) || EMAIL_DELIVERY_INTERVAL_MS,
  productCleanupIntervalMs = Number(process.env.POOL_PRODUCT_CLEANUP_INTERVAL_MS) || PRODUCT_CLEANUP_INTERVAL_MS,
  backupIntervalMs = Number(process.env.POOL_BACKUP_INTERVAL_MS) || SNAPSHOT_BACKUP_INTERVAL_MS,
  advisoryQuotaRefreshIntervalMs = Number(process.env.POOL_AI_QUOTA_REFRESH_INTERVAL_MS) || ADVISORY_QUOTA_REFRESH_INTERVAL_MS,
  advisoryQuotaClient = advisoryQuotaClientFromEnv(process.env, { fetchImpl }),
  claudeConfig = poolClaudeConfigFromEnv()
} = {}) {
  const poolDataDir = requirePoolDataDir(dataDir);
  store ||= new Store(poolDataDir);
  productStore ||= new ProductStore(poolDataDir);
  const codexAuthImporter = new CodexAuthImporter({ sharingStore: productStore, upstreamStore: store });
  const codexHostHealth = new CodexHostHealth(codexHostHealthOptionsFromEnv(process.env, 'POOL_CODEX_HOST_'));
  const codexOptions = poolCodexGatewayOptions(ingress);
  const tokenScheduler = createTokenRefreshScheduler(store, { fetchImpl });
  const emailScheduler = createEmailScheduler(productStore, { intervalMs: emailDeliveryIntervalMs });
  const snapshotBackup = createSnapshotBackup({
    store,
    productStore,
    filePath: snapshotBackupPath(poolDataDir),
    intervalMs: backupIntervalMs
  });
  store.setTokenRefreshFailureHandler?.(tokenScheduler.schedule);
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return [];
    refreshing = true;
    try {
      const results = await refreshAllQuotas(store, { fetchImpl });
      productStore.expireDue();
      productStore.observeProviders(store);
      await emailScheduler.run();
      return results;
    } finally {
      refreshing = false;
    }
  };
  const refreshAdvisory = () => refreshAllAdvisoryQuotas(store, productStore, {
    client: advisoryQuotaClient,
    logger: console
  });
  const refreshImportedUpstream = async (upstreamId) => {
    try {
      const upstream = store.get(upstreamId);
      const provider = advisoryProvider(upstream);
      if (provider) {
        if (!advisoryQuotaClient?.enabled) return;
        const accountId = productStore.accountIdForUpstream(upstreamId);
        const email = accountId ? productStore.account(accountId)?.email || '' : '';
        if (!email) return;
        await refreshAccountAdvisoryQuotas({
          store,
          email,
          client: advisoryQuotaClient,
          targets: [{ upstreamId, provider }]
        });
        return;
      }
      await refreshUpstreamQuota(store, upstreamId, { fetchImpl });
    } finally {
      productStore.observeProviders(store);
    }
  };
  const server = createHttpServer(createApp({
    store,
    productStore,
    codexAuthImporter,
    fetchImpl,
    ingress,
    cookieSecure,
    codexHostHealth,
    codexOptions,
    claudeConfig,
    advisoryQuotaClient,
    onCodexCredentialsImported: refreshImportedUpstream,
    backupStatus: () => snapshotBackup.status()
  }));
  const websocketServer = attachWebSocketProxy(server, {
    store,
    sharingStore: productStore,
    shareKeysOnly: true,
    disablePacing: true,
    ignoreQuotaCooldown: true,
    apiKey: null,
    fetchImpl,
    ingress,
    codexHostHealth,
    codexOptions
  });
  productStore.cleanup();
  snapshotBackup.run();
  void refresh();
  const scheduleAdvisoryRefresh = () => {
    void refreshAdvisory().catch((error) => {
      console.warn(`QuotaHub delayed quota refresh failed: ${error?.message || error}`);
    });
  };
  scheduleAdvisoryRefresh();
  const timer = setInterval(refresh, quotaRefreshIntervalMs);
  timer.unref?.();
  const advisoryTimer = setInterval(scheduleAdvisoryRefresh, advisoryQuotaRefreshIntervalMs);
  advisoryTimer.unref?.();
  const cleanupTimer = setInterval(() => productStore.cleanup(), productCleanupIntervalMs);
  cleanupTimer.unref?.();
  void tokenScheduler.run();
  void emailScheduler.run();
  const tokenTimer = setInterval(tokenScheduler.run, tokenRefreshIntervalMs);
  tokenTimer.unref?.();
  server.once('close', () => {
    clearInterval(timer);
    clearInterval(advisoryTimer);
    clearInterval(cleanupTimer);
    clearInterval(tokenTimer);
    store.setTokenRefreshFailureHandler?.(null);
    tokenScheduler.close();
    emailScheduler.close();
    snapshotBackup.close();
    websocketServer.close();
  });
  server.listen(port, host, () => {
    console.log(`codex-share listening on http://${host}:${server.address().port}`);
  });
  return server;
}

export async function startConfigured() {
  return start();
}

function requirePoolDataDir(dataDir) {
  const resolved = resolve(dataDir);
  if (resolved === relaydeckDataDir) {
    throw new Error('POOL_DATA_DIR must not point to Relaydeck node/.data');
  }
  return resolved;
}

export async function refreshAllQuotas(store, { fetchImpl = globalThis.fetch } = {}) {
  return refreshAllUpstreamQuotas(store, {
    fetchImpl,
    shouldRefresh: (upstream) => upstream.type === 'codex'
  });
}

async function authRequest(req, res, url, {
  store,
  productStore,
  codexAuthImporter,
  cookieSecure,
  fetchImpl,
  spaceSessionValidations,
  onCodexCredentialsImported,
  logger
}) {
  if (req.method === 'POST' && url.pathname === '/auth/codex/import') {
    const input = await body(req);
    if (typeof input.authJson !== 'string' || !input.authJson.trim()) {
      throw new HttpError(400, 'invalid_request', 'authJson is required');
    }
    let account;
    let upstream;
    try {
      ({ account, upstream } = codexAuthImporter.importAuthJson(input.authJson));
    } catch (error) {
      if (error?.statusCode) throw error;
      throw new HttpError(400, 'invalid_request', String(error.message || 'Codex auth JSON could not be imported').slice(0, 300));
    }
    const session = productStore.createAccountSession(account.id, { source: 'import' });
    await refreshImportedCredentials(onCodexCredentialsImported, upstream.id, logger);
    setCookies(res, [
      cookie(COOKIE_NAMES.session, session.token, { httpOnly: true, secure: cookieSecure, maxAge: ACCOUNT_COOKIE_MAX_AGE_SECONDS }),
      cookie(COOKIE_NAMES.csrf, session.csrfToken, { secure: cookieSecure, maxAge: ACCOUNT_COOKIE_MAX_AGE_SECONDS })
    ]);
    sendJson(res, 200, { account });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/auth/session') {
    const input = await body(req);
    const currentSessionToken = requestCookies(req)[COOKIE_NAMES.session];
    const currentAuth = productStore.authenticateAccountSession(currentSessionToken);
    if (currentAuth && currentAuth.authSource !== 'space') {
      sendJson(res, 200, { account: currentAuth.account });
      return;
    }
    try {
      const result = await coalesceSpaceSessionValidation(
        spaceSessionValidations,
        currentSessionToken,
        input?.session,
        async () => {
          const account = productStore.upsertAccount(await validateSpaceSession(input?.session, fetchImpl));
          if (currentAuth?.account.id === account.id) return { account, session: null };
          if (currentAuth?.authSource === 'space') productStore.revokeAccountSession(currentSessionToken);
          return { account, session: productStore.createAccountSession(account.id, { source: 'space' }) };
        }
      );
      if (result.session) {
        setCookies(res, [
          cookie(COOKIE_NAMES.session, result.session.token, { httpOnly: true, secure: cookieSecure, maxAge: ACCOUNT_COOKIE_MAX_AGE_SECONDS }),
          cookie(COOKIE_NAMES.csrf, result.session.csrfToken, { secure: cookieSecure, maxAge: ACCOUNT_COOKIE_MAX_AGE_SECONDS })
        ]);
      }
      sendJson(res, 200, {
        account: result.account,
        ...(result.session ? { csrfToken: result.session.csrfToken } : {})
      });
    } catch (error) {
      if (error?.statusCode === 401 && currentAuth?.authSource === 'space') {
        clearAccountCookies(req, res, productStore, cookieSecure);
      }
      throw error;
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    const auth = accountSession(req, productStore, true);
    productStore.revokeAccountSession(requestCookies(req)[COOKIE_NAMES.session]);
    setCookies(res, [
      cookie(COOKIE_NAMES.session, '', { httpOnly: true, secure: cookieSecure, maxAge: 0 }),
      cookie(COOKIE_NAMES.csrf, '', { secure: cookieSecure, maxAge: 0 })
    ]);
    if (!auth.account) throw new HttpError(401, 'authentication_error', 'Account session is unavailable');
    sendJson(res, 204, null);
    return;
  }
  throw new HttpError(404, 'not_found', 'Not found');
}

async function refreshImportedCredentials(refresh, upstreamId, logger) {
  try {
    await refresh(upstreamId);
  } catch (error) {
    logger?.warn?.(`QuotaHub quota refresh failed for upstream ${upstreamId}: ${error?.code || error?.name || 'Error'}`);
  }
}

async function productRequest(req, res, url, { store, productStore, fetchImpl, claudeConfig = null, advisoryQuotaClient = null, logger = console, backupStatus = () => ({ enabled: false, lastBackupAt: null }) }) {
  const auth = accountSession(req, productStore, isMutation(req.method));
  const accountId = auth.account.id;
  const parts = url.pathname.split('/').filter(Boolean);
  const resource = parts[2];
  const id = parts[3];
  const action = parts[4];

  if (req.method === 'GET' && resource === 'me' && parts.length === 3) {
    sendJson(res, 200, { account: auth.account });
    return;
  }
  if (req.method === 'GET' && resource === 'personal-key' && parts.length === 3) {
    sendJson(res, 200, { personalKey: productStore.personalKey(accountId, store) });
    return;
  }
  if (req.method === 'POST' && resource === 'personal-key' && id === 'reveal' && parts.length === 4) {
    sendJson(res, 200, productStore.revealPersonalKey(accountId));
    return;
  }
  if (req.method === 'POST' && resource === 'personal-key' && id === 'rotate' && parts.length === 4) {
    sendJson(res, 200, productStore.rotatePersonalKey(accountId));
    return;
  }
  if (req.method === 'GET' && resource === 'personal-keys' && parts.length === 3) {
    sendJson(res, 200, { personalKeys: productStore.listPersonalKeys(accountId, store) });
    return;
  }
  if (req.method === 'POST' && resource === 'personal-keys' && parts.length === 3) {
    sendJson(res, 201, productStore.createNamedPersonalKey(accountId, await body(req), store));
    return;
  }
  if (req.method === 'POST' && resource === 'upstreams' && id === 'claude' && parts.length === 4) {
    const input = await body(req);
    const rawToken = String(input.token || input.accessToken || input.authJson || '').trim();
    if (!rawToken) throw new HttpError(400, 'invalid_request', 'Claude setup token is required');

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

    const policyError = claudeOAuthInputError({ authJson }, { creating: true });
    if (policyError) throw new HttpError(400, 'invalid_request', policyError);
    let parsedAuth;
    try {
      parsedAuth = parseClaudeAuthJson(authJson);
    } catch (error) {
      throw new HttpError(400, 'invalid_request', String(error?.message || 'Invalid Claude OAuth token'));
    }
    const existing = productStore.findOwnedUpstreamByIdentity(accountId, store, {
      type: 'claude',
      accountId: parsedAuth.accountId || (parsedAuth.projectKey ? '' : deriveClaudeAccountId(parsedAuth)),
      email: parsedAuth.email || auth.account.email,
      accessToken: parsedAuth.accessToken,
      projectKey: parsedAuth.projectKey
    });
    productStore.requireProviderSlot(accountId, store, 'claude', existing?.id);
    const created = !existing;
    const upstream = existing
      ? store.update(existing.id, { authJson })
      : store.create({
        type: 'claude',
        authJson,
        name: input.name || parsedAuth.account?.displayName || parsedAuth.account?.emailAddress || 'Claude OAuth'
      }, { allowDuplicateIdentity: true });
    try {
      // Setup tokens cannot read Claude's profile endpoint. QuotaHub's signed-in
      // account is the authoritative owner identity for the linked provider.
      store.persistClaudeIdentity(upstream.id, { email: auth.account.email });
      const credentials = store.credentials(upstream.id);
      if (isSupportedClaudeOAuthUpstream({ ...upstream, credentials })) {
        try {
          await ensureClaudeCredentialIdentity({ upstream, credentials, store, fetchImpl, refreshProfile: true });
        } catch (error) {
          if (error?.statusCode === 401 || error?.statusCode === 403) {
            throw new HttpError(400, 'invalid_token', 'Failed to authenticate Claude token with Anthropic');
          }
          // Profile lookup is advisory; log warning for transient upstream connectivity issues
          logger?.warn?.(`[pool] Advisory Claude identity lookup failed for ${upstream.id}: ${error?.message || error}`);
        }
      }
      productStore.linkUpstream(accountId, upstream.id, 'default', store);
      const provider = productStore.providerSummary(accountId, upstream.id, store);
      const latest = store.get(upstream.id) || upstream;
      sendJson(res, 201, {
        upstream: {
          ...latest,
          providerIssue: providerIssue(latest),
          sharing: provider.sharing,
          commitment: provider.commitment
        }
      });
    } catch (error) {
      if (created) {
        productStore.cleanupUpstream(upstream.id);
        store.remove(upstream.id);
      }
      throw error;
    }
    return;
  }
  if (req.method === 'POST' && resource === 'upstreams' && (id === 'ais' || id === 'aiswitch') && parts.length === 4) {
    const input = await body(req);
    if (!text(input.projectId)) throw new HttpError(400, 'invalid_request', 'projectId is required');
    const existing = productStore.findOwnedUpstreamByIdentity(accountId, store, {
      type: 'compass',
      quotaSource: 'ais',
      projectId: input.projectId
    });
    if (!existing && !text(input.projectKey)) {
      throw new HttpError(400, 'invalid_request', 'projectKey is required');
    }
    productStore.requireProviderSlot(accountId, store, 'ais', existing?.id);
    const created = !existing;
    const upstream = existing
      ? store.update(existing.id, {
        projectId: input.projectId,
        ...(input.projectKey !== undefined ? { projectKey: input.projectKey } : {})
      })
      : store.create({
        type: 'compass',
        quotaSource: 'ais',
        email: auth.account.email,
        projectId: input.projectId,
        projectKey: input.projectKey
      }, { allowDuplicateIdentity: true });
    try {
      productStore.linkUpstream(accountId, upstream.id, 'default', store);
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
      if (created) {
        productStore.cleanupUpstream(upstream.id);
        store.remove(upstream.id);
      }
      throw error;
    }
    return;
  }
  if (req.method === 'PATCH' && resource === 'upstreams' && id && parts.length === 4) {
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
        store.persistClaudeIdentity(id, { email: auth.account.email });
        const credentials = store.credentials(id);
        if (isSupportedClaudeOAuthUpstream({ ...updated, credentials })) {
          await ensureClaudeCredentialIdentity({ upstream: updated, credentials, store, fetchImpl, refreshProfile: true });
        }
      } catch (error) {
        if (error?.statusCode === 401 || error?.statusCode === 403) {
          throw new HttpError(400, 'invalid_token', 'Failed to authenticate Claude token with Anthropic');
        }
        logger?.warn?.(`[pool] Advisory Claude identity lookup failed on update for ${id}: ${error?.message || error}`);
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
  if (req.method === 'DELETE' && resource === 'upstreams' && id && parts.length === 4) {
    const upstream = store.get(id);
    if (!upstream || !productStore.accountOwnsUpstream(accountId, id)) {
      throw new HttpError(404, 'not_found', 'Not found');
    }
    productStore.cleanupUpstream(id, { actorAccountId: accountId });
    store.remove(id);
    sendJson(res, 204, null);
    return;
  }
  if (req.method === 'POST' && resource === 'personal-keys' && id && action === 'reveal') {
    sendJson(res, 200, productStore.revealNamedPersonalKey(accountId, id));
    return;
  }
  if (req.method === 'POST' && resource === 'personal-keys' && id && action === 'rotate') {
    sendJson(res, 200, productStore.rotateNamedPersonalKey(accountId, id));
    return;
  }
  if (req.method === 'POST' && resource === 'personal-keys' && id && action === 'revoke') {
    sendJson(res, 200, { personalKey: productStore.revokeNamedPersonalKey(accountId, id, store) });
    return;
  }
  if (req.method === 'GET' && resource === 'upstreams' && parts.length === 3) {
    const upstreams = productStore.listCanonicalAccountUpstreamLinks(accountId, store)
      .flatMap(({ upstreamId }) => {
        const upstream = store.getPublic(upstreamId);
        if (!upstream) return [];
        const provider = productStore.providerSummary(accountId, upstreamId, store);
        const ownerEmail = upstream.email || ((upstream.type === 'claude' || upstream.quotaSource === 'ais') ? auth.account.email : '');
        return [{
          ...upstream,
          ...(ownerEmail ? { email: ownerEmail } : {}),
          name: ownerEmail || upstream.name,
          providerIssue: providerIssue(upstream),
          sharing: provider.sharing,
          commitment: provider.commitment
        }];
      });
    sendJson(res, 200, { upstreams });
    return;
  }
  if (req.method === 'GET' && resource === 'sharing-counts' && parts.length === 3) {
    sendJson(res, 200, { counts: productStore.sharingCounts(accountId) });
    return;
  }
  if (req.method === 'GET' && resource === 'community-activity' && parts.length === 3) {
    sendJson(res, 200, productStore.communityActivity(accountId, store));
    return;
  }
  if (req.method === 'GET' && resource === 'leaderboard' && parts.length === 3) {
    sendJson(res, 200, { leaderboard: productStore.communityLeaderboard() });
    return;
  }
  if (req.method === 'GET' && resource === 'admin' && id === 'analytics' && parts.length === 4) {
    requireAdmin(auth.account);
    const analytics = productStore.adminAnalytics({ eventCursor: adminEventCursor(url) });
    analytics.backup = backupStatus();
    sendJson(res, 200, { analytics });
    return;
  }
  if (req.method === 'GET' && resource === 'admin' && id === 'export' && parts.length === 4) {
    requireAdmin(auth.account);
    sendJson(res, 200, exportAllData({ store, productStore }), {
      'content-disposition': `attachment; filename="quotahub-export-${new Date().toISOString().slice(0, 10)}.json"`
    });
    return;
  }
  if (req.method === 'POST' && resource === 'admin' && id === 'import' && parts.length === 4) {
    requireAdmin(auth.account);
    const data = await importBody(req);
    let imported;
    try {
      imported = importAllData({ store, productStore, data });
    } catch (error) {
      throw new HttpError(400, 'invalid_request', `Import failed: ${error.message}`);
    }
    sendJson(res, 200, { imported });
    return;
  }
  if (req.method === 'POST' && resource === 'upstreams' && id && action === 'refresh-quota') {
    const upstream = store.get(id);
    if (!upstream || !productStore.accountOwnsUpstream(accountId, id)) {
      throw new HttpError(404, 'not_found', 'Not found');
    }
    const provider = advisoryProvider(upstream);
    if (provider) {
      if (!advisoryQuotaClient?.enabled) {
        sendJson(res, 200, { upstream: store.getPublic(id), skipped: 'advisory_quota_unconfigured' });
        return;
      }
      await refreshAccountAdvisoryQuotas({
        store,
        email: auth.account.email,
        client: advisoryQuotaClient,
        targets: [{ upstreamId: id, provider }]
      });
      sendJson(res, 200, { upstream: store.getPublic(id), advisory: true });
      return;
    }
    if (upstream.type !== 'codex') throw new HttpError(400, 'invalid_request', 'Only Codex accounts can refresh quota');
    sendJson(res, 200, { upstream: await refreshUpstreamQuota(store, id, { fetchImpl }) });
    return;
  }
  if (req.method === 'POST' && resource === 'upstreams' && id && action === 'test-connection') {
    if (!productStore.accountOwnsUpstream(accountId, id)) {
      throw new HttpError(404, 'not_found', 'Not found');
    }
    req.disablePacing = true;
    sendJson(res, 200, {
      connection: await testUpstreamConnection({
        store,
        upstreamId: id,
        req,
        res,
        fetchImpl,
        claudeConfig
      })
    });
    return;
  }
  if (req.method === 'GET' && resource === 'providers' && id && parts.length === 4) {
    sendJson(res, 200, { provider: productStore.providerSummary(accountId, id, store) });
    return;
  }
  if (req.method === 'POST' && resource === 'providers' && id && action === 'pause') {
    sendJson(res, 200, { provider: productStore.setProviderSharing(accountId, id, 'paused', store) });
    return;
  }
  if (req.method === 'POST' && resource === 'providers' && id && action === 'resume') {
    sendJson(res, 200, { provider: productStore.setProviderSharing(accountId, id, 'active', store) });
    return;
  }
  if (req.method === 'POST' && resource === 'providers' && id && action === 'revoke-all') {
    sendJson(res, 200, { provider: productStore.revokeProviderSharing(accountId, id, store) });
    return;
  }
  if (req.method === 'GET' && resource === 'offers' && parts.length === 3) {
    sendJson(res, 200, productStore.listOffersPage(accountId, store, sharingListQuery(url)));
    return;
  }
  if (req.method === 'POST' && resource === 'offers' && parts.length === 3) {
    sendJson(res, 201, { offer: productStore.createOffer(accountId, await body(req), store) });
    return;
  }
  if (req.method === 'PATCH' && resource === 'offers' && id && parts.length === 4) {
    sendJson(res, 200, { offer: productStore.updateOffer(accountId, id, await body(req), store) });
    return;
  }
  if (req.method === 'GET' && resource === 'tickets' && parts.length === 3) {
    sendJson(res, 200, productStore.listTicketsPage(accountId, store, sharingListQuery(url)));
    return;
  }
  if (req.method === 'POST' && resource === 'tickets' && parts.length === 3) {
    sendJson(res, 201, { ticket: productStore.createTicket(accountId, await body(req), store) });
    return;
  }
  if (req.method === 'POST' && resource === 'tickets' && action === 'cancel') {
    sendJson(res, 200, { ticket: productStore.cancelTicket(accountId, id, store) });
    return;
  }
  if (req.method === 'POST' && resource === 'tickets' && action === 'reject') {
    sendJson(res, 200, { ticket: productStore.rejectTicket(accountId, id, store) });
    return;
  }
  if (req.method === 'POST' && resource === 'tickets' && action === 'approve') {
    sendJson(res, 200, { session: productStore.approveTicket(accountId, id, await body(req), store) });
    return;
  }
  if (req.method === 'GET' && resource === 'sessions' && parts.length === 3) {
    sendJson(res, 200, productStore.listSessionsPage(accountId, store, sharingListQuery(url)));
    return;
  }
  if (req.method === 'PATCH' && resource === 'sessions' && id && parts.length === 4) {
    sendJson(res, 200, { session: productStore.updateSession(accountId, id, await body(req), store) });
    return;
  }
  if (req.method === 'POST' && resource === 'sessions' && action === 'revoke') {
    sendJson(res, 200, { session: productStore.revokeSession(accountId, id, store) });
    return;
  }
  if (req.method === 'POST' && resource === 'sessions' && action === 'reveal-key') {
    sendJson(res, 200, productStore.revealSessionKey(accountId, id));
    return;
  }
  if (req.method === 'POST' && resource === 'sessions' && action === 'rotate-key') {
    sendJson(res, 200, productStore.rotateSessionKey(accountId, id));
    return;
  }
  if (req.method === 'POST' && resource === 'sessions' && action === 'test-connection') {
    const session = productStore.session(id, accountId, store);
    if (session.role !== 'consumer') throw new HttpError(404, 'not_found', 'Not found');
    const proxyAuth = productStore.shareSessionAccess(id);
    const denial = shareSessionDenial(proxyAuth);
    if (denial) throw new HttpError(409, denial.code, denial.message);
    if (session.providerIssue) {
      throw new HttpError(409, session.providerIssue.code, session.providerIssue.message);
    }
    req.disablePacing = true;
    sendJson(res, 200, {
      connection: await testUpstreamConnection({
        store,
        upstreamId: proxyAuth.upstreamId,
        req,
        res,
        fetchImpl,
        proxyAuth,
        sharingStore: productStore,
        allowUnavailableCandidate: false,
        claudeConfig
      })
    });
    return;
  }
  if (req.method === 'GET' && resource === 'quota-requests' && parts.length === 3) {
    sendJson(res, 200, productStore.listQuotaRequestsPage(accountId, sharingListQuery(url)));
    return;
  }
  if (req.method === 'POST' && resource === 'quota-requests' && parts.length === 3) {
    sendJson(res, 201, { quotaRequest: productStore.createQuotaRequest(accountId, await body(req)) });
    return;
  }
  if (req.method === 'POST' && resource === 'quota-requests' && id && action === 'grant') {
    sendJson(res, 200, productStore.grantQuotaRequest(accountId, id, await body(req), store));
    return;
  }
  if (req.method === 'POST' && resource === 'quota-requests' && id && action === 'cancel') {
    sendJson(res, 200, { quotaRequest: productStore.cancelQuotaRequest(accountId, id) });
    return;
  }
  throw new HttpError(404, 'not_found', 'Not found');
}

async function productApi(req, res, url, context) {
  try {
    return await productRequest(req, res, url, context);
  } catch (error) {
    if (error instanceof HttpError || error?.statusCode) throw error;
    throw new HttpError(400, 'invalid_request', String(error.message || 'Invalid request').slice(0, 300));
  }
}

function accountSession(req, productStore, requireCsrf) {
  const cookies = requestCookies(req);
  const csrf = typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : null;
  const auth = productStore.authenticateAccountSession(cookies[COOKIE_NAMES.session], csrf);
  if (!auth) throw new HttpError(401, 'authentication_error', 'Account session is unavailable');
  if (requireCsrf && (!csrf || cookies[COOKIE_NAMES.csrf] !== csrf || !auth.csrfValid)) {
    throw new HttpError(403, 'permission_error', 'CSRF validation failed');
  }
  return auth;
}

async function validateSpaceSession(rawSession, fetchImpl) {
  const token = spaceSessionToken(rawSession);
  if (!token) throw new HttpError(401, 'space_session_invalid', 'SPACE session is invalid or expired');
  let response;
  try {
    response = await fetchImpl(SPACE_TOKEN_VALIDATE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        referer: 'https://space.shopee.io/',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ requires_2fa: true }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new HttpError(503, 'space_session_unavailable', 'Unable to validate SPACE session');
  }
  const validated = await response.json().catch(() => null);
  if (!response.ok || !validated || typeof validated !== 'object') {
    throw new HttpError(401, 'space_session_invalid', 'SPACE session is invalid or expired');
  }
  const user = validated.user && typeof validated.user === 'object' ? validated.user : {};
  const email = String(validated.login_email || user.email || '').trim().toLowerCase();
  const username = String(user.username || email.split('@')[0] || '').trim();
  const name = String(user.full_name || user.family_name || user.given_name || user.name || username || email).trim();
  const subject = String(validated.identity_uuid || user.sub || '').trim();
  if (!email || !subject) throw new HttpError(401, 'space_session_invalid', 'SPACE session is invalid or expired');
  return { email, name: name || 'SPACE User' };
}

function coalesceSpaceSessionValidation(validations, currentSessionToken, rawSession, operation) {
  const submittedToken = spaceSessionToken(rawSession);
  if (!submittedToken) return operation();
  const key = createHash('sha256')
    .update(`${currentSessionToken || ''}\0${submittedToken}`)
    .digest('hex');
  const existing = validations.get(key);
  if (existing) return existing;
  const pending = Promise.resolve()
    .then(operation)
    .finally(() => validations.delete(key));
  validations.set(key, pending);
  return pending;
}

function spaceSessionToken(value) {
  const submitted = parseSpaceSession(value);
  return typeof submitted?.token === 'string' ? submitted.token.trim() : '';
}

function parseSpaceSession(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function clearAccountCookies(req, res, productStore, cookieSecure) {
  const sessionToken = requestCookies(req)[COOKIE_NAMES.session];
  if (sessionToken) productStore.revokeAccountSession(sessionToken);
  setCookies(res, [
    cookie(COOKIE_NAMES.session, '', { httpOnly: true, secure: cookieSecure, maxAge: 0 }),
    cookie(COOKIE_NAMES.csrf, '', { secure: cookieSecure, maxAge: 0 })
  ]);
}

function requireAdmin(account) {
  if (String(account.email || '').toLowerCase() !== ADMIN_EMAIL) {
    throw new HttpError(403, 'permission_error', 'Administrator access is required');
  }
}

async function jsonBody(req, ingress) {
  return readJsonObjectBody(req, ingress, { message: 'Request body must be a JSON object' });
}

async function importBody(req) {
  return jsonBody(req, {
    maxCompressedBodyBytes: 32 * 1024 * 1024,
    maxDecompressedBodyBytes: 32 * 1024 * 1024
  });
}

async function body(req) {
  return jsonBody(req, {
    maxCompressedBodyBytes: 2 * 1024 * 1024,
    maxDecompressedBodyBytes: 2 * 1024 * 1024
  });
}

async function staticFile(req, res, pathname, ingress, publicBasePath) {
  const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'styles.css', 'assets/codex-share.svg'].includes(filename)) {
    if (!firewallAllowed(req, ingress)) {
      sendJson(res, 403, { error: { type: 'permission_error', code: 'access_denied', message: 'Client IP is not allowed' } });
      return;
    }
    sendJson(res, 404, { error: { type: 'invalid_request_error', code: 'not_found', message: 'Not found' } });
    return;
  }
  const content = await readFile(join(publicDir, filename));
  const extension = filename.slice(filename.lastIndexOf('.'));
  const isUiBundle = filename === 'index.html' || filename === 'app.js' || filename === 'styles.css';
  res.writeHead(200, { 'content-type': MIME_TYPES[extension], 'cache-control': isUiBundle ? 'no-store' : 'public, max-age=300' });
  res.end(filename === 'index.html' ? content.toString().replace('__CODEX_SHARE_BASE_PATH__', publicBasePath) : content);
}

function normalizePublicBasePath(value) {
  const path = String(value || '').trim();
  if (!path || path === '/') return '/';
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')) {
    throw new Error('POOL_PUBLIC_BASE_PATH must be an absolute path without a query or fragment');
  }
  return `${path.replace(/\/+$/, '')}/`;
}

function poolIngress(input = {}) {
  return {
    allowedHosts: csv(input.allowedHosts ?? process.env.POOL_ALLOWED_HOSTS, ['localhost', '127.0.0.1', '[::1]']).map(normalizeHost),
    allowedOrigins: csv(input.allowedOrigins ?? process.env.POOL_ALLOWED_ORIGINS, []),
    firewallAllowlist: csv(input.firewallAllowlist ?? process.env.POOL_FIREWALL_ALLOWLIST, []),
    trustedProxies: csv(input.trustedProxies ?? process.env.POOL_TRUSTED_PROXIES, []),
    maxCompressedBodyBytes: Number(input.maxCompressedBodyBytes) || 100 * 1024 * 1024,
    maxDecompressedBodyBytes: Number(input.maxDecompressedBodyBytes) || 100 * 1024 * 1024
  };
}

function poolCodexGatewayOptions(input = {}) {
  return codexGatewayOptions({
    websocketKeepAliveMs: input.websocketKeepAliveMs ?? process.env.POOL_CODEX_WEBSOCKET_KEEPALIVE_MS,
    websocketIdleMs: input.websocketIdleMs ?? process.env.POOL_CODEX_WEBSOCKET_IDLE_MS,
    websocketFrameBytes: input.websocketFrameBytes ?? process.env.POOL_CODEX_WEBSOCKET_FRAME_BYTES,
    websocketPendingBytes: input.websocketPendingBytes ?? process.env.POOL_CODEX_WEBSOCKET_PENDING_BYTES,
    websocketBackpressureBytes: input.websocketBackpressureBytes ?? process.env.POOL_CODEX_WEBSOCKET_BACKPRESSURE_BYTES,
    streamBootstrapBuffering: input.streamBootstrapBuffering ?? process.env.POOL_CODEX_STREAM_BOOTSTRAP_BUFFERING,
    streamBootstrapBytes: input.streamBootstrapBytes ?? process.env.POOL_CODEX_STREAM_BOOTSTRAP_BYTES,
    streamBootstrapEvents: input.streamBootstrapEvents ?? process.env.POOL_CODEX_STREAM_BOOTSTRAP_EVENTS,
    streamBootstrapTimeoutMs: input.streamBootstrapTimeoutMs ?? process.env.POOL_CODEX_STREAM_BOOTSTRAP_TIMEOUT_MS,
    optimizeMultiAgentV2: input.optimizeMultiAgentV2 ?? process.env.POOL_CODEX_OPTIMIZE_MULTI_AGENT_V2,
    orphanDelegationCompatibility: input.orphanDelegationCompatibility ?? process.env.POOL_CODEX_ORPHAN_DELEGATION_COMPATIBILITY
  }, {});
}

function poolClaudeConfigFromEnv(env = process.env) {
  return claudeConfigFromEnv(env, 'POOL_CLAUDE_CONFIG_JSON');
}

function normalizeHost(value) {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function csv(value, fallback) {
  if (value === undefined) return fallback;
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean)
    : String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function requestCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((cookies, item) => {
    const index = item.indexOf('=');
    if (index <= 0) return cookies;
    const name = item.slice(0, index).trim();
    try {
      cookies[name] = decodeURIComponent(item.slice(index + 1).trim());
    } catch {}
    return cookies;
  }, {});
}

function cookie(name, value, { httpOnly = false, secure = false, maxAge = null } = {}) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Lax',
    ...(httpOnly ? ['HttpOnly'] : []),
    ...(secure ? ['Secure'] : []),
    ...(maxAge === null ? [] : [`Max-Age=${maxAge}`])
  ].join('; ');
}

function setCookies(res, cookies) {
  res.setHeader('set-cookie', cookies);
}

function isMutation(method) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method);
}

function envBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true';
}

function adminEventCursor(url) {
  const value = url.searchParams.get('eventCursor');
  if (!value || value.length > 512) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return typeof cursor?.createdAt === 'string' && typeof cursor?.id === 'string' ? cursor : null;
  } catch {
    return null;
  }
}

function sharingListQuery(url) {
  const rawLimit = Number(url.searchParams.get('limit') || 10);
  const limit = Number.isInteger(rawLimit) ? Math.min(50, Math.max(1, rawLimit)) : 10;
  const rawOffset = Number(url.searchParams.get('offset') || 0);
  const offset = Number.isInteger(rawOffset) ? Math.max(0, rawOffset) : 0;
  const query = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 320);
  const includePast = !url.searchParams.has('includePast') || url.searchParams.get('includePast') === 'true';
  const role = String(url.searchParams.get('role') || '').trim();
  return { limit, offset, query, includePast, role };
}

function poolErrorEnvelope(error) {
  if (error instanceof HttpError) {
    const type = error.statusCode === 401 ? 'authentication_error'
      : error.statusCode === 403 ? 'permission_error'
        : error.type;
    return { status: error.statusCode, body: openaiError(type, error.code, error.message) };
  }
  if ([400, 401, 403, 409].includes(error?.statusCode)) {
    const status = error.statusCode;
    const type = status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : 'invalid_request_error';
    const code = status === 403 ? 'forbidden' : status === 409 ? 'conflict' : 'invalid_request';
    return { status, body: openaiError(type, code, String(error.message || code).slice(0, 300)) };
  }
  return errorEnvelope(error);
}

function sendJson(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  if (status === 204) return res.end();
  res.end(JSON.stringify(value));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void startConfigured().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

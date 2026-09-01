import { notFound } from './store.js';
import { HttpError } from './http-ingress.js';
import { codexRefreshFailureCode, codexRefreshFailureDetail, refreshProviderCredentials } from './providers.js';

export const TOKEN_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;

const TOKEN_REFRESH_CONCURRENCY = 3;
const TOKEN_REFRESH_WINDOW_MS = 12 * 60 * 60 * 1_000;
const TOKEN_REFRESH_FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1_000;
const TOKEN_REFRESH_STALE_MS = 50_000;
const TOKEN_REFRESH_MAX_ATTEMPTS = 8;
const TOKEN_REFRESH_BATCH_SIZE = 100;

export async function refreshDueCodexTokens(store, { now = Date.now(), ...options } = {}) {
  const candidates = store.list()
    .map(({ id }) => ({ id, eligibleAt: tokenRefreshEligibleAt(store.get(id), now) }))
    .filter(({ eligibleAt }) => eligibleAt !== null)
    .sort((left, right) => left.eligibleAt - right.eligibleAt || left.id.localeCompare(right.id))
    .slice(0, TOKEN_REFRESH_BATCH_SIZE);
  return mapConcurrent(candidates, TOKEN_REFRESH_CONCURRENCY, async ({ id }) => {
    const upstream = store.get(id);
    const credentials = store.credentials(id);
    if (!credentials.refreshToken) return store.setTokenRefresh(id, tokenRefreshState('reauth_required', 'scheduled', now));
    return refreshCodexToken(store, id, { trigger: 'scheduled', now, ...options });
  });
}

export async function refreshCodexToken(store, id, { trigger = 'manual', now = Date.now(), retryAttempt = null, ...options } = {}) {
  const upstream = store.get(id);
  if (!upstream) throw notFound();
  if (upstream.type !== 'codex') throw new HttpError(400, 'invalid_request', 'Token refresh is only available for Codex upstreams');
  const refreshing = upstream.tokenRefresh;
  if (refreshing?.status === 'reauth_required') return { upstream: store.getPublic(id), errorCode: 'reauth_required' };
  if (refreshing?.status === 'refreshing' && Date.parse(refreshing.startedAt) > now - TOKEN_REFRESH_STALE_MS) return { upstream: store.getPublic(id), errorCode: 'refresh_in_progress' };
  const credentials = store.credentials(id);
  if (!credentials.refreshToken) {
    return { upstream: store.setTokenRefresh(id, tokenRefreshState('reauth_required', trigger, now)), errorCode: 'reauth_required' };
  }
  store.setTokenRefresh(id, tokenRefreshState('refreshing', trigger, now));
  try {
    const refreshed = await refreshProviderCredentials(upstream, credentials, {
      ...options,
      saveCredentials: (updated, accessTokenExpiresAt) => store.persistCredentials(id, updated, accessTokenExpiresAt)
    });
    return refreshed ? { upstream: store.setTokenRefresh(id, tokenRefreshState('succeeded', trigger, now)) } : { upstream: store.getPublic(id) };
  } catch (error) {
    if ((Number(store.get(id)?.credentialEpoch) || 0) !== (Number(upstream.credentialEpoch) || 0)) return { upstream: store.getPublic(id) };
    const errorCode = codexRefreshFailureCode(error);
    return { upstream: store.setTokenRefresh(id, tokenRefreshState(errorCode, trigger, now, retryAttempt, codexRefreshFailureDetail(error))), errorCode };
  }
}

export function createTokenRefreshScheduler(store, options) {
  const timers = new Map();
  const schedule = (id, trigger = 'scheduled', attempt = 1, retryAt = null) => {
    if (attempt >= TOKEN_REFRESH_MAX_ATTEMPTS) return;
    const upstream = store.get(id);
    if (!upstream || upstream.tokenRefresh?.status !== 'failed') return;
    const dueAt = retryAt || new Date(Date.now() + Math.min(2 ** attempt * 30_000, 3_600_000)).toISOString();
    const delay = Math.max(0, Date.parse(dueAt) - Date.now());
    clearTimeout(timers.get(id));
    store.setTokenRefresh(id, { ...upstream.tokenRefresh, trigger, retryAttempt: attempt, retryAt: dueAt });
    const timer = setTimeout(async () => {
      timers.delete(id);
      if (store.get(id)?.tokenRefresh?.status !== 'failed') return;
      try {
        const result = await refreshCodexToken(store, id, { ...options, trigger, retryAttempt: attempt + 1 });
        if (result.errorCode === 'failed') schedule(id, trigger, attempt + 1);
      } catch {}
    }, delay);
    timer.unref?.();
    timers.set(id, timer);
  };
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      for (const upstream of store.list()) {
        const refresh = store.get(upstream.id)?.tokenRefresh;
        if (refresh?.status === 'failed' && refresh.retryAttempt && refresh.retryAt) schedule(upstream.id, refresh.trigger, refresh.retryAttempt, refresh.retryAt);
      }
      const results = await refreshDueCodexTokens(store, options);
      for (const result of results) {
        const value = result.status === 'fulfilled' && result.value;
        if (value?.errorCode === 'failed') schedule(value.upstream.id, value.upstream.tokenRefresh.trigger, value.upstream.tokenRefresh.retryAttempt || 1);
      }
      return results;
    } finally {
      running = false;
    }
  };
  return { run, schedule, close: () => timers.forEach(clearTimeout) };
}

function tokenRefreshEligibleAt(upstream, now) {
  if (!upstream || upstream.type !== 'codex') return null;
  const refresh = upstream.tokenRefresh;
  if (refresh?.status === 'reauth_required') return null;
  if (refresh?.status === 'refreshing') {
    const startedAt = Date.parse(refresh.startedAt || upstream.updatedAt);
    return !Number.isFinite(startedAt) || startedAt <= now - TOKEN_REFRESH_STALE_MS ? Number.isFinite(startedAt) ? startedAt : now : null;
  }
  if (refresh?.status === 'failed') {
    const finishedAt = Date.parse(refresh.finishedAt || upstream.updatedAt);
    const eligibleAt = Number.isFinite(finishedAt) ? finishedAt + TOKEN_REFRESH_FAILURE_COOLDOWN_MS : now;
    return eligibleAt <= now ? eligibleAt : null;
  }
  const expiresAt = Date.parse(upstream.accessTokenExpiresAt);
  const eligibleAt = expiresAt - TOKEN_REFRESH_WINDOW_MS;
  return Number.isFinite(eligibleAt) && eligibleAt <= now ? eligibleAt : null;
}

function tokenRefreshState(status, trigger, now, retryAttempt = null, errorDetail = null) {
  const timestamp = new Date(now).toISOString();
  return status === 'refreshing'
    ? { status, startedAt: timestamp, trigger }
    : { status, finishedAt: timestamp, trigger, errorCode: status === 'succeeded' ? null : status, ...(errorDetail ? { errorDetail } : {}), ...(status === 'failed' && retryAttempt ? { retryAttempt } : {}) };
}

async function mapConcurrent(items, limit, mapper) {
  const results = Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }));
  return results;
}

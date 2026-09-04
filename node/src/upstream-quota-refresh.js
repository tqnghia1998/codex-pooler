import { refreshQuota } from './providers.js';

export const QUOTA_REFRESH_BATCH_SIZE = 10;
const inFlightRefreshes = new WeakMap();

export async function refreshUpstreamQuota(store, id, { notify = true, ...options } = {}) {
  const upstream = store.get(id);
  if (!upstream) return null;
  let pending = inFlightRefreshes.get(store);
  if (!pending) {
    pending = new Map();
    inFlightRefreshes.set(store, pending);
  }
  const existing = pending.get(id);
  if (existing) {
    existing.notify ||= notify;
    return existing.promise;
  }
  const entry = { notify, promise: null };
  entry.promise = refreshUpstreamQuotaOnce(store, id, upstream, entry, options);
  pending.set(id, entry);
  try {
    return await entry.promise;
  } finally {
    if (pending.get(id) === entry) pending.delete(id);
  }
}

async function refreshUpstreamQuotaOnce(store, id, upstream, entry, options) {
  const quota = await refreshQuota(upstream, store.credentials(id), {
    ...options,
    saveCredentials: (updated, accessTokenExpiresAt) => store.persistCredentials(id, updated, accessTokenExpiresAt)
  });
  if (quota === upstream.quota) return store.getPublic(id);
  return store.setQuota(id, quota, { notify: entry.notify });
}

export async function refreshAllUpstreamQuotas(store, {
  ids = null,
  shouldRefresh = () => true,
  skippedResult = () => null,
  ...options
} = {}) {
  const selectedIds = Array.isArray(ids) ? new Set(ids) : null;
  const upstreams = store.list().filter(({ id }) => !selectedIds || selectedIds.has(id));
  const results = [];
  for (let index = 0; index < upstreams.length; index += QUOTA_REFRESH_BATCH_SIZE) {
    results.push(...await Promise.allSettled(upstreams.slice(index, index + QUOTA_REFRESH_BATCH_SIZE).map(async ({ id }) => {
      const upstream = store.get(id);
      if (!upstream) return null;
      if (!shouldRefresh(upstream)) return skippedResult(upstream);
      await refreshUpstreamQuota(store, id, { ...options, notify: false });
      return { status: 'refreshed', id };
    })));
  }
  if (results.some((result) => result.value?.status === 'refreshed')) store.notifyUpstreamsChange();
  return results;
}

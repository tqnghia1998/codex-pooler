import { refreshQuota } from './providers.js';

export const QUOTA_REFRESH_BATCH_SIZE = 10;

export async function refreshUpstreamQuota(store, id, { notify = true, ...options } = {}) {
  const upstream = store.get(id);
  if (!upstream) return null;
  const quota = await refreshQuota(upstream, store.credentials(id), {
    ...options,
    saveCredentials: (updated, accessTokenExpiresAt) => store.persistCredentials(id, updated, accessTokenExpiresAt)
  });
  return store.setQuota(id, quota, { notify });
}

export async function refreshAllUpstreamQuotas(store, {
  shouldRefresh = () => true,
  skippedResult = () => null,
  ...options
} = {}) {
  const upstreams = store.list();
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

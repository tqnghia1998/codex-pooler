export const SHARING_COUNTS_STORAGE_KEY = 'codex_pool_sharing_counts';

export function isCountStorageEvent(event) {
  return event?.type === 'storage' && Boolean(event.key?.startsWith(`${SHARING_COUNTS_STORAGE_KEY}:`));
}

export function reconcileTabCounts(previous, counts, activeView) {
  const totals = {};
  const unread = {};
  for (const [tab, count] of Object.entries(counts)) {
    if (!Number.isSafeInteger(count) || count < 0) continue;
    totals[tab] = count;
    if (tab !== activeView && (
      previous?.unread?.[tab] === true
      || Number.isSafeInteger(previous?.totals?.[tab]) && count > previous.totals[tab]
    )) unread[tab] = true;
  }
  return { totals, unread };
}

export function openCountTab(state, tab) {
  if (!state.unread[tab]) return state;
  const unread = { ...state.unread };
  delete unread[tab];
  return { ...state, unread };
}

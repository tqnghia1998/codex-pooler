// Capacity evidence is separate from operator authorization and account health.
export const CAPACITY_FRESHNESS_MS = 5 * 60_000;

export function providerCreditsPolicy(value = false) {
  if (typeof value !== 'boolean') throw new Error('allowProviderCredits must be a boolean');
  return value;
}

export function codexCapacityDecision(upstream, model = '', now = Date.now()) {
  const evidence = upstream?.quota?.capacity;
  if (upstream?.type !== 'codex' || !evidence) return null;
  const observed = Date.parse(upstream.quota.observedAt);
  const fresh = evidence.credentialEpoch === upstream.credentialEpoch && Number.isFinite(observed) && observed <= now && observed + CAPACITY_FRESHNESS_MS > now;
  const windows = [...(evidence.windows || []), ...(evidence.modelWindows || []).filter((window) => window.model === model)];
  const spend = evidence.spendControl;
  if (spend?.remainingPercent === 0 && (Date.parse(spend.resetAt) > now || !spend.resetAt && fresh)) return { eligible: false, basis: 'none', fresh };
  const exhausted = windows.some((window) => window.remainingPercent === 0 && (Date.parse(window.resetAt) > now || !window.resetAt && fresh));
  if (!exhausted && !(fresh && evidence.allowed === false)) return { eligible: true, basis: 'included', fresh };
  const credits = evidence.credits;
  const usable = fresh && upstream.allowProviderCredits === true && credits?.hasCredits === true
    && (credits.unlimited === true || typeof credits.balance === 'number' && credits.balance > 0);
  return { eligible: usable, basis: usable ? 'provider_credits' : 'none', fresh };
}

export function parseCodexCapacity(payload, observedAt, resetTime) {
  const window = (raw, model = null, reached = false) => {
    if (!raw || typeof raw !== 'object') return null;
    const used = numeric(raw.used_percent) ?? (reached ? 100 : null);
    if (used === null) return null;
    return { remainingPercent: Math.max(0, 100 - Math.max(0, used)), resetAt: resetTime(raw, observedAt), ...(model ? { model } : {}) };
  };
  const rate = payload?.rate_limit || {};
  const credits = payload?.credits || {};
  return {
    allowed: rate.limit_reached === true ? false : typeof rate.allowed === 'boolean' ? rate.allowed : null,
    windows: [window(rate.primary_window || rate.primary, null, rate.limit_reached === true), window(rate.secondary_window || rate.secondary, null, rate.limit_reached === true)].filter(Boolean),
    spendControl: window(payload?.spend_control?.individual_limit),
    modelWindows: (Array.isArray(payload?.additional_rate_limits) ? payload.additional_rate_limits : []).slice(0, 64).flatMap((entry) => {
      const model = typeof entry.model === 'string' ? entry.model.trim().toLowerCase() : '';
      if (!model || model.length > 128) return [];
      const rate = entry.rate_limit || {};
      return [window(rate.primary_window || rate.primary, model, rate.limit_reached === true), window(rate.secondary_window || rate.secondary, model, rate.limit_reached === true)].filter(Boolean);
    }),
    credits: { hasCredits: credits.has_credits === true, unlimited: credits.unlimited === true, balance: numeric(credits.balance) }
  };
}

function numeric(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function offerExceedsProviderQuota(quotaMicros, upstream) {
  const value = upstream?.quota?.remainingDollars;
  if (value === null || value === undefined || value === '') return false;
  const remainingDollars = Number(value);
  return Number.isFinite(remainingDollars) && quotaMicros > Math.round(Math.max(0, remainingDollars) * 1_000_000);
}

export function providerQuotaExhausted(upstream) {
  const quota = upstream?.quota;
  if (!quota || typeof quota !== 'object') return false;
  const remainingPercent = Number(quota.remainingPercent);
  if (Number.isFinite(remainingPercent)) return remainingPercent <= 0;
  const remainingDollars = Number(quota.remainingDollars);
  if (Number.isFinite(remainingDollars)) return remainingDollars <= 0;
  const remainingUnits = Number(quota.remainingUnits);
  return Number.isFinite(remainingUnits) && remainingUnits <= 0;
}

export function providerIssue(upstream) {
  if (!upstream) {
    return {
      code: 'provider_unavailable',
      message: 'The provider account is unavailable.'
    };
  }
  if (upstream.health?.status === 'reauth_required' || upstream.tokenRefresh?.status === 'reauth_required') {
    return {
      code: 'provider_reauth_required',
      message: 'The provider must sign in with Codex again before this quota can be used.'
    };
  }
  if (upstream.tokenRefresh?.status === 'failed') {
    return {
      code: 'provider_token_refresh_failed',
      message: 'The provider account is temporarily unavailable while Codex token refresh is retried.'
    };
  }
  if (providerQuotaExhausted(upstream)) {
    return {
      code: 'provider_quota_exhausted',
      message: 'The provider quota is exhausted and cannot be used until it resets.'
    };
  }
  return null;
}

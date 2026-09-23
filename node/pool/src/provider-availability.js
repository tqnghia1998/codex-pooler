export function offerExceedsProviderQuota(quotaMicros, upstream) {
  const value = upstream?.quota?.remainingDollars;
  if (value === null || value === undefined || value === '') return false;
  const remainingDollars = Number(value);
  return Number.isFinite(remainingDollars) && quotaMicros > Math.round(Math.max(0, remainingDollars) * 1_000_000);
}

export function providerQuotaExhausted(upstream) {
  if (!quotaControlsSharing(upstream)) return false;
  const quota = upstream?.quota;
  if (!quota || typeof quota !== 'object') return false;
  const remainingPercent = finiteQuotaValue(quota.remainingPercent);
  if (remainingPercent !== null) return remainingPercent <= 0;
  const remainingDollars = finiteQuotaValue(quota.remainingDollars);
  if (remainingDollars !== null) return remainingDollars <= 0;
  const remainingUnits = finiteQuotaValue(quota.remainingUnits);
  return remainingUnits !== null && remainingUnits <= 0;
}

function quotaControlsSharing(upstream) {
  const isExternal = upstream?.type === 'claude'
    || upstream?.quotaSource === 'ais'
    || upstream?.quotaSource === 'aiswitch';
  return !isExternal || upstream?.quota?.source === 'loop_ai_usage';
}

function finiteQuotaValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function providerIssue(upstream) {
  if (!upstream) {
    return {
      code: 'provider_unavailable',
      message: 'The provider account is unavailable.'
    };
  }
  if (upstream.health?.status === 'reauth_required' || upstream.tokenRefresh?.status === 'reauth_required') {
    if (upstream.quotaSource === 'ais' || upstream.quotaSource === 'aiswitch') {
      return {
        code: 'provider_key_rejected',
        message: 'The AIS project key was rejected. The provider must update the project key to resume sharing.'
      };
    }
    return {
      code: 'provider_reauth_required',
      message: upstream.type === 'claude'
        ? 'The provider must update their Claude token before this quota can be used.'
        : 'The provider must sign in with Codex again before this quota can be used.'
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

// Product-only quota integration. Keep this module outside the gateway's
// runtime import graph so the employee lookup is never vendored downstream.
import { claudeSpendAllowanceEmail, claudeSpendLimitsConfigFromEnv, createClaudeSpendAllowanceReader } from './claude-spend-limits.js';
import { refreshQuota } from './providers.js';
import { refreshAllUpstreamQuotas, refreshUpstreamQuota } from './upstream-quota-refresh.js';

const isAllowance = (quota) => quota?.source === 'claude_enterprise_spend_limits';
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const quotaPolicy = Object.freeze({
  acceptUpdate: (upstream, quota) => !(isAllowance(upstream.quota) && quota?.source === 'claude_oauth_headers')
    && !(isAllowance(quota) && quota.employeeEmail && quota.employeeEmail !== claudeSpendAllowanceEmail(upstream)),
  recoversCredentials: (_upstream, quota) => Boolean(quota) && !isAllowance(quota),
  invalidateForEmailChange: (upstream, email) => isAllowance(upstream.quota)
    && claudeSpendAllowanceEmail(upstream) !== claudeSpendAllowanceEmail({ ...upstream, email })
});

export function configureRelaydeckQuota(store) {
  store.configureQuotaPolicy(quotaPolicy);
}

export function updateRelaydeckUpstream(store, id, input) {
  configureRelaydeckQuota(store);
  const previousEmail = claudeSpendAllowanceEmail(store.get(id));
  const updated = store.update(id, input);
  const current = store.get(id);
  if (isAllowance(current?.quota) && previousEmail !== claudeSpendAllowanceEmail(current)) return store.setQuota(id, null);
  return updated;
}

function relaydeckQuotaOptions(options) {
  const { claudeSpendLimits = claudeSpendLimitsConfigFromEnv(), ...rest } = options;
  return {
    ...rest,
    claudeQuotaReader: (upstream) => createClaudeSpendAllowanceReader(upstream, claudeSpendLimits),
    quotaWriteOptions: (upstream) => upstream.type === 'claude' && (claudeSpendLimits.apiKey || claudeSpendLimits.mapFile)
      ? { expectedEmail: normalizeEmail(upstream.email) } : {}
  };
}

export function refreshRelaydeckQuota(upstream, credentials, options = {}) {
  return refreshQuota(upstream, credentials, relaydeckQuotaOptions(options));
}

export function refreshRelaydeckUpstreamQuota(store, id, options = {}) {
  configureRelaydeckQuota(store);
  return refreshUpstreamQuota(store, id, relaydeckQuotaOptions(options));
}

export function refreshAllRelaydeckUpstreamQuotas(store, options = {}) {
  configureRelaydeckQuota(store);
  return refreshAllUpstreamQuotas(store, relaydeckQuotaOptions(options));
}

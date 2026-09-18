const LOOP_API_BASE_URL = 'https://loop.shopee.io';
const DEFAULT_DELAY_MS = 60 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DATA_PATH = '/api/v1/admin/ai-usage-personal/data';
const PROVIDER_KEYS = {
  claude: ['claude.usage_usd', 'claude.cap_usd'],
  ais: ['ais.usage_usd', 'ais.cap_usd', 'ais.balance_usd']
};

export const ADVISORY_QUOTA_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;

export function advisoryQuotaClientFromEnv(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  return createAdvisoryQuotaClient({
    serviceToken: env.POOL_AI_QUOTA_SERVICE_TOKEN || '',
    delayMs: positiveNumber(env.POOL_AI_QUOTA_DELAY_MS, DEFAULT_DELAY_MS),
    timeoutMs: positiveNumber(env.POOL_AI_QUOTA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    fetchImpl
  });
}

export function createAdvisoryQuotaClient({
  serviceToken = '',
  delayMs = DEFAULT_DELAY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch
} = {}) {
  const token = String(serviceToken || '').trim();
  const enabled = Boolean(token);

  return {
    enabled,
    async query(email, providers = Object.keys(PROVIDER_KEYS)) {
      if (!enabled) return [];
      const normalizedEmail = normalizeEmail(email);
      if (!normalizedEmail) throw new Error('A valid account email is required for delayed quota lookup');
      const selectedProviders = [...new Set(providers)].filter((provider) => PROVIDER_KEYS[provider]);
      const quotaMonth = currentMonth();
      const bounds = monthBounds(quotaMonth);
      const reportedAt = new Date().toISOString();
      const values = new Map(await Promise.all(selectedProviders.flatMap((provider) => (
        PROVIDER_KEYS[provider].map(async (dataKey) => [
          `${provider}:${dataKey}`,
          await getMonthlyValue({
            serviceToken: token,
            email: normalizedEmail,
            bounds,
            dataKey,
            timeoutMs,
            fetchImpl
          })
        ])
      ))));

      return selectedProviders.map((provider) => {
        const usageDollars = money(values.get(`${provider}:${provider}.usage_usd`));
        const limitDollars = money(values.get(`${provider}:${provider}.cap_usd`));
        const storedBalance = provider === 'ais'
          ? money(values.get('ais:ais.balance_usd'))
          : null;
        const remainingDollars = storedBalance ?? balance(limitDollars, usageDollars);
        return {
          provider,
          found: usageDollars !== null || limitDollars !== null || storedBalance !== null,
          quotaMonth,
          usageDollars,
          limitDollars,
          remainingDollars,
          reportedAt,
          dataThroughAt: new Date(Date.parse(reportedAt) - delayMs).toISOString(),
          delaySeconds: Math.round(delayMs / 1_000),
          source: 'loop_ai_usage'
        };
      });
    }
  };
}

export async function refreshAccountAdvisoryQuotas({
  store,
  targets,
  email,
  client
}) {
  const eligibleTargets = targets.filter(({ provider }) => PROVIDER_KEYS[provider]);
  if (!client?.enabled || !eligibleTargets.length) return { status: 'skipped', updated: 0 };
  const observations = await client.query(email, eligibleTargets.map(({ provider }) => provider));
  const byProvider = new Map(observations.map((observation) => [observation.provider, observation]));
  let updated = 0;
  for (const target of eligibleTargets) {
    const observation = byProvider.get(target.provider);
    if (!observation) continue;
    store.setAdvisoryQuota(target.upstreamId, observation, { notify: false });
    updated += 1;
  }
  if (updated) store.notifyUpstreamsChange();
  return { status: 'refreshed', updated };
}

export async function refreshAllAdvisoryQuotas(store, productStore, {
  client,
  logger = console
} = {}) {
  if (!client?.enabled) return [];
  const grouped = new Map();
  for (const target of productStore.listAdvisoryQuotaTargets(store)) {
    const current = grouped.get(target.email) || [];
    current.push(target);
    grouped.set(target.email, current);
  }
  return Promise.allSettled([...grouped.entries()].map(async ([email, targets]) => {
    try {
      return await refreshAccountAdvisoryQuotas({ store, targets, email, client });
    } catch (error) {
      logger?.warn?.(`QuotaHub delayed quota refresh failed for ${email}: ${error?.message || error}`);
      throw error;
    }
  }));
}

export function advisoryProvider(upstream) {
  if (upstream?.type === 'claude') return 'claude';
  if (upstream?.quotaSource === 'ais' || upstream?.quotaSource === 'aiswitch') return 'ais';
  return null;
}

async function getMonthlyValue({
  serviceToken,
  email,
  bounds,
  dataKey,
  timeoutMs,
  fetchImpl
}) {
  const url = new URL(DATA_PATH, `${LOOP_API_BASE_URL}/`);
  url.searchParams.set('user_email', email);
  url.searchParams.set('data_key', dataKey);
  url.searchParams.set('from_date', String(bounds.startDate));
  url.searchParams.set('to_date', String(bounds.endDate));
  url.searchParams.set('status', 'active');
  url.searchParams.set('limit', '1');
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${serviceToken}` },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Delayed quota API returned invalid JSON (${response.status})`);
  }
  if (!response.ok || !payload?.success) {
    const message = payload?.error?.message || text.slice(0, 300) || 'request failed';
    throw new Error(`Delayed quota API request failed (${response.status}): ${message}`);
  }
  const value = payload.result?.data?.[0]?.numeric_value;
  return value === null || value === undefined || value === '' ? null : finiteNumber(value);
}

function currentMonth(now = new Date()) {
  return now.getUTCFullYear() * 100 + now.getUTCMonth() + 1;
}

function monthBounds(month) {
  const year = Math.floor(month / 100);
  const monthIndex = month % 100;
  const end = new Date(Date.UTC(year, monthIndex, 0));
  return {
    startDate: year * 10_000 + monthIndex * 100 + 1,
    endDate: end.getUTCFullYear() * 10_000 + (end.getUTCMonth() + 1) * 100 + end.getUTCDate()
  };
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : '';
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function money(value) {
  const number = finiteNumber(value);
  return number === null ? null : Number(number.toFixed(6));
}

function balance(limit, usage) {
  return limit === null || usage === null ? null : money(limit - usage);
}

import { readFile } from 'node:fs/promises';
import { decodeClaudeResponse } from './upstream-response.js';

export const CLAUDE_SPEND_LIMITS_URL = 'https://api.anthropic.com/v1/organizations/spend_limits/effective';

export function claudeSpendLimitsConfigFromEnv(env = process.env, prefix = 'CODEX_POOLER_') {
  return {
    apiKey: env[`${prefix}CLAUDE_SPEND_LIMITS_API_KEY`] || '',
    mapFile: env[`${prefix}CLAUDE_SPEND_LIMITS_MAP_FILE`] || ''
  };
}

export function validateClaudeEmployeeMap(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)
    || Object.entries(map).some(([email, id]) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || email !== email.toLowerCase() || typeof id !== 'string' || !/^user_[a-zA-Z0-9]+$/.test(id))) {
    throw new Error('Invalid Claude email-to-user-ID catalog');
  }
  return map;
}

// Decimal cents with up to three fractional digits: keep arithmetic exact until
// converting the result to the gateway's JSON numeric quota fields.
function minorUnits(value) {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,3})?$/.test(value)) throw new Error('Invalid spend amount in API response');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Spend amount exceeds supported precision');
  return result;
}

export function parseClaudeSpendAllowance(rows, observedAt = new Date()) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('No Claude spend-allowance records');
  const observed = new Date(observedAt).toISOString();
  const windows = rows.map((row) => {
    if (typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)
      || typeof row.period !== 'string' || !/^[a-z_]{1,64}$/.test(row.period)) {
      throw new Error('Missing or invalid currency or period in spend response');
    }
    const spent = minorUnits(row.period_to_date_spend);
    const limit = row.amount === null ? null : minorUnits(row.amount);
    const balance = limit === null ? null : limit > spent ? limit - spent : 0n;
    const remainingPercent = limit === null ? null : limit === 0n ? 0 : Number(balance) / Number(limit) * 100;
    const dollars = (value) => value === null || row.currency !== 'USD' ? null : Number(value) / 100_000;
    return {
      key: `spend_${row.period}`,
      label: `${row.period} spend allowance`,
      currency: row.currency,
      unlimited: limit === null,
      usedPercent: limit === null ? null : 100 - remainingPercent,
      remainingPercent,
      usedUnits: Number(spent) / 1000,
      remainingUnits: balance === null ? null : Number(balance) / 1000,
      limitUnits: limit === null ? null : Number(limit) / 1000,
      usedDollars: dollars(spent),
      remainingDollars: dollars(balance),
      limitDollars: dollars(limit),
      // The API does not promise a reset timestamp; do not invent one.
      windowSeconds: null,
      resetAt: null,
      observedAt: observed
    };
  });
  // All periods apply. Show the tightest finite allowance, preferring monthly
  // when equally constrained. An uncapped period must not hide a finite cap.
  const selected = [...windows].sort((a, b) => (a.remainingPercent ?? Infinity) - (b.remainingPercent ?? Infinity)
    || Number(b.key === 'spend_monthly') - Number(a.key === 'spend_monthly'))[0];
  return { ...selected, source: 'claude_enterprise_spend_limits', windows };
}

export async function queryClaudeSpendAllowance(email, map, fetchPage) {
  email = String(email || '').trim().toLowerCase();
  if (!Object.hasOwn(map, email)) throw new Error('Email not found in Claude employee catalog');
  const userId = map[email];
  let page;
  const seen = new Set();
  // Provider periods for one member are guaranteed to stay on the same page.
  for (let count = 0; count < 100; count++) {
    const body = await fetchPage(page, userId);
    if (!Array.isArray(body?.data)) throw new Error('Invalid spend response: data is not an array');
    const matches = body.data.filter((row) => row?.actor?.email_address?.toLowerCase() === email && row.actor.user_id === userId);
    if (matches.length) return parseClaudeSpendAllowance(matches);
    page = body.next_page;
    if (page == null) throw new Error('No spend-allowance record found for catalogued user; this does not mean zero remaining');
    if (typeof page !== 'string' || !page || seen.has(page)) throw new Error('Invalid or repeated pagination cursor');
    seen.add(page);
  }
  throw new Error('Claude spend-allowance pagination limit exceeded');
}

export async function createClaudeSpendAllowanceReader(upstream, { apiKey = '', mapFile = '' } = {}) {
  if (!apiKey && !mapFile) return null;
  if (!apiKey || !mapFile) throw new Error('Claude spend limits require both an API key and an employee catalog path');
  let map;
  try {
    map = validateClaudeEmployeeMap(JSON.parse(await readFile(mapFile, 'utf8')));
  } catch {
    throw new Error('Cannot read a valid Claude employee catalog');
  }
  const email = String(upstream.email || '').trim().toLowerCase();
  if (!Object.hasOwn(map, email)) throw new Error('Email not found in Claude employee catalog');
  return (fetchImpl = globalThis.fetch) => fetchClaudeSpendAllowance(email, map, apiKey, fetchImpl);
}

export async function refreshClaudeSpendAllowance(upstream, { fetchImpl = globalThis.fetch, ...config } = {}) {
  const readAllowance = await createClaudeSpendAllowanceReader(upstream, config);
  return readAllowance ? readAllowance(fetchImpl) : null;
}

async function fetchClaudeSpendAllowance(email, map, apiKey, fetchImpl) {
  try {
    const signal = AbortSignal.timeout(45_000);
    return await queryClaudeSpendAllowance(email, map, async (page, userId) => {
      const url = new URL(CLAUDE_SPEND_LIMITS_URL);
      url.searchParams.set('limit', '1');
      url.searchParams.set('user_ids[]', userId);
      if (page) url.searchParams.set('page', page);
      const response = await fetchImpl(url.href, {
        method: 'GET',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', accept: 'application/json', 'cache-control': 'no-cache' },
        redirect: 'error',
        signal
      });
      if (!response.ok) {
        const error = new Error(response.status === 403
          ? 'Claude spend limits HTTP 403: a key with read:spend_limits is required'
          : `Claude spend limits HTTP ${response.status}`);
        error.statusCode = response.status;
        error.retryAfter = response.headers.get('retry-after');
        throw error;
      }
      const decoded = await decodeClaudeResponse(response, { maxBytes: 2 * 1024 * 1024 });
      return decoded.json();
    });
  } catch (error) {
    // Never expose provider bodies, headers, employee records, or raw transport
    // errors: a transport implementation may include the administrative key.
    const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 502;
    const safe = new Error(status === 403 ? 'Claude spend limits HTTP 403: a key with read:spend_limits is required'
      : `Claude spend-allowance query failed (HTTP ${status}); previous quota retained`);
    safe.statusCode = status;
    safe.retryAfter = error.retryAfter;
    throw safe;
  }
}

import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com';
export const DEFAULT_COMPASS_BASE_URL = 'https://compass.llm.shopee.io/compass-api/v1';
export const STATIC_MODEL_CATALOG = Object.freeze([
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5',
  'glm-5.2', 'kimi-k3'
].map((id) => Object.freeze({ id, object: 'model', owned_by: id.startsWith('claude-') ? 'compass' : 'codex' })));
export const SUPPORTED_TYPES = new Set(['codex', 'compass']);
export const CREDITS_PER_DOLLAR = 25;
export const MICROS_PER_CREDIT = 40_000;
const MONTH_SECONDS = 27 * 24 * 60 * 60;
const SETTLEMENT_LIMIT = 100;

export function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function number(value, label, { integer = false, min = 0 } = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && text(value) === '')) {
    throw new Error(`${label} is required`);
  }
  const parsed = typeof value === 'number' ? value : Number(text(value));
  if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${label} must be a number >= ${min}${integer ? ' (integer)' : ''}`);
  }
  return parsed;
}

export function dollarsToCredits(value) {
  return Math.round(number(value, 'capDollars') * CREDITS_PER_DOLLAR);
}

export function dollarsToMicros(value) {
  const dollars = number(value, 'costUsd');
  const micros = Math.round(dollars * 1_000_000);
  if (!Number.isSafeInteger(micros)) throw new Error('costUsd is too large');
  return micros;
}

export function microsToCredits(value) {
  return Number(value) / MICROS_PER_CREDIT;
}

export function creditsToDollars(value) {
  return Number(value) / CREDITS_PER_DOLLAR;
}

export function normalizeBaseUrl(value, fallback) {
  return text(value || fallback).replace(/\/+$/, '').replace(/\/backend-api$/, '');
}

export function defaultBaseUrl(type) {
  return type === 'compass' ? DEFAULT_COMPASS_BASE_URL : DEFAULT_CODEX_BASE_URL;
}

export function maskEmail(value) {
  const email = text(value);
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...local].map((character, index) => {
    if (index === 0 || !/^[A-Za-z0-9]$/.test(character)) return character;
    const digest = createHash('sha256').update(`${email}:${index}`).digest();
    return alphabet[digest.readUInt32BE(0) % alphabet.length];
  }).join('');
}

export function deriveUpstreamName(type, { projectId = '', email = '', accountId = '' } = {}) {
  if (type === 'compass') return text(projectId) || 'Compass project';
  return maskEmail(email) || text(accountId) || 'Codex account';
}

export function decodeJwtPayload(token) {
  try {
    const [, payload] = text(token).split('.');
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

export function accessTokenExpiresAt(token, expiresIn) {
  const seconds = Number(expiresIn);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(Date.now() + seconds * 1000).toISOString();
  const exp = Number(decodeJwtPayload(token).exp);
  return Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000).toISOString() : null;
}

function authClaim(claims, key) {
  const auth = claims?.['https://api.openai.com/auth'];
  return text(auth?.[key]) || text(claims?.[key]);
}

export function parseCodexAuthJson(raw) {
  let payload;
  try {
    payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error('Codex auth JSON is malformed');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Codex auth JSON must be an object');
  }

  const tokens = payload.tokens && typeof payload.tokens === 'object' ? payload.tokens : payload;
  const accessToken = text(tokens.access_token || payload.access_token);
  if (!accessToken) throw new Error('Codex auth JSON is missing tokens.access_token');

  const idToken = text(tokens.id_token || payload.id_token);
  const idClaims = decodeJwtPayload(idToken);
  const accessClaims = decodeJwtPayload(accessToken);
  const profile = idClaims?.['https://api.openai.com/profile'] || accessClaims?.['https://api.openai.com/profile'];
  const accountId = text(tokens.account_id || authClaim(idClaims, 'chatgpt_account_id') || authClaim(accessClaims, 'chatgpt_account_id'));
  const email = text(idClaims?.email || accessClaims?.email || profile?.email);

  return {
    accessToken,
    accessTokenExpiresAt: accessTokenExpiresAt(accessToken, tokens.expires_in || payload.expires_in),
    refreshToken: text(tokens.refresh_token || payload.refresh_token),
    idToken,
    accountId,
    email,
    name: deriveUpstreamName('codex', { email, accountId })
  };
}

export function createUpstream(input) {
  const type = text(input.type).toLowerCase();
  if (!SUPPORTED_TYPES.has(type)) throw new Error('type must be codex or compass');
  const quotaSource = normalizeQuotaSource(input.quotaSource || input.metadata?.quota_type || input.metadata?.quotaType);
  const upstream = {
    id: randomUUID(),
    type,
    name: '',
    baseUrl: defaultBaseUrl(type),
    accountId: '',
    email: '',
    accessTokenExpiresAt: null,
    credentialEpoch: 1,
    projectId: '',
    quota: null,
    quotaSource,
    spending: newSpending(),
    priority: null,
    credentials: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (type === 'codex') {
    const auth = input.authJson ? parseCodexAuthJson(input.authJson) : parseCodexAuthJson({ tokens: {
      access_token: input.accessToken,
      refresh_token: input.refreshToken,
      id_token: input.idToken,
      account_id: input.accountId
    }});
    upstream.accountId = auth.accountId;
    upstream.email = auth.email;
    upstream.name = deriveUpstreamName(type, upstream);
    upstream.accessTokenExpiresAt = auth.accessTokenExpiresAt;
    upstream.credentials = { accessToken: auth.accessToken, refreshToken: auth.refreshToken, idToken: auth.idToken };
    if (input.metadata && typeof input.metadata === 'object') upstream.metadata = input.metadata;
  } else {
    upstream.projectId = text(input.projectId);
    if (!upstream.projectId) throw new Error('projectId is required');
    const projectKey = text(input.projectKey);
    if (!projectKey) throw new Error('projectKey is required');
    upstream.name = deriveUpstreamName(type, upstream);
    upstream.credentials = { projectKey };
    if (input.metadata && typeof input.metadata === 'object') upstream.metadata = input.metadata;
  }

  return upstream;
}

export function updateUpstream(upstream, input) {
  upstream.baseUrl = defaultBaseUrl(upstream.type);

  if (upstream.type === 'codex') {
    if (input.authJson || input.accessToken) {
      const auth = input.authJson ? parseCodexAuthJson(input.authJson) : parseCodexAuthJson({ tokens: {
        access_token: input.accessToken,
        refresh_token: input.refreshToken || upstream.credentials.refreshToken,
        id_token: input.idToken || upstream.credentials.idToken,
        account_id: input.accountId || upstream.accountId
      }});
      upstream.accountId = auth.accountId || upstream.accountId;
      upstream.email = auth.email || upstream.email;
      upstream.accessTokenExpiresAt = auth.accessTokenExpiresAt;
      upstream.credentials = {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken || upstream.credentials.refreshToken,
        idToken: auth.idToken || upstream.credentials.idToken
      };
    }
  } else {
    if (input.projectId !== undefined) {
      upstream.projectId = text(input.projectId);
      if (!upstream.projectId) throw new Error('projectId cannot be empty');
    }
    if (input.projectKey !== undefined && text(input.projectKey)) upstream.credentials.projectKey = text(input.projectKey);
  }
  if (input.metadata !== undefined && typeof input.metadata === 'object') upstream.metadata = input.metadata;
  if (input.quotaSource !== undefined || input.metadata?.quota_type !== undefined || input.metadata?.quotaType !== undefined) {
    upstream.quotaSource = normalizeQuotaSource(input.quotaSource || input.metadata?.quota_type || input.metadata?.quotaType);
  }

  upstream.name = deriveUpstreamName(upstream.type, upstream);
  upstream.updatedAt = new Date().toISOString();
  return upstream;
}

function newSpending() {
  return {
    capCredits: 0,
    spentCredits: 0,
    spentCostMicros: 0,
    capStartedAt: null,
    settlements: {}
  };
}

export function ensureSpending(upstream) {
  upstream.spending ||= newSpending();
  upstream.spending.settlements ||= {};
  if (!upstream.spending.capStartedAt && upstream.spending.periodStartedAt) upstream.spending.capStartedAt = upstream.spending.periodStartedAt;
  if (!Number.isSafeInteger(upstream.spending.spentCostMicros)) {
    upstream.spending.spentCostMicros = Math.max(0, Math.round((Number(upstream.spending.spentCredits) || 0) * MICROS_PER_CREDIT));
  }
  pruneSettlements(upstream.spending);
  return upstream.spending;
}

export function spendingSummary(spending = {}) {
  const capCredits = Number(spending.capCredits) || 0;
  const spentCostMicros = Number.isSafeInteger(spending.spentCostMicros)
    ? Math.max(spending.spentCostMicros, 0)
    : Math.max(0, Math.round((Number(spending.spentCredits) || 0) * MICROS_PER_CREDIT));
  const spentCredits = microsToCredits(spentCostMicros);
  const percentUsed = capCredits > 0 ? (spentCredits / capCredits) * 100 : null;
  const status = capCredits <= 0 ? 'not_set' : spentCredits >= capCredits ? 'reached' : 'normal';

  const settlements = spending.settlements || {};
  let lastActivityAt = spending.lastActivityAt || null;
  for (const s of Object.values(settlements)) {
    if (s && s.startedAt) {
      if (!lastActivityAt || new Date(s.startedAt) > new Date(lastActivityAt)) {
        lastActivityAt = s.startedAt;
      }
    }
  }

  return {
    capCredits,
    capDollars: creditsToDollars(capCredits),
    spentCredits,
    spentDollars: creditsToDollars(spentCredits),
    spentCostMicros,
    remainingCredits: capCredits > 0 ? Math.max(capCredits - spentCredits, 0) : null,
    remainingDollars: capCredits > 0 ? Math.max(creditsToDollars(capCredits - spentCredits), 0) : null,
    percentUsed,
    status,
    routingStatus: status,
    continuationStatus: capCredits <= 0 ? 'spend_cap_unset' : spentCredits < capCredits * 1.25 ? 'allowed' : 'spend_cap_reached',
    capStartedAt: spending.capStartedAt || null,
    lastActivityAt,
    settlementCount: Object.keys(settlements).length
  };
}

export function setSpendingCap(upstream, capCredits) {
  const cap = number(capCredits, 'capCredits', { integer: true });
  upstream.spending = {
    capCredits: cap,
    spentCredits: 0,
    spentCostMicros: 0,
    capStartedAt: cap > 0 ? new Date().toISOString() : null,
    settlements: {}
  };
  upstream.updatedAt = new Date().toISOString();
}

export function recordUsage(upstream, input) {
  const attemptId = text(input.attemptId);
  if (!attemptId) throw new Error('attemptId is required');
  const costSource = text(input.costSource);
  if (!['upstream_reported', 'pricing_snapshot'].includes(costSource)) {
    throw new Error('costSource must be upstream_reported or pricing_snapshot');
  }
  const settledCostMicros = number(input.settledCostMicros, 'settledCostMicros', { integer: true });
  if (!Number.isSafeInteger(settledCostMicros)) throw new Error('settledCostMicros is too large');
  const startedAt = parseDate(input.startedAt, 'startedAt');
  const spending = upstream.spending;
  spending.settlements ||= {};
  const previous = Object.hasOwn(spending.settlements, attemptId) ? spending.settlements[attemptId] : null;
  const effectiveStartedAt = previous?.startedAt || startedAt.toISOString();
  const previousCostMicros = previous?.settledCostMicros || 0;
  const deltaMicros = settledCostMicros - previousCostMicros;
  const capStartedAt = spending.capStartedAt ? new Date(spending.capStartedAt) : null;
  const counted = Boolean(Number(spending.capCredits) > 0 && capStartedAt && new Date(effectiveStartedAt) >= capStartedAt);
  let appliedDeltaMicros = 0;

  if (counted) {
    const currentMicros = Number.isSafeInteger(spending.spentCostMicros)
      ? spending.spentCostMicros
      : Math.round((Number(spending.spentCredits) || 0) * MICROS_PER_CREDIT);
    spending.spentCostMicros = Math.max(0, currentMicros + deltaMicros);
    spending.spentCredits = microsToCredits(spending.spentCostMicros);
    appliedDeltaMicros = deltaMicros;
  }

  Object.defineProperty(spending.settlements, attemptId, {
    value: { settledCostMicros, startedAt: effectiveStartedAt, costSource },
    enumerable: true,
    configurable: true,
    writable: true
  });
  spending.lastActivityAt = effectiveStartedAt;
  pruneSettlements(spending);
  upstream.updatedAt = new Date().toISOString();
  return {
    attemptId,
    settledCostMicros,
    previousSettledCostMicros: previousCostMicros,
    deltaMicros,
    appliedDeltaMicros,
    counted
  };
}

function pruneSettlements(spending) {
  // ponytail: retain recent settlement IDs for duplicate delivery; use SQLite if this idempotency window is too short.
  const overflow = Object.entries(spending.settlements).sort(([, a], [, b]) => Date.parse(a.startedAt || 0) - Date.parse(b.startedAt || 0)).slice(0, Math.max(0, Object.keys(spending.settlements).length - SETTLEMENT_LIMIT));
  for (const [id] of overflow) delete spending.settlements[id];
}

function parseDate(value, label) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.valueOf())) throw new Error(`${label} must be a valid date`);
  return date;
}

export function spendingEligibility(upstream, continuation = false) {
  const spending = spendingSummary(upstream.spending);
  if (spending.capCredits <= 0) return { eligible: false, reason: 'spend_cap_unset', status: 'spend_cap_unset' };
  if (continuation && spending.spentCredits < spending.capCredits * 1.25) {
    return { eligible: true, reason: null, status: 'continuation_allowed' };
  }
  if (spending.spentCredits >= spending.capCredits) return { eligible: false, reason: 'spend_cap_reached', status: 'spend_cap_reached' };
  return { eligible: true, reason: null, status: 'normal' };
}

export function filterSpendCapEligible(upstreams, { continuationId = null } = {}) {
  const eligible = [];
  const exclusions = [];
  for (const upstream of upstreams) {
    const decision = spendingEligibility(upstream, upstream.id === continuationId);
    if (decision.eligible) eligible.push(upstream);
    else exclusions.push({ id: upstream.id, name: upstream.name, code: decision.reason, capCredits: spendingSummary(upstream.spending).capCredits });
  }
  const pinned = continuationId && exclusions.find((item) => item.id === continuationId && item.code === 'spend_cap_reached');
  if (pinned) {
    return {
      eligible: [],
      reserved: [],
      exclusions,
      error: { status: 503, code: 'pinned_continuation_spend_cap_reached', message: `${pinned.name || 'Upstream account'} reached its spending cap`, retryable: true, requiresNewUpstreamSession: false }
    };
  }
  if (eligible.length) return { eligible, reserved: [], exclusions, error: null };
  return {
    eligible: [],
    reserved: [],
    exclusions,
    error: { status: 503, code: 'no_eligible_backend', message: 'No upstream has an eligible spending cap', retryable: true }
  };
}

export function parseCodexQuota(payload, observedAt = new Date()) {
  const candidates = [];
  const rateLimitReached = payload?.rate_limit?.limit_reached === true;
  const addWindow = (window, source = 'primary', monthly = false) => {
    if (!window || typeof window !== 'object') return;
    // WHAM can omit usage percentages while still flagging the window as reached.
    const reportedUsedPercent = Number(window.used_percent);
    const usedPercent = Number.isFinite(reportedUsedPercent) ? reportedUsedPercent : (rateLimitReached ? 100 : NaN);
    if (!Number.isFinite(usedPercent)) return;
    const seconds = Number(window.limit_window_seconds);
    const remainingUnits = Number(window.remaining);
    const limitUnits = Number(window.limit);
    candidates.push({
      window,
      source,
      monthly,
      usedPercent: Math.max(0, Math.min(100, usedPercent)),
      remainingPercent: Number.isFinite(Number(window.remaining_percent)) ? Number(window.remaining_percent) : null,
      remainingUnits: Number.isFinite(remainingUnits) ? remainingUnits : null,
      limitUnits: Number.isFinite(limitUnits) ? limitUnits : null,
      seconds: Number.isFinite(seconds) ? seconds : 0
    });
  };
  const rateLimit = payload?.rate_limit;
  if (rateLimit && typeof rateLimit === 'object') {
    addWindow(rateLimit.primary_window || rateLimit.primary, 'primary');
    addWindow(rateLimit.secondary_window || rateLimit.secondary, 'secondary');
  }
  for (const item of Array.isArray(payload?.additional_rate_limits) ? payload.additional_rate_limits : []) {
    addWindow(item?.rate_limit?.primary_window || item?.rate_limit?.primary, item?.model || item?.limit_name || 'additional');
  }
  addWindow(payload?.spend_control?.individual_limit, 'spend_control', true);
  if (!candidates.length) throw new Error('Codex quota response had no usable quota window');

  const monthly = candidates.filter((candidate) => candidate.monthly || candidate.seconds >= MONTH_SECONDS);
  const selected = candidates.find((candidate) => candidate.source === 'spend_control')
    || [...(monthly.length ? monthly : candidates)].sort((a, b) => b.seconds - a.seconds)[0];
  const resetAt = resetTime(selected.window, observedAt);
  const balance = payload?.credits?.balance;
  const creditBalance = typeof balance === 'number' || (typeof balance === 'string' && balance.trim() !== '') ? Number(balance) : null;
  const remainingUnits = selected.remainingUnits ?? (Number.isFinite(creditBalance) ? creditBalance : null);
  const limitUnits = selected.limitUnits;
  return {
    label: selected.source === 'spend_control' ? 'Monthly usage' : (monthly.length ? 'Monthly quota' : 'Provider quota window'),
    usedPercent: selected.usedPercent,
    remainingPercent: selected.remainingPercent ?? Math.max(0, 100 - selected.usedPercent),
    remainingUnits,
    limitUnits,
    remainingDollars: selected.source === 'spend_control' && Number.isFinite(remainingUnits) ? creditsToDollars(remainingUnits) : null,
    limitDollars: selected.source === 'spend_control' && Number.isFinite(limitUnits) ? creditsToDollars(limitUnits) : null,
    windowSeconds: selected.seconds || null,
    resetAt,
    observedAt: new Date(observedAt).toISOString(),
    source: 'codex_usage_api'
  };
}

export function parseCompassQuota(payload, observedAt = new Date()) {
  const quota = payload?.data?.project?.quota_detail;
  const applied = typeof quota?.applied_balance === 'number' || (typeof quota?.applied_balance === 'string' && quota.applied_balance.trim() !== '') ? Number(quota.applied_balance) : NaN;
  const balance = typeof quota?.balance === 'number' || (typeof quota?.balance === 'string' && quota.balance.trim() !== '') ? Number(quota.balance) : NaN;
  if (payload?.retcode !== 0 || !Number.isFinite(applied) || applied <= 0 || !Number.isFinite(balance)) throw new Error('Compass quota response had no usable project balance');
  const usedPercent = Math.max(0, Math.min(100, ((applied - balance) / applied) * 100));
  const recurring = payload?.data?.project?.budget_type === 'recurring';
  const observed = new Date(observedAt);
  let resetAt = null;
  if (recurring) resetAt = new Date(Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth() + 1, 1)).toISOString();
  return {
    label: recurring ? 'Monthly project quota' : 'Project balance',
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    remainingUnits: balance,
    limitUnits: applied,
    remainingDollars: balance,
    limitDollars: applied,
    windowSeconds: recurring ? Math.round((new Date(resetAt) - new Date(Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth(), 1))) / 1000) : null,
    resetAt,
    observedAt: observed.toISOString(),
    source: 'compass_project_api'
  };
}

function publicTokenRefresh(value) {
  if (!value || !['succeeded', 'refreshing', 'failed', 'reauth_required'].includes(value.status)) return null;
  return {
    status: value.status,
    startedAt: value.startedAt || null,
    finishedAt: value.finishedAt || null,
    trigger: value.trigger || null,
    errorCode: value.errorCode || null,
    errorDetail: text(value.errorDetail) || null
  };
}

function resetTime(window, observedAt) {
  const explicit = window.reset_at ?? window.resets_at;
  if (typeof explicit === 'number' && explicit > 0) return new Date(explicit * 1000).toISOString();
  if (typeof explicit === 'string' && explicit.trim()) {
    const value = explicit.trim();
    if (/^\d+$/.test(value)) return new Date(Number(value) * 1000).toISOString();
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  const after = Number(window.reset_after_seconds);
  if (Number.isFinite(after) && after >= 0) return new Date(new Date(observedAt).getTime() + after * 1000).toISOString();
  return null;
}

export function isAiswitchUpstream(upstream) {
  return upstream?.type === 'compass' && normalizeQuotaSource(upstream.quotaSource || upstream.metadata?.quota_type || upstream.metadata?.quotaType) === 'aiswitch';
}

function normalizeQuotaSource(value) {
  const source = text(value).toLowerCase();
  if (source === 'aiswitch' || source === 'cqp') return 'aiswitch';
  if (source === 'compass') return 'compass';
  return null;
}

export function publicUpstream(upstream) {
  const spending = spendingSummary(upstream.spending);
  return {
    id: upstream.id,
    priority: Number.isInteger(upstream.priority) ? upstream.priority : null,
    type: upstream.type,
    name: deriveUpstreamName(upstream.type, upstream),
    accountId: upstream.accountId || null,
    email: text(upstream.email) || null,
    accessTokenExpiresAt: upstream.accessTokenExpiresAt || null,
    tokenRefresh: publicTokenRefresh(upstream.tokenRefresh),
    projectId: upstream.projectId || null,
    hasCredentials: Object.values(upstream.credentials || {}).some(Boolean),
    metadata: upstream.metadata && typeof upstream.metadata === 'object' ? upstream.metadata : null,
    quota: upstream.quota,
    quotaSource: isAiswitchUpstream(upstream) ? 'aiswitch' : upstream.quotaSource || null,
    spending,
    updatedAt: upstream.updatedAt || null,
    lastSuccessfulAt: upstream.lastSuccessfulAt || null,
    eligibility: spendingEligibility(upstream).status
  };
}

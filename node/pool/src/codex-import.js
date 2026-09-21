import { parseCodexAuthJson } from '../../src/domain.js';

export class CodexAuthImporter {
  constructor({ sharingStore, upstreamStore }) {
    this.sharingStore = sharingStore;
    this.upstreamStore = upstreamStore;
  }

  importAuthJson(authJson) {
    const normalizedAuthJson = normalizePastedAuthJson(authJson);
    const parsed = parseCodexAuthJson(normalizedAuthJson);
    if (!parsed.subject) throw new Error('Codex auth JSON is missing a stable subject');
    if (!parsed.email) throw new Error('Codex auth JSON is missing an email');
    const account = this.sharingStore.upsertAccount({ email: parsed.email, name: poolDisplayName(parsed.email) });
    let upstream = this.matchOwnedUpstream(account.id, parsed);
    if (upstream) {
      upstream = this.upstreamStore.update(upstream.id, { authJson: normalizedAuthJson });
    } else {
      upstream = this.upstreamStore.create(
        { type: 'codex', authJson: normalizedAuthJson },
        { allowDuplicateIdentity: true }
      );
    }
    if (!(Number(upstream.spending?.capDollars) > 0)) {
      this.upstreamStore.setCap(upstream.id, { capDollars: 1_000_000 });
    }
    const stored = this.upstreamStore.get(upstream.id);
    this.sharingStore.linkUpstream(account.id, upstream.id, stored?.scopeId || 'default');
    return { account, upstream };
  }

  matchOwnedUpstream(accountId, parsed) {
    const candidates = this.sharingStore.listAccountUpstreamLinks(accountId)
      .map(({ upstreamId }) => this.upstreamStore.get(upstreamId))
      .filter((upstream) => upstream?.type === 'codex');
    const matches = parsed.accountId
      ? candidates.filter((upstream) => upstream.accountId === parsed.accountId)
      : candidates.filter((upstream) => upstream.email === parsed.email);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const canonical = this.sharingStore.listCanonicalAccountUpstreamLinks(accountId, this.upstreamStore);
      return canonical
        .map(({ upstreamId }) => this.upstreamStore.get(upstreamId))
        .find((upstream) => upstream?.type === 'codex' && (
          parsed.accountId ? upstream.accountId === parsed.accountId : upstream.email === parsed.email
        )) || null;
    }
    return null;
  }

}

function normalizePastedAuthJson(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*```(?:json)?\s*$/i.test(line))
    .join('\n')
    .trim();
}

function poolDisplayName(email) {
  const local = typeof email === 'string' ? email.trim().split('@')[0] : '';
  return local || 'QuotaHub user';
}

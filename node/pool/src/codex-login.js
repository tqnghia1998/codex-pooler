import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodexAuthJson } from '../../src/domain.js';

const ANSI = /\x1b\[[0-9;]*m/g;
const DEVICE_URL = /https:\/\/auth\.openai\.com\/codex\/device/i;
const USER_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,8}\b/;

export class CodexLoginManager {
  constructor({
    sharingStore,
    upstreamStore,
    command = process.env.POOL_CODEX_CLI || 'codex',
    spawnImpl = spawn
  }) {
    this.sharingStore = sharingStore;
    this.upstreamStore = upstreamStore;
    this.command = command;
    this.spawnImpl = spawnImpl;
    this.running = new Map();
  }

  start() {
    const attempt = this.sharingStore.createCodexLoginAttempt();
    const home = mkdtempSync(join(tmpdir(), 'codex-pool-login-'));
    const child = this.spawnImpl(this.command, ['login', '--device-auth'], {
      env: { ...process.env, CODEX_HOME: home, NO_COLOR: '1', TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const state = { child, home, output: '', finished: false };
    this.running.set(attempt.login.id, state);
    const capture = (chunk) => this.capture(attempt.login.id, chunk);
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', () => this.finishFailed(attempt.login.id, 'codex_cli_unavailable'));
    child.once('exit', (code, signal) => {
      if (state.finished) return;
      if (code === 0) this.finishCompleted(attempt.login.id);
      else this.finishFailed(attempt.login.id, signal ? 'codex_login_cancelled' : 'codex_login_failed');
    });
    return attempt;
  }

  status(token) {
    return this.sharingStore.codexLoginAttemptByToken(token);
  }

  cancel(token) {
    const attempt = this.sharingStore.codexLoginAttemptByToken(token);
    if (!attempt) return null;
    const state = this.running.get(attempt.id);
    if (state && !state.finished) {
      state.finished = true;
      state.child.kill('SIGTERM');
      this.cleanup(attempt.id);
    }
    if (!['completed', 'failed', 'cancelled'].includes(attempt.status)) {
      return this.sharingStore.updateCodexLoginAttempt(attempt.id, { status: 'cancelled', errorCode: 'cancelled' });
    }
    return attempt;
  }

  importAuthJson(authJson) {
    const normalizedAuthJson = normalizePastedAuthJson(authJson);
    const parsed = parseCodexAuthJson(normalizedAuthJson);
    if (!parsed.subject) throw new Error('Codex auth JSON is missing a stable subject');
    const existingAccount = this.sharingStore.accountForCodexIdentity(parsed);
    let upstream = existingAccount
      ? this.matchOwnedUpstream(existingAccount.id, parsed)
      : null;
    if (upstream) {
      upstream = this.upstreamStore.update(upstream.id, { authJson: normalizedAuthJson });
    } else {
      upstream = this.upstreamStore.create(
        { type: 'codex', authJson: normalizedAuthJson },
        { allowDuplicateCodexIdentity: true }
      );
    }
    if (!(Number(upstream.spending?.capDollars) > 0)) {
      this.upstreamStore.setCap(upstream.id, { capDollars: 1_000_000 });
    }
    const stored = this.upstreamStore.get(upstream.id);
    const ownerId = this.sharingStore.accountIdForUpstream(upstream.id);
    const account = this.sharingStore.upsertCodexAccount({
      ...parsed,
      name: poolDisplayName(parsed.email)
    }, ownerId);
    this.sharingStore.linkUpstream(account.id, upstream.id, stored?.scopeId || 'default');
    return { account, upstream };
  }

  matchOwnedUpstream(accountId, parsed) {
    const candidates = this.sharingStore.listAccountUpstreamLinks(accountId)
      .map(({ upstreamId }) => this.upstreamStore.get(upstreamId))
      .filter((upstream) => upstream?.type === 'codex');
    if (candidates.length === 1) return candidates[0];
    if (!parsed.accountId) return null;
    const matches = candidates.filter((upstream) => upstream.accountId === parsed.accountId);
    return matches.length === 1 ? matches[0] : null;
  }

  capture(id, chunk) {
    const state = this.running.get(id);
    if (!state || state.finished) return;
    state.output = `${state.output}${String(chunk).replace(ANSI, '')}`.slice(-8_000);
    const url = state.output.match(DEVICE_URL)?.[0] || null;
    const code = state.output.match(USER_CODE)?.[0] || null;
    if (url || code) {
      this.sharingStore.updateCodexLoginAttempt(id, {
        status: 'waiting',
        verificationUrl: url || 'https://auth.openai.com/codex/device',
        userCode: code
      });
    }
  }

  finishCompleted(id) {
    const state = this.running.get(id);
    if (!state || state.finished) return;
    state.finished = true;
    try {
      const authPath = join(state.home, 'auth.json');
      if (!existsSync(authPath)) throw new Error('Codex login produced no auth.json');
      const authJson = readFileSync(authPath, 'utf8');
      const { account } = this.importAuthJson(authJson);
      this.sharingStore.updateCodexLoginAttempt(id, { accountId: account.id, status: 'completed', errorCode: null });
    } catch {
      this.sharingStore.updateCodexLoginAttempt(id, { status: 'failed', errorCode: 'codex_credentials_import_failed' });
    } finally {
      this.cleanup(id);
    }
  }

  finishFailed(id, errorCode) {
    const state = this.running.get(id);
    if (!state || state.finished) return;
    state.finished = true;
    this.sharingStore.updateCodexLoginAttempt(id, { status: 'failed', errorCode });
    this.cleanup(id);
  }

  cleanup(id) {
    const state = this.running.get(id);
    if (!state) return;
    this.running.delete(id);
    try {
      rmSync(state.home, { recursive: true, force: true });
    } catch {}
  }

  close() {
    for (const [id, state] of this.running) {
      state.finished = true;
      state.child.kill('SIGTERM');
      this.cleanup(id);
    }
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
  return local || 'Codex Pool user';
}

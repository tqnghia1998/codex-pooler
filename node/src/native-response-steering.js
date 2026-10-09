import { createHmac, randomUUID } from 'node:crypto';
import { HttpError } from './http-ingress.js';
import { beginNativeTurn, finishNativeTurn, nativeEventWritten, nativeTurnIdentity, nativeWriteStarted } from './native-turn-recovery.js';
import { isShareCredential, releaseShareRequest, reserveShareRequest } from './share-authorization.js';
import { extractUsage, mergeUsage } from './pricing.js';
import { classifySseEvent } from './upstream-outcomes.js';

const RESPONSE_ID = /^resp_[A-Za-z0-9_-]{1,1020}$/;
const TERMINALS = new Set(['response.completed', 'response.incomplete', 'response.failed', 'error']);

// One lane per producing socket. Provider control frames never become billable turns.
export class NativeResponseSteering {
  constructor({ store, req, authorize, admit, settle, pin }) {
    Object.assign(this, { store, req, authorize, admit, settle, pin });
    this.current = null;
    this.predecessor = null;
    this.pending = new Map();
    this.acceptedIds = new Set();
    this.leases = new Set();
    this.accepted = false;
    this.closed = false;
  }

  dispatch(payload, upstream) {
    if (this.closed) throw new HttpError(409, 'native_lane_closed', 'The native connection is no longer available');
    if (payload.type === 'response.steer') {
      if (this.authorize()) throw new HttpError(403, 'access_denied', 'The native connection is no longer authorized');
      if (!RESPONSE_ID.test(payload.previous_response_id || '') || !Array.isArray(payload.input)) {
        throw new HttpError(400, 'invalid_request', 'Invalid response.steer frame');
      }
      if (!this.current && !this.predecessor) throw new HttpError(409, 'response_not_found', 'No response was produced on this connection');
      if ([...this.pending.values()].reduce((total, count) => total + count, 0) >= 128) {
        throw new HttpError(429, 'steering_queue_full', 'Too many pending steering controls');
      }
      this.pending.set(payload.previous_response_id, (this.pending.get(payload.previous_response_id) || 0) + 1);
      return;
    }
    if (payload.type !== 'response.create') return;
    if (this.current || this.accepted) throw new HttpError(409, 'duplicate_turn', 'An earlier native turn is still active');
    this.accepted = false;
    this.pending.clear();
    this.acceptedIds.clear();
    const identity = nativeTurnIdentity(this.store, this.req, payload);
    this.current = this.open(payload, upstream, identity);
    this.predecessor = null;
  }

  open(payload, upstream, identity) {
    if (this.authorize()) throw new HttpError(403, 'access_denied', 'The native connection is no longer authorized');
    const latest = this.store.get(upstream.id, this.req.proxyAuth?.scopeId);
    if (!latest || latest.nativeRecoveryEpoch !== upstream.nativeRecoveryEpoch || !this.admit(payload, latest)) {
      throw new HttpError(403, 'upstream_unavailable', 'The producing account is no longer eligible');
    }
    this.store.assertCodexCapacity(upstream.id, payload.model);
    const admission = this.store.beginUpstreamAttempt(upstream.id, {
      model: payload.model || '', routeClass: 'raw_native', ignoreQuotaCooldown: Boolean(this.req.ignoreQuotaCooldown)
    });
    if (!admission) throw new HttpError(403, 'upstream_unavailable', 'The producing account is no longer eligible');
    const attempt = { id: randomUUID(), startedAt: new Date().toISOString() };
    let lease;
    let lifecycle;
    try {
      if (identity) lease = beginNativeTurn(this.store, identity, payload, latest);
      if (!reserveShareRequest(this.req, attempt.id, { model: payload.model, route: this.req.url.split('?')[0] })) {
        throw new HttpError(429, 'share_session_exhausted', 'The share session quota is exhausted');
      }
      if (!isShareCredential(this.req.proxyAuth) && this.req.proxyAuth?.id) {
        lifecycle = this.store.reserveGatewayRequest({
          scopeId: this.req.proxyAuth.scopeId, apiKeyId: this.req.proxyAuth.id,
          endpoint: this.req.url.split('?')[0], model: payload.model || '', transport: 'websocket'
        });
        Object.assign(attempt, this.store.beginGatewayAttempt(lifecycle.id, upstream.id));
      }
      if (lease) this.leases.add(lease);
      return { payload, upstream: { ...latest }, admission, attempt, lifecycle, lease, identity, usage: null, responseId: null, success: false, servedModel: null };
    } catch (error) {
      finishNativeTurn(lease, 'failed');
      releaseShareRequest(this.req, attempt.id, error.code || 'native_admission_failed');
      this.store.settleUpstreamAttempt(upstream.id, admission, { class: 'neutral', retryable: false });
      throw error;
    }
  }

  event(event, upstream) {
    if (this.closed) return null;
    if (event?.type === 'response.steer.accepted' || event?.type === 'response.steer.failed') {
      const id = event.steer?.previous_response_id;
      const count = this.pending.get(id) || 0;
      if (count) {
        if (count === 1) this.pending.delete(id); else this.pending.set(id, count - 1);
        const producer = this.current || this.predecessor;
        const steerId = event.steer?.id;
        if (event.type === 'response.steer.accepted' && producer?.responseId === id
          && typeof steerId === 'string' && this.acceptedIds.size < 64 && !this.acceptedIds.has(steerId)) {
          this.acceptedIds.add(steerId);
          this.accepted = true;
        }
      }
      return null;
    }
    if (event?.type === 'response.created') {
      const id = event.response?.id;
      if (!this.current) {
        const prior = this.predecessor;
        if (!this.accepted || !prior?.success || !RESPONSE_ID.test(id || '') || id === prior.responseId) {
          throw new HttpError(409, 'unexpected_native_successor', 'An unadmitted native response was received');
        }
        const payload = { ...prior.payload, previous_response_id: prior.responseId };
        const digest = createHmac('sha256', this.store.key).update('native-steering-v1\0')
          .update(JSON.stringify([prior.attempt.id, id])).digest('hex');
        const identity = { key: digest, optionSeal: digest, inputSeal: digest, inputLength: 0, kind: 'turn', scopeId: this.req.proxyAuth?.scopeId };
        this.current = this.open(payload, prior.upstream, identity);
        this.accepted = false;
        this.acceptedIds.clear();
      } else if (this.current.responseId && this.current.responseId !== id) {
        throw new HttpError(409, 'unexpected_native_successor', 'The preceding native response has not terminated');
      }
      this.current.responseId = id;
    }
    const turn = this.current;
    if (!turn) return null;
    if (typeof event?.response?.model === 'string') turn.servedModel = event.response.model;
    const responseId = event?.response?.id;
    if (responseId && turn.responseId && responseId !== turn.responseId) {
      throw new HttpError(409, 'native_response_mismatch', 'The native response does not match the active turn');
    }
    turn.usage = mergeUsage(turn.usage, extractUsage(event));
    if (TERMINALS.has(event?.type)) {
      const outcome = classifySseEvent(event);
      turn.success = ['response.completed', 'response.incomplete'].includes(event.type) && outcome.class === 'success';
      this.store.settleUpstreamAttempt(upstream.id, turn.admission, outcome);
      if (turn.success) {
        this.settle(turn);
        this.pin(event.response, upstream.id);
      } else {
        releaseShareRequest(this.req, turn.attempt.id, outcome.errorCode || 'upstream_response_failed');
        if (turn.lifecycle) this.store.finalizeGatewayRequest({
          requestId: turn.lifecycle.id, attemptId: turn.attempt.id, status: 'failed',
          errorCode: outcome.errorCode || 'upstream_response_failed'
        });
      }
      this.current = null;
      this.predecessor = turn;
      if (!turn.success) this.accepted = false;
    }
    return turn;
  }

  async deliver(turn, event, write) {
    if (turn?.lease) nativeWriteStarted(turn.lease);
    try {
      await this.store.flushDurability();
      await write();
      if (turn?.lease) nativeEventWritten(turn.lease, event);
      await this.store.flushDurability();
    } catch (error) {
      finishNativeTurn(turn?.lease);
      throw error;
    } finally {
      if (turn?.lease?.finished) this.leases.delete(turn.lease);
    }
  }

  close(code = 'downstream_closed', outcome = { class: 'neutral', retryable: false }) {
    if (this.closed) return;
    this.closed = true;
    const turn = this.current;
    if (turn) {
      try { this.store.settleUpstreamAttempt(turn.upstream.id, turn.admission, outcome); } catch {}
      releaseShareRequest(this.req, turn.attempt.id, code);
      if (turn.lifecycle) this.store.finalizeGatewayRequest({
        requestId: turn.lifecycle.id, attemptId: turn.attempt.id, status: 'failed', errorCode: code
      });
      finishNativeTurn(turn.lease);
    }
    for (const lease of this.leases) finishNativeTurn(lease);
    this.leases.clear();
    this.current = null;
    this.pending.clear();
  }
}

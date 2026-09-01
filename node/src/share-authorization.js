export function shareSessionDenial(auth) {
  if (auth?.kind === 'personal_share') {
    if (auth.activeSessionCount > 0 && auth.remainingMicros > 0) return null;
    if (auth.providerReauthRequired) return null;
    return { code: 'personal_key_exhausted', message: 'No active share sessions are available for this personal key' };
  }
  if (auth?.kind !== 'share_session') return null;
  if (auth.providerSharingStatus === 'paused') {
    return { code: 'share_provider_paused', message: 'The provider paused sharing from this Codex account' };
  }
  if (auth.sessionStatus === 'paused') return { code: 'share_session_paused', message: 'The share session is paused' };
  if (auth.sessionStatus === 'revoked') return { code: 'share_session_revoked', message: 'The share session is revoked' };
  if (auth.sessionStatus === 'expired') return { code: 'share_session_expired', message: 'The share session expired' };
  if (auth.sessionStatus !== 'active' || auth.remainingMicros <= 0) {
    return { code: 'share_session_exhausted', message: 'The share session quota is exhausted' };
  }
  return null;
}

export function isShareCredential(auth) {
  return auth?.kind === 'share_session' || auth?.kind === 'personal_share';
}

export function personalShareSessions(req, { sessionId = '', responseId = '' } = {}) {
  if (req.proxyAuth?.kind !== 'personal_share') return [];
  return req.sharingStore?.personalShareSessionCandidates(req.proxyAuth.personalKeyId, { sessionId, responseId }, req.upstreamStore) || [];
}

export function selectPersonalShareSession(req, upstreamId, { affinityId = '', allowReselect = false } = {}) {
  if (req.proxyAuth?.kind !== 'personal_share') return true;
  if (req.proxyAuth.shareSessionId && !allowReselect) return req.proxyAuth.upstreamId === upstreamId;
  const session = (req.personalShareSessions || personalShareSessions(req, { sessionId: affinityId }))
    .find((candidate) => candidate.upstreamId === upstreamId);
  if (!session) return false;
  const selected = req.sharingStore?.selectPersonalShareSession(req.proxyAuth.personalKeyId, session.shareSessionId, { affinityId }, req.upstreamStore);
  if (!selected) return false;
  req.proxyAuth = { ...req.proxyAuth, ...selected, kind: 'personal_share' };
  return true;
}

export function reserveShareRequest(req, attemptId, { model = '', route = '' } = {}) {
  if (!isShareCredential(req.proxyAuth)) return true;
  const sessionId = req.proxyAuth.shareSessionId;
  if (!sessionId) return false;
  return Boolean(req.sharingStore?.reserveSession(sessionId, attemptId, {
    keyId: req.proxyAuth.kind === 'personal_share' ? req.proxyAuth.personalKeyId : null,
    model,
    route,
    upstreamStore: req.upstreamStore
  }));
}

export function releaseShareRequest(req, attemptId, errorCode = 'request_failed') {
  if (!isShareCredential(req.proxyAuth) || !attemptId) return false;
  return Boolean(req.sharingStore?.releaseReservation(attemptId, errorCode));
}

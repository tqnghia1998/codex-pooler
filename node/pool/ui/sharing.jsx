import React, { useCallback, useEffect, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading, Text } from '@astryxdesign/core/Text';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from '@astryxdesign/core/Layout';

const SHARING_VIEWS = new Set([
  'community-offers',
  'my-offers',
  'sent-requests',
  'approvals',
  'my-access',
  'shared-by-me'
]);
const SHARING_VIEW_STORAGE_KEY = 'codex_pool_sharing_view';

function initialSharingView() {
  try {
    const stored = window.localStorage.getItem(SHARING_VIEW_STORAGE_KEY);
    return SHARING_VIEWS.has(stored) ? stored : 'community-offers';
  } catch {
    return 'community-offers';
  }
}

function csrfToken() {
  for (const item of document.cookie.split(';')) {
    const [name, ...parts] = item.trim().split('=');
    if (name !== 'codex_pool_csrf') continue;
    try { return decodeURIComponent(parts.join('=')); } catch { return ''; }
  }
  return '';
}

function useSharingApi() {
  return useCallback(async (path, options = {}) => {
    const method = options.method || 'GET';
    const response = await fetch(path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'x-csrf-token': csrfToken() } : {}),
        ...(options.headers || {})
      }
    });
    const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error?.message || 'Request failed');
      error.status = response.status;
      error.code = body.error?.code;
      throw error;
    }
    return body;
  }, []);
}

export function SharingWorkspace({ onNotice }) {
  const api = useSharingApi();
  const [account, setAccount] = useState(null);
  const [view, setView] = useState(initialSharingView);
  const [offers, setOffers] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [upstreams, setUpstreams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [offerDialog, setOfferDialog] = useState(null);
  const [ticketDialog, setTicketDialog] = useState(null);
  const [sessionDialog, setSessionDialog] = useState(null);
  const [keyDialog, setKeyDialog] = useState(null);
  const [login, setLogin] = useState(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [authJsonDialog, setAuthJsonDialog] = useState(false);
  const [authJson, setAuthJson] = useState('');
  const [authJsonLoading, setAuthJsonLoading] = useState(false);
  const [quotaRefreshing, setQuotaRefreshing] = useState(false);

  const load = useCallback(async ({ background = false } = {}) => {
    if (!background) setLoading(true);
    try {
      const me = await api('/api/pool/me');
      setAccount(me.account);
      const [offerData, ticketData, sessionData, upstreamData] = await Promise.all([
        api('/api/pool/offers'),
        api('/api/pool/tickets'),
        api('/api/pool/sessions'),
        api('/api/pool/upstreams')
      ]);
      setOffers(offerData.offers || []);
      setTickets(ticketData.tickets || []);
      setSessions(sessionData.sessions || []);
      setUpstreams(upstreamData.upstreams || []);
    } catch (nextError) {
      if (nextError.status === 401) {
        setAccount(null);
        try {
          const data = await api('/auth/codex/status');
          setLogin(data.login);
          if (data.login.status === 'completed') {
          onNotice('Signed in with Codex');
          await load();
        }
      } catch {}
      } else if (!background) onNotice(nextError.message, true);
    } finally {
      if (!background) setLoading(false);
    }
  }, [api, onNotice]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SHARING_VIEW_STORAGE_KEY, view);
    } catch {}
  }, [view]);

  useEffect(() => {
    if (!account) return undefined;
    const timer = window.setInterval(() => {
      if (!document.hidden) void load({ background: true });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [account, load]);

  useEffect(() => {
    if (!login || ['completed', 'failed', 'cancelled'].includes(login.status)) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const data = await api('/auth/codex/status');
        setLogin(data.login);
        if (data.login.status === 'completed') {
          onNotice('Signed in with Codex');
          await load();
        }
      } catch (nextError) {
        onNotice(nextError.message, true);
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [api, load, login, onNotice]);

  const mutate = useCallback(async (operation, message) => {
    try {
      await operation();
      if (message) onNotice(message);
      await load();
    } catch (nextError) {
      onNotice(nextError.message, true);
    }
  }, [load, onNotice]);

  const startCodexLogin = async () => {
    setLoginLoading(true);
    try {
      const data = await api('/auth/codex/start', { method: 'POST', body: '{}' });
      setLogin(data.login);
    } catch (nextError) {
      onNotice(nextError.message, true);
    } finally {
      setLoginLoading(false);
    }
  };

  const importAuthJson = async () => {
    if (!authJson.trim()) return;
    setAuthJsonLoading(true);
    try {
      await api('/auth/codex/import', {
        method: 'POST',
        body: JSON.stringify({ authJson })
      });
      setAuthJson('');
      setAuthJsonDialog(false);
      setLogin(null);
      onNotice('Signed in from auth.json');
      await load();
    } catch (nextError) {
      onNotice(nextError.message, true);
    } finally {
      setAuthJsonLoading(false);
    }
  };

  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST', body: '{}' });
    } catch {}
    setAccount(null);
    setOffers([]);
    setTickets([]);
    setSessions([]);
    setUpstreams([]);
    setLogin(null);
  };

  const refreshQuota = async () => {
    if (!upstreams.length) return;
    setQuotaRefreshing(true);
    try {
      await Promise.all(upstreams.map((upstream) => api(`/api/pool/upstreams/${upstream.id}/refresh-quota`, {
        method: 'POST',
        body: '{}'
      })));
      onNotice('Codex quota refreshed');
      await load();
    } catch (nextError) {
      onNotice(nextError.message, true);
    } finally {
      setQuotaRefreshing(false);
    }
  };

  if (loading && !account && !login) {
    return <Card variant="muted"><Text color="secondary">Loading sharing workspace...</Text></Card>;
  }

  if (!account) {
    return <VStack gap={3}>
      <Card>
        <HStack justify="between" vAlign="center" gap={3} wrap="wrap">
          <VStack gap={1}>
            <Heading level={2}>Quota sharing</Heading>
            <Text type="supporting" color="secondary">Sign in with Codex to publish quota, request access, and manage share sessions.</Text>
          </VStack>
          {!login && (
            <HStack gap={2} wrap="wrap">
              <Button label="Login with Codex" variant="primary" isLoading={loginLoading} onClick={() => void startCodexLogin()} />
              <Button
                label="Login with auth.json"
                variant="secondary"
                onClick={() => {
                  setAuthJsonDialog(true);
                }}
              />
            </HStack>
          )}
        </HStack>
      </Card>
      {login && <CodexLoginCard login={login} onRetry={() => void startCodexLogin()} onCancel={async () => {
        try {
          await api('/auth/codex/login', { method: 'DELETE' });
          setLogin(null);
          onNotice('Codex sign-in cancelled');
        } catch (nextError) {
          onNotice(nextError.message, true);
        }
      }} />}
      <AuthJsonLoginDialog
        isOpen={authJsonDialog}
        value={authJson}
        isLoading={authJsonLoading}
        onChange={setAuthJson}
        onClose={() => {
          if (authJsonLoading) return;
          setAuthJsonDialog(false);
          setAuthJson('');
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void importAuthJson();
        }}
      />
    </VStack>;
  }

  const offerableUpstreams = upstreams.filter((upstream) => !providerQuotaExhausted(upstream.quota));
  const myOffers = offers.filter((offer) => offer.isProvider);
  const sentTickets = tickets.filter((ticket) => ticket.direction === 'sent');
  const receivedTickets = tickets.filter((ticket) => ticket.direction === 'received');
  const pendingSentTicketCount = sentTickets.filter((ticket) => ticket.status === 'pending').length;
  const pendingReceivedTicketCount = receivedTickets.filter((ticket) => ticket.status === 'pending').length;
  const requestedSessions = sessions.filter((session) => session.role === 'consumer');
  const sharingSessions = sessions.filter((session) => session.role === 'provider');
  const activeRequestedSessionCount = requestedSessions.filter((session) => session.status !== 'revoked').length;
  const activeSharingSessionCount = sharingSessions.filter((session) => session.status !== 'revoked').length;
  const hiddenCommunityOfferIds = new Set(sentTickets
    .filter((ticket) => ticket.status !== 'rejected')
    .map((ticket) => ticket.offerId));
  const communityOffers = offers.filter((offer) => !offer.isProvider && !hiddenCommunityOfferIds.has(offer.id));

  return (
    <VStack gap={3}>
      <HStack justify="between" vAlign="center" gap={3} wrap="wrap">
        <VStack gap={1}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Heading level={2}>Quota sharing</Heading>
            <Badge label={accountLabel(account)} variant="neutral" />
          </HStack>
        </VStack>
        <HStack gap={2} wrap="wrap">
          <Button label="Sign out" variant="secondary" onClick={() => void logout()} />
        </HStack>
      </HStack>

      <QuotaOverview
        upstreams={upstreams}
        isRefreshing={quotaRefreshing}
        onRefresh={() => void refreshQuota()}
      />
      <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
        <TabList value={view} onChange={setView} hasDivider aria-label="Sharing workspace">
          <Tab value="community-offers" label={`Community offers (${communityOffers.length})`} />
          <Tab value="my-offers" label={`My offers (${myOffers.length})`} />
          <Tab value="sent-requests" label={`Sent requests (${pendingSentTicketCount})`} />
          <Tab value="approvals" label={`Approvals (${pendingReceivedTicketCount})`} />
          <Tab value="my-access" label={`My access (${activeRequestedSessionCount})`} />
          <Tab value="shared-by-me" label={`Shared by me (${activeSharingSessionCount})`} />
        </TabList>
        {view === 'my-offers' && offerableUpstreams.length > 0 && (
          <Button label="Publish offer" variant="primary" onClick={() => setOfferDialog({ upstreamId: offerableUpstreams[0].id, quotaDollars: 10 })} />
        )}
      </HStack>

      {view === 'community-offers' && (
        <OffersView
          offers={communityOffers}
          upstreams={upstreams}
          requestedOfferIds={hiddenCommunityOfferIds}
          emptyTitle="No community offers"
          emptyDescription="Offers from other Codex Pool members will appear here."
          onRequest={(offer) => void mutate(async () => {
            await api('/api/pool/tickets', {
              method: 'POST',
              body: JSON.stringify({ offerId: offer.id })
            });
          }, `Requested $${money(offer.availableDollars)} quota`)}
          onEdit={(offer) => setOfferDialog({ offer, upstreamId: offer.upstream.id, quotaDollars: offer.quotaDollars, status: offer.status })}
        />
      )}
      {view === 'my-offers' && (
        <OffersView
          offers={myOffers}
          emptyTitle="No offers yet"
          emptyDescription={upstreams.length ? 'Publish an offer to share quota with the community.' : 'Your Codex account has no available upstream.'}
          onEdit={(offer) => setOfferDialog({ offer, upstreamId: offer.upstream.id, quotaDollars: offer.quotaDollars, status: offer.status })}
        />
      )}
      {view === 'sent-requests' && (
        <TicketsView
          tickets={sentTickets}
          emptyTitle="No sent requests"
          emptyDescription="Quota requests you send will appear here."
          onCancel={(ticket) => void mutate(() => api(`/api/pool/tickets/${ticket.id}/cancel`, { method: 'POST', body: '{}' }), 'Ticket cancelled')}
        />
      )}
      {view === 'approvals' && (
        <TicketsView
          tickets={receivedTickets}
          emptyTitle="No requests to approve"
          emptyDescription="Requests for your offered quota will appear here."
          onApprove={(ticket) => setTicketDialog({ ticket, quotaDollars: ticket.requestedQuotaDollars, approval: true })}
          onReject={(ticket) => void mutate(() => api(`/api/pool/tickets/${ticket.id}/reject`, { method: 'POST', body: '{}' }), 'Ticket rejected')}
          onCancel={(ticket) => void mutate(() => api(`/api/pool/tickets/${ticket.id}/cancel`, { method: 'POST', body: '{}' }), 'Ticket cancelled')}
        />
      )}
      {view === 'my-access' && (
        <SessionsView
          sessions={requestedSessions}
          emptyTitle="No shared access"
          emptyDescription="Approved requests will create a share session here."
          onEdit={(session) => setSessionDialog({ session, quotaDollars: session.grantedQuotaDollars })}
          onStatus={(session, status) => void mutate(
            () => api(`/api/pool/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
            status === 'active' ? 'Session resumed' : 'Session paused'
          )}
          onRevoke={(session) => void mutate(
            () => api(`/api/pool/sessions/${session.id}/revoke`, { method: 'POST', body: '{}' }),
            'Session revoked'
          )}
          onReveal={async (session) => {
            try {
              const data = await api(`/api/pool/sessions/${session.id}/reveal-key`, { method: 'POST', body: '{}' });
              setKeyDialog({ session, apiKey: data.apiKey });
              await load();
            } catch (nextError) {
              onNotice(nextError.message, true);
            }
          }}
          onRotate={async (session) => {
            try {
              const data = await api(`/api/pool/sessions/${session.id}/rotate-key`, { method: 'POST', body: '{}' });
              setKeyDialog({ session, apiKey: data.apiKey });
              await load();
            } catch (nextError) {
              onNotice(nextError.message, true);
            }
          }}
        />
      )}
      {view === 'shared-by-me' && (
        <SessionsView
          sessions={sharingSessions}
          emptyTitle="No active shares"
          emptyDescription="Sessions you approve for other members will appear here."
          onEdit={(session) => setSessionDialog({ session, quotaDollars: session.grantedQuotaDollars })}
          onStatus={(session, status) => void mutate(
            () => api(`/api/pool/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
            status === 'active' ? 'Session resumed' : 'Session paused'
          )}
          onRevoke={(session) => void mutate(
            () => api(`/api/pool/sessions/${session.id}/revoke`, { method: 'POST', body: '{}' }),
            'Session revoked'
          )}
          onReveal={async (session) => {
            try {
              const data = await api(`/api/pool/sessions/${session.id}/reveal-key`, { method: 'POST', body: '{}' });
              setKeyDialog({ session, apiKey: data.apiKey });
              await load();
            } catch (nextError) {
              onNotice(nextError.message, true);
            }
          }}
          onRotate={async (session) => {
            try {
              const data = await api(`/api/pool/sessions/${session.id}/rotate-key`, { method: 'POST', body: '{}' });
              setKeyDialog({ session, apiKey: data.apiKey });
              await load();
            } catch (nextError) {
              onNotice(nextError.message, true);
            }
          }}
        />
      )}

      <OfferDialog
        value={offerDialog}
        upstreams={upstreams}
        onClose={() => setOfferDialog(null)}
        onSave={(value) => void mutate(async () => {
          const path = value.offer ? `/api/pool/offers/${value.offer.id}` : '/api/pool/offers';
          const method = value.offer ? 'PATCH' : 'POST';
          await api(path, {
            method,
            body: JSON.stringify({
              ...(!value.offer ? { upstreamId: value.upstreamId } : {}),
              quotaDollars: value.quotaDollars,
              ...(value.offer ? { status: value.status } : {})
            })
          });
          setOfferDialog(null);
        }, value.offer ? 'Offer updated' : 'Offer published')}
        onChange={setOfferDialog}
      />
      <TicketDialog
        value={ticketDialog}
        onClose={() => setTicketDialog(null)}
        onChange={setTicketDialog}
        onSave={(value) => void mutate(async () => {
          if (value.approval) {
            await api(`/api/pool/tickets/${value.ticket.id}/approve`, {
              method: 'POST',
              body: JSON.stringify({ quotaDollars: value.quotaDollars })
            });
          }
          setTicketDialog(null);
        }, 'Ticket approved')}
      />
      <SessionDialog
        value={sessionDialog}
        onClose={() => setSessionDialog(null)}
        onChange={setSessionDialog}
        onSave={(value) => void mutate(async () => {
          await api(`/api/pool/sessions/${value.session.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ quotaDollars: value.quotaDollars })
          });
          setSessionDialog(null);
        }, 'Session quota updated')}
      />
      <KeyDialog value={keyDialog} onClose={() => setKeyDialog(null)} onNotice={onNotice} />
    </VStack>
  );
}

function QuotaOverview({ upstreams, isRefreshing, onRefresh }) {
  if (!upstreams.length) {
    return <Banner
      title="Codex quota unavailable"
      description="Sign in again with a Codex account to load the quota you can share."
      status="warning"
    />;
  }
  return (
    <Card variant="muted">
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <VStack gap={1}>
            <Heading level={3}>Your Codex quota</Heading>
            <Text type="supporting" color="secondary">Provider usage is refreshed automatically every minute.</Text>
          </VStack>
          <Button label="Refresh quota" size="sm" variant="secondary" isLoading={isRefreshing} onClick={onRefresh} />
        </HStack>
        <Grid columns={{ minWidth: 220, max: 3, repeat: 'fit' }} gap={2}>
          {upstreams.map((upstream) => <QuotaCard key={upstream.id} upstream={upstream} />)}
        </Grid>
      </VStack>
    </Card>
  );
}

function QuotaCard({ upstream }) {
  const quota = upstream.quota;
  const percentage = Number.isFinite(quota?.remainingPercent) ? Math.max(0, Math.min(100, quota.remainingPercent)) : null;
  return (
    <Card>
      <VStack gap={2}>
        <VStack gap={1}>
          <Text weight="bold">{upstream.name}</Text>
          <Text type="supporting" color="secondary">{quota?.label || 'Waiting for provider quota'}</Text>
        </VStack>
        <Text weight="bold">{quotaRemaining(quota)}</Text>
        {percentage !== null && <ProgressBar value={percentage} max={100} />}
        <Text type="supporting" color="secondary">{quotaReset(quota)}</Text>
        {quota?.observedAt && <Text type="supporting" color="secondary">Updated {dateTime(quota.observedAt)}</Text>}
      </VStack>
    </Card>
  );
}

function OffersView({ offers, requestedOfferIds, emptyTitle, emptyDescription, onRequest, onEdit }) {
  if (!offers.length) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <Grid columns={{ minWidth: 280, max: 4, repeat: 'fit' }} gap={3}>
      {offers.map((offer) => (
        <Card key={offer.id}>
          <VStack gap={3}>
            <HStack justify="between" vAlign="start" gap={2}>
              <VStack gap={1}>
                <Heading level={3}>{accountLabel(offer.provider)}</Heading>
                <Text type="supporting" color="secondary">Codex quota offer</Text>
              </VStack>
              <HStack gap={1} wrap="wrap">
                {!offer.isUsable && <Badge label="unusable" variant="error" />}
                <Badge label={offer.status} variant={offer.status === 'active' ? 'green' : 'neutral'} />
              </HStack>
            </HStack>
            <VStack gap={1}>
              <HStack justify="between"><Text weight="bold">${money(offer.availableDollars)} available</Text><Text type="supporting" color="secondary">of ${money(offer.quotaDollars)}</Text></HStack>
              <ProgressBar value={offer.quotaDollars > 0 ? offer.availableDollars / offer.quotaDollars * 100 : 0} max={100} />
            </VStack>
            <Text type="supporting" color="secondary">{providerQuota(offer.upstream.quota)}</Text>
            {!offer.isUsable && <Banner title="Offer unavailable" description={offer.unusableReason} status="error" />}
            <HStack justify="end" gap={2}>
              {offer.isProvider
                ? <Button label="Edit" size="sm" variant="secondary" onClick={() => onEdit(offer)} />
                : requestedOfferIds.has(offer.id)
                  ? <Button label="Requested" size="sm" variant="secondary" isDisabled />
                  : <Button label="Request quota" size="sm" variant="primary" isDisabled={offer.status !== 'active' || !offer.isUsable || offer.availableDollars <= 0 || providerQuotaExhausted(offer.upstream?.quota)} onClick={() => onRequest(offer)} />}
            </HStack>
          </VStack>
        </Card>
      ))}
    </Grid>
  );
}

function TicketsView({ tickets, emptyTitle, emptyDescription, onApprove, onReject, onCancel }) {
  if (!tickets.length) return <EmptyState title={emptyTitle} description={emptyDescription} />;
  return (
    <VStack gap={2}>
      {tickets.map((ticket) => (
        <Card key={ticket.id} variant="muted">
          <HStack justify="between" vAlign="center" gap={3} wrap="wrap">
            <VStack gap={1}>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Text weight="bold">{accountLabel(ticket.direction === 'received' ? ticket.consumer : ticket.provider)}</Text>
                <Badge label={ticket.direction} variant="neutral" />
                <Badge label={ticket.status} variant={ticket.status === 'pending' ? 'warning' : ticket.status === 'approved' ? 'green' : 'neutral'} />
              </HStack>
              <Text type="supporting" color="secondary">
                ${money(ticket.requestedQuotaDollars)} requested{ticket.approvedQuotaDollars !== null ? `, $${money(ticket.approvedQuotaDollars)} approved` : ''} · {ticket.upstream?.name || 'Unavailable upstream'}
              </Text>
            </VStack>
            {ticket.status === 'pending' && (
              <HStack gap={2}>
                {ticket.direction === 'received' ? (
                  <>
                    <Button label="Reject" size="sm" variant="secondary" onClick={() => onReject(ticket)} />
                    <Button label="Approve" size="sm" variant="primary" onClick={() => onApprove(ticket)} />
                  </>
                ) : <Button label="Cancel" size="sm" variant="secondary" onClick={() => onCancel(ticket)} />}
              </HStack>
            )}
          </HStack>
        </Card>
      ))}
    </VStack>
  );
}

function SessionsView({ sessions, emptyTitle, emptyDescription, onEdit, onStatus, onRevoke, onReveal, onRotate }) {
  if (!sessions.length) return <EmptyState title={emptyTitle} description={emptyDescription} />;
  return (
    <Grid columns={{ minWidth: 300, max: 3, repeat: 'fit' }} gap={3}>
      {sessions.map((session) => {
        const remainingPercent = session.grantedQuotaDollars > 0
          ? Math.min(100, session.remainingQuotaDollars / session.grantedQuotaDollars * 100)
          : 0;
        const quotaVariant = session.status === 'active'
          ? 'success'
          : session.status === 'paused'
            ? 'warning'
            : session.status === 'exhausted'
              ? 'error'
              : 'neutral';
        return (
          <Card key={session.id}>
            <VStack gap={3}>
              <HStack justify="between" vAlign="start" gap={2}>
                <VStack gap={1}>
                  <Heading level={3}>{accountLabel(session.role === 'provider' ? session.consumer : session.provider)}</Heading>
                  <Text type="supporting" color="secondary">Codex share session</Text>
                </VStack>
                <Badge label={session.status} variant={session.status === 'active' ? 'green' : session.status === 'exhausted' ? 'warning' : 'neutral'} />
              </HStack>
              <VStack gap={1}>
                <HStack justify="between">
                  <Text weight="bold">${money(session.remainingQuotaDollars)} left</Text>
                  <Text type="supporting" color="secondary">${money(session.consumedQuotaDollars)} used</Text>
                </HStack>
                <ProgressBar
                  label="Share quota remaining"
                  isLabelHidden
                  value={remainingPercent}
                  max={100}
                  variant={quotaVariant}
                />
              </VStack>
              <HStack justify="end" gap={2} wrap="wrap">
                {session.canRevealKey && <Button label="Reveal key" size="sm" variant="primary" onClick={() => onReveal(session)} />}
                {session.canRotateKey && <Button label={session.canRevealKey ? 'Generate new key' : 'Generate key'} size="sm" variant="primary" onClick={() => onRotate(session)} />}
                {session.role === 'provider' && !['revoked', 'exhausted'].includes(session.status) && (
                  <Button label={session.status === 'paused' ? 'Resume' : 'Pause'} size="sm" variant="secondary" onClick={() => onStatus(session, session.status === 'paused' ? 'active' : 'paused')} />
                )}
                {session.role === 'provider' && session.status !== 'revoked' && <Button label="Resize" size="sm" variant="secondary" onClick={() => onEdit(session)} />}
                {session.status !== 'revoked' && <Button label={session.role === 'consumer' ? 'Leave' : 'Revoke'} size="sm" variant="secondary" onClick={() => onRevoke(session)} />}
              </HStack>
            </VStack>
          </Card>
        );
      })}
    </Grid>
  );
}

function CodexLoginCard({ login, onCancel, onRetry }) {
  const waiting = ['starting', 'waiting'].includes(login.status);
  const retryable = ['failed', 'cancelled'].includes(login.status);
  return (
    <Card variant="muted">
      <HStack justify="between" vAlign="center" gap={3} wrap="wrap">
        <VStack gap={1}>
          <HStack gap={2} vAlign="center">
            <Text weight="bold">Codex sign-in</Text>
            <Badge label={login.status} variant={login.status === 'completed' ? 'green' : login.status === 'failed' ? 'error' : 'warning'} />
          </HStack>
          {login.userCode
            ? <Text>Open {login.verificationUrl} and enter code <Text weight="bold">{login.userCode}</Text>.</Text>
            : <Text type="supporting" color="secondary">Starting the OpenAI device sign-in flow...</Text>}
          {login.errorCode && <Text type="supporting" color="secondary">{login.errorCode}</Text>}
        </VStack>
        <HStack gap={2}>
          {login.verificationUrl && <Button label="Open OpenAI sign-in" variant="primary" onClick={() => window.open(login.verificationUrl, '_blank', 'noopener,noreferrer')} />}
          {retryable && <Button label="Try again" variant="primary" onClick={onRetry} />}
          {waiting && <Button label="Cancel" variant="secondary" onClick={onCancel} />}
        </HStack>
      </HStack>
    </Card>
  );
}

function AuthJsonLoginDialog({ isOpen, value, isLoading, onChange, onClose, onSubmit }) {
  return (
    <Dialog isOpen={isOpen} onOpenChange={onClose} purpose="form" width={640}>
      <Layout
        header={<DialogHeader title="Login with auth.json" onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            <form id="auth-json-login-form" onSubmit={onSubmit}>
              <VStack gap={3}>
                <Banner
                  title="Credential import"
                  description="Pasted credentials are encrypted in Codex Pool and are not saved in browser storage."
                  status="warning"
                />
                <TextArea
                  label="Codex auth.json"
                  value={value}
                  onChange={onChange}
                  placeholder="Paste auth.json here (tokens.access_token, refresh_token, id_token)"
                  rows={20}
                  htmlName="authJson"
                  hasSpellCheck={false}
                  hasAutoFocus
                />
              </VStack>
            </form>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter hasDivider>
            <HStack justify="end" gap={2}>
              <Button label="Cancel" variant="secondary" isDisabled={isLoading} onClick={onClose} />
              <Button
                label="Login"
                variant="primary"
                type="submit"
                form="auth-json-login-form"
                isDisabled={!value.trim()}
                isLoading={isLoading}
              />
            </HStack>
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function OfferDialog({ value, upstreams, onClose, onSave, onChange }) {
  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} purpose="form" width={460}>
      <Layout
        header={<DialogHeader title={value?.offer ? 'Edit offer' : 'Publish offer'} onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            {value && <VStack gap={3}>
              <TextInput label="Provider upstream" value={upstreams.find((item) => item.id === value.upstreamId)?.name || value.offer?.upstream.name || ''} isDisabled />
              <NumberInput label="Shareable quota (USD)" value={value.quotaDollars} onChange={(quotaDollars) => onChange({ ...value, quotaDollars })} min={0.01} step={0.01} />
              {value.offer && (
                <SegmentedControl label="Offer status" value={value.status} onChange={(status) => onChange({ ...value, status })}>
                  <SegmentedControlItem value="active" label="Active" />
                  <SegmentedControlItem value="paused" label="Paused" />
                  <SegmentedControlItem value="closed" label="Closed" />
                </SegmentedControl>
              )}
            </VStack>}
          </LayoutContent>
        )}
        footer={<DialogFooter onClose={onClose} onSave={() => onSave(value)} saveLabel={value?.offer ? 'Save offer' : 'Publish'} />}
      />
    </Dialog>
  );
}

function TicketDialog({ value, onClose, onSave, onChange }) {
  const title = 'Approve ticket';
  const subtitle = accountLabel(value?.ticket?.consumer);
  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} purpose="form" width={420}>
      <Layout
        header={<DialogHeader title={title} subtitle={subtitle} onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            {value && <NumberInput label="Approved quota (USD)" value={value.quotaDollars} onChange={(quotaDollars) => onChange({ ...value, quotaDollars })} min={0.01} step={0.01} />}
          </LayoutContent>
        )}
        footer={<DialogFooter onClose={onClose} onSave={() => onSave(value)} saveLabel="Approve" />}
      />
    </Dialog>
  );
}

function SessionDialog({ value, onClose, onSave, onChange }) {
  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} purpose="form" width={420}>
      <Layout
        header={<DialogHeader title="Resize share session" subtitle={accountLabel(value?.session.consumer)} onOpenChange={onClose} hasDivider />}
        content={<LayoutContent>{value && <NumberInput label="Granted quota (USD)" value={value.quotaDollars} onChange={(quotaDollars) => onChange({ ...value, quotaDollars })} min={value.session.consumedQuotaDollars} step={0.01} />}</LayoutContent>}
        footer={<DialogFooter onClose={onClose} onSave={() => onSave(value)} saveLabel="Update quota" />}
      />
    </Dialog>
  );
}

function KeyDialog({ value, onClose, onNotice }) {
  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} width={600}>
      <Layout
        header={<DialogHeader title="Share session API key" subtitle="Available until this share session is revoked" onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            <VStack gap={3}>
              <Banner title="Keep this key private" description="Anyone with this key can use the session quota until the key is replaced or the session is revoked." status="warning" />
              <TextInput label="API key" value={value?.apiKey || ''} isReadOnly />
              <TextInput label="API base URL" value={apiBaseUrl()} isReadOnly />
            </VStack>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter hasDivider>
            <HStack justify="end" gap={2}>
              <Button label="Copy" variant="primary" onClick={async () => {
                await navigator.clipboard.writeText(value.apiKey);
                onNotice('API key copied');
              }} />
              <Button label="Done" variant="secondary" onClick={onClose} />
            </HStack>
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function DialogFooter({ onClose, onSave, saveLabel }) {
  return (
    <LayoutFooter hasDivider>
      <HStack justify="end" gap={2}>
        <Button label="Cancel" variant="secondary" onClick={onClose} />
        <Button label={saveLabel} variant="primary" onClick={onSave} />
      </HStack>
    </LayoutFooter>
  );
}

function providerQuota(quota) {
  if (!quota) return 'Provider quota has not been refreshed';
  if (Number.isFinite(quota.remainingDollars)) return `$${money(quota.remainingDollars)} provider quota left`;
  if (Number.isFinite(quota.remainingPercent)) return `${money(quota.remainingPercent)}% provider quota left`;
  return 'Provider quota is available';
}

function apiBaseUrl() {
  return `${window.location.origin}/v1`;
}

function accountLabel(account) {
  return account?.email || account?.displayName || 'Unknown account';
}

function providerQuotaExhausted(quota) {
  if (!quota) return false;
  if (Number.isFinite(quota.remainingPercent)) return quota.remainingPercent <= 0;
  if (Number.isFinite(quota.remainingDollars)) return quota.remainingDollars <= 0;
  return Number.isFinite(quota.remainingUnits) && quota.remainingUnits <= 0;
}

function quotaRemaining(quota) {
  if (!quota) return 'Quota has not been refreshed';
  if (Number.isFinite(quota.remainingDollars)) return `$${money(quota.remainingDollars)} left`;
  if (Number.isFinite(quota.remainingPercent)) return `${money(quota.remainingPercent)}% left`;
  if (Number.isFinite(quota.remainingUnits)) return `${money(quota.remainingUnits)} units left`;
  return 'Quota available';
}

function quotaReset(quota) {
  if (!quota?.resetAt) return 'Reset time unavailable';
  return `Resets ${dateTime(quota.resetAt)}`;
}

function dateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return 'at an unknown time';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function money(value) {
  return Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

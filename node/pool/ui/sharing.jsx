import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Code } from '@astryxdesign/core/Code';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { DateInput } from '@astryxdesign/core/DateInput';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { FieldLabel } from '@astryxdesign/core/Field';
import { Grid, GridSpan } from '@astryxdesign/core/Grid';
import { Icon } from '@astryxdesign/core/Icon';
import { Heading, Text } from '@astryxdesign/core/Text';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Link } from '@astryxdesign/core/Link';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Overlay } from '@astryxdesign/core/Overlay';
import { Pagination } from '@astryxdesign/core/Pagination';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from '@astryxdesign/core/Layout';
import { Ban, CircleHelp, Eye, KeyRound, LogOut, Pause, Play, PlugZap, Plus, Scaling } from 'lucide-react';
import { UserGuideDialog } from './UserGuideDialog.jsx';

const SHARING_VIEWS = new Set([
  'community-offers',
  'my-offers',
  'quota-requests',
  'sent-requests',
  'approvals',
  'my-access',
  'shared-by-me'
]);
const SHARING_VIEW_STORAGE_KEY = 'codex_pool_sharing_view';
const SHARING_CARD_GRID_COLUMNS = { minWidth: 280, max: 3, repeat: 'fill' };
const PROVIDER_CARD_GRID_COLUMNS = { minWidth: 220, max: 2, repeat: 'fill' };
const SHARING_LIST_CONFIG = {
  'community-offers': { resource: 'offers', key: 'offers', role: 'community' },
  'my-offers': { resource: 'offers', key: 'offers', role: 'mine' },
  'quota-requests': { resource: 'quota-requests', key: 'quotaRequests' },
  'sent-requests': { resource: 'tickets', key: 'tickets', role: 'sent' },
  approvals: { resource: 'tickets', key: 'tickets', role: 'received' },
  'my-access': { resource: 'sessions', key: 'sessions', role: 'consumer' },
  'shared-by-me': { resource: 'sessions', key: 'sessions', role: 'provider' }
};

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

function useStoredValue(key, fallback = '') {
  const [value, setValue] = useState(() => {
    try { return window.localStorage.getItem(key) || fallback; } catch { return fallback; }
  });
  const update = useCallback((next) => {
    setValue(next);
    try { window.localStorage.setItem(key, next); } catch {}
  }, [key]);
  return [value, update];
}

function useSharingApi() {
  return useCallback(async (path, options = {}) => {
    const method = options.method || 'GET';
    const response = await fetch(appUrl(path), {
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
  const [tablePage, setTablePage] = useState({ items: [], totalItems: 0, hasMore: false, nextOffset: null });
  const [tableTotals, setTableTotals] = useState({});
  const [tableOffset, setTableOffset] = useState(0);
  const [tablePageSize, setTablePageSize] = useState(10);
  const [upstreams, setUpstreams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [offerDialog, setOfferDialog] = useState(null);
  const [ticketDialog, setTicketDialog] = useState(null);
  const [sessionDialog, setSessionDialog] = useState(null);
  const [keyDialog, setKeyDialog] = useState(null);
  const [credentialsDialog, setCredentialsDialog] = useState(null);
  const [personalKeys, setPersonalKeys] = useState([]);
  const [personalKeyDialog, setPersonalKeyDialog] = useState(null);
  const [personalKeyRevokeTarget, setPersonalKeyRevokeTarget] = useState(null);
  const [personalKeyActionLoading, setPersonalKeyActionLoading] = useState(false);
  const [providerRevokeTarget, setProviderRevokeTarget] = useState(null);
  const [providerActionLoading, setProviderActionLoading] = useState(false);
  const [quotaRequestDialog, setQuotaRequestDialog] = useState(null);
  const [login, setLogin] = useState(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [authJsonDialog, setAuthJsonDialog] = useState(false);
  const [authJson, setAuthJson] = useState('');
  const [authJsonLoading, setAuthJsonLoading] = useState(false);
  const [aiswitchDialog, setAiswitchDialog] = useState(null);
  const [manualBudgetDialog, setManualBudgetDialog] = useState(null);
  const [quotaRefreshing, setQuotaRefreshing] = useState(false);
  const [testingUpstreamId, setTestingUpstreamId] = useState(null);
  const [testingSessionId, setTestingSessionId] = useState(null);
  const [emailQuery, setEmailQuery] = useStoredValue('codex_pool_sharing_email_query', '');
  const [loadingActions, setLoadingActions] = useState(new Set());
  const actionsInFlight = useRef(new Set());
  const tableRequestVersion = useRef(0);
  const resetTablePage = useCallback(() => {
    tableRequestVersion.current += 1;
    setTablePage({ items: [], totalItems: 0, hasMore: false, nextOffset: null });
  }, []);

  const load = useCallback(async ({ background = false } = {}) => {
    if (!background) setLoading(true);
    try {
      const me = await api('/api/pool/me');
      setAccount(me.account);
    } catch (nextError) {
      if (nextError.status === 401) {
        setAccount(null);
        try {
          const data = await api('/auth/codex/status');
          if (data.login.status === 'completed') {
            setLogin(null);
            onNotice('Signed in with Codex');
            await load();
          } else {
            setLogin(data.login);
          }
        } catch {}
      } else if (!background) onNotice(nextError.message, true);
      if (!background) setLoading(false);
      return;
    }
    try {
      const [upstreamData, personalKeyData] = await Promise.all([
        api('/api/pool/upstreams'),
        api('/api/pool/personal-keys')
      ]);
      setUpstreams(upstreamData.upstreams || []);
      setPersonalKeys(personalKeyData.personalKeys || []);
      try {
        const countData = await api('/api/pool/sharing-counts');
        setTableTotals(countData.counts || {});
      } catch (countError) {
        if (!background) onNotice(countError.message, true);
      }
    } catch (nextError) {
      if (!background) onNotice(nextError.message, true);
    } finally {
      if (!background) setLoading(false);
    }
  }, [api, onNotice]);

  useEffect(() => { void load(); }, [load]);

  const loadTable = useCallback(async ({ background = true } = {}) => {
    if (!account) return;
    const requestVersion = ++tableRequestVersion.current;
    const config = SHARING_LIST_CONFIG[view];
    const params = new URLSearchParams({
      limit: String(tablePageSize),
      offset: String(tableOffset),
      includePast: 'false'
    });
    if (config.role) params.set('role', config.role);
    if (emailQuery.trim()) params.set('q', emailQuery.trim());
    try {
      const data = await api(`/api/pool/${config.resource}?${params}`);
      if (requestVersion !== tableRequestVersion.current) return;
      const items = data[config.key] || [];
      if (!items.length && data.totalItems > 0 && tableOffset > 0) {
        setTableOffset(0);
        return;
      }
      setTablePage({
        items,
        totalItems: data.totalItems || 0,
        hasMore: Boolean(data.hasMore),
        nextOffset: data.nextOffset ?? null,
        hasActiveOwnQuotaRequest: Boolean(data.hasActiveOwnQuotaRequest)
      });
      setTableTotals((totals) => ({ ...totals, [view]: data.totalItems || 0 }));
    } catch (nextError) {
      if (requestVersion !== tableRequestVersion.current) return;
      if (!background) onNotice(nextError.message, true);
    }
  }, [account, api, emailQuery, onNotice, tableOffset, tablePageSize, view]);

  useEffect(() => {
    if (!account) return undefined;
    const timer = window.setTimeout(() => void loadTable(), emailQuery.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [account, emailQuery, loadTable]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SHARING_VIEW_STORAGE_KEY, view);
    } catch {}
  }, [view]);

  useEffect(() => {
    if (!account) return undefined;
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        void load({ background: true });
        void loadTable();
      }
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [account, load, loadTable]);

  useEffect(() => {
    if (!login || ['completed', 'failed', 'cancelled'].includes(login.status)) return undefined;
    let active = true;
    let timer = null;
    const poll = async () => {
      try {
        const data = await api('/auth/codex/status');
        if (!active) return;
        if (data.login.status === 'completed') {
          setLogin(null);
          onNotice('Signed in with Codex');
          await load();
        } else {
          setLogin(data.login);
        }
      } catch (nextError) {
        if (active) onNotice(nextError.message, true);
      }
      if (active) timer = window.setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [api, load, login, onNotice]);

  const mutate = useCallback(async (operation, message, actionKey = null) => {
    if (actionKey && actionsInFlight.current.has(actionKey)) return false;
    if (actionKey) {
      actionsInFlight.current.add(actionKey);
      setLoadingActions((actions) => new Set(actions).add(actionKey));
    }
    try {
      await operation();
      if (message) onNotice(message);
      await load();
      await loadTable({ background: false });
      return true;
    } catch (nextError) {
      onNotice(nextError.message, true);
      return false;
    } finally {
      if (actionKey) {
        actionsInFlight.current.delete(actionKey);
        setLoadingActions((actions) => {
          const nextActions = new Set(actions);
          nextActions.delete(actionKey);
          return nextActions;
        });
      }
    }
  }, [load, loadTable, onNotice]);

  const isActionLoading = useCallback((actionKey) => loadingActions.has(actionKey), [loadingActions]);

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

  const cancelCodexLogin = async () => {
    try {
      await api('/auth/codex/login', { method: 'DELETE' });
      setLogin(null);
      onNotice('Codex sign-in cancelled');
    } catch (nextError) {
      onNotice(nextError.message, true);
    }
  };

  const openAuthJsonDialog = () => setAuthJsonDialog(true);

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
    setTablePage({ items: [], totalItems: 0, hasMore: false, nextOffset: null });
    setTableTotals({});
    setUpstreams([]);
    setPersonalKeys([]);
    setLogin(null);
  };

  const refreshQuota = async ({ silent = false } = {}) => {
    const refreshable = upstreams.filter((upstream) => upstream.type === 'codex');
    if (!refreshable.length) {
      if (!silent) onNotice('AISwitch share budgets are set manually');
      return;
    }
    setQuotaRefreshing(true);
    try {
      await Promise.all(refreshable.map((upstream) => api(`/api/pool/upstreams/${upstream.id}/refresh-quota`, {
        method: 'POST',
        body: '{}'
      })));
      if (!silent) onNotice('Codex quota refreshed');
      await load({ background: silent });
      await loadTable({ background: silent });
    } catch (nextError) {
      if (!silent) onNotice(nextError.message, true);
    } finally {
      setQuotaRefreshing(false);
    }
  };

  const revealCredentials = async () => {
    try {
      const data = await api('/api/pool/upstreams/credentials');
      if (!data.credentials?.length) {
        onNotice('No linked provider credentials found', true);
        return;
      }
      setCredentialsDialog({
        entries: data.credentials,
        selectedId: data.credentials[0].id
      });
    } catch (nextError) {
      onNotice(nextError.message, true);
    }
  };

  const testConnection = async (upstream) => {
    setTestingUpstreamId(upstream.id);
    try {
      const data = await api(`/api/pool/upstreams/${upstream.id}/test-connection`, {
        method: 'POST',
        body: '{}'
      });
      const connection = data.connection;
      onNotice(`Connected through ${connection.endpoint} with ${connection.model} in ${connection.latencyMs} ms`);
      await load();
    } catch (nextError) {
      onNotice(nextError.message, true);
    } finally {
      setTestingUpstreamId(null);
    }
  };

  const testSessionConnection = async (session) => {
    setTestingSessionId(session.id);
    try {
      const data = await api(`/api/pool/sessions/${session.id}/test-connection`, {
        method: 'POST',
        body: '{}'
      });
      const connection = data.connection;
      onNotice(`Connected through ${connection.endpoint} with ${connection.model} in ${connection.latencyMs} ms`);
      await load();
    } catch (nextError) {
      onNotice(nextError.message, true);
    } finally {
      setTestingSessionId(null);
    }
  };

  useEffect(() => {
    if (!account) return undefined;
    const refreshOnFocus = () => {
      if (document.hidden) return;
      void refreshQuota({ silent: true });
      void load({ background: true });
      void loadTable();
    };
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnFocus);
    return () => {
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnFocus);
    };
  }, [account, load, loadTable, refreshQuota]);

  if (!account) {
    return (
      <LoadingOverlay isLoading={loading}>
      <VStack gap={2}>
        <Grid columns={SHARING_CARD_GRID_COLUMNS} gap={2} minHeight={120}>
          <Card height="100%" padding={3}>
            <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
              <VStack gap={1}>
                <Heading level={2} maxLines={1}>Quota sharing</Heading>
                <Text type="supporting" color="secondary" maxLines={1}>Sign in with Codex to publish quota, request access, and manage share sessions.</Text>
              </VStack>
              {!login && (
                <HStack gap={1} wrap="wrap">
                  <Button label="Login with Codex" variant="primary" isLoading={loginLoading} onClick={() => void startCodexLogin()} />
                  <Button
                    label="Login with auth.json"
                    variant="secondary"
                    onClick={openAuthJsonDialog}
                  />
                </HStack>
              )}
            </HStack>
          </Card>
          {login && <CodexLoginCard login={login} onRetry={() => void startCodexLogin()} onCancel={() => void cancelCodexLogin()} />}
        </Grid>
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
      </VStack>
      </LoadingOverlay>
    );
  }

  const offerableUpstreams = upstreams.filter((upstream) => (
    !upstream.providerIssue
    && upstream.sharing?.status !== 'paused'
    && (upstream.commitment?.offerableQuotaDollars === null || upstream.commitment?.offerableQuotaDollars > 0)
  ));
  const tableItems = tablePage.items;
  const communityOffers = view === 'community-offers' ? tableItems : [];
  const myOffers = view === 'my-offers' ? tableItems : [];
  const sentTickets = view === 'sent-requests' ? tableItems : [];
  const receivedTickets = view === 'approvals' ? tableItems : [];
  const requestedSessions = view === 'my-access' ? tableItems : [];
  const sharingSessions = view === 'shared-by-me' ? tableItems : [];
  const visibleQuotaRequests = view === 'quota-requests' ? tableItems : [];
  const activeOwnQuotaRequest = tablePage.hasActiveOwnQuotaRequest;
  const sharingTable = {
    totalItems: tablePage.totalItems,
    offset: tableOffset,
    pageSize: tablePageSize,
    onPageChange: setTableOffset,
    onPageSizeChange: (nextPageSize) => {
      setTablePageSize(nextPageSize);
      setTableOffset(0);
      resetTablePage();
    }
  };
  const tabLabel = (label, tab) => `${label}${tableTotals[tab] === undefined ? '' : ` (${tableTotals[tab]})`}`;

  return (
    <LoadingOverlay isLoading={loading}>
    <VStack gap={2}>
      <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
        <VStack gap={1}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Heading level={2}>Quota sharing</Heading>
            <Badge label={accountLabel(account)} variant="neutral" />
          </HStack>
        </VStack>
        <HStack gap={1} wrap="wrap">
          <Button label="Sign out" variant="secondary" onClick={() => void logout()} />
        </HStack>
      </HStack>

      <Grid columns={SHARING_CARD_GRID_COLUMNS} gap={2}>
        <GridSpan columns={2}>
          <QuotaOverview
            upstreams={upstreams}
            isRefreshing={quotaRefreshing}
            onRefresh={() => void refreshQuota()}
            onLinkCodex={() => void startCodexLogin()}
            onImportAuthJson={openAuthJsonDialog}
            onAddAiswitch={() => setAiswitchDialog({ projectId: '', projectKey: '', quotaDollars: 10 })}
            onEditAiswitch={(upstream) => setAiswitchDialog({
              upstream,
              projectId: upstream.projectId || '',
              projectKey: ''
            })}
            onRevealCredentials={() => void revealCredentials()}
            onTestConnection={(upstream) => void testConnection(upstream)}
            testingUpstreamId={testingUpstreamId}
            onToggleSharing={(upstream) => void mutate(
              () => api(`/api/pool/providers/${upstream.id}/${upstream.sharing?.status === 'paused' ? 'resume' : 'pause'}`, {
                method: 'POST',
                body: '{}'
              }),
              upstream.sharing?.status === 'paused' ? 'Sharing resumed' : 'Sharing paused',
              `provider-sharing:${upstream.id}`
            )}
            isActionLoading={isActionLoading}
            onRevokeAll={setProviderRevokeTarget}
            onSetManualBudget={(upstream) => setManualBudgetDialog({
              upstream,
              quotaDollars: upstream.commitment?.actualQuotaDollars ?? 0
            })}
          />
        </GridSpan>
        <PersonalKeyCard
          personalKeys={personalKeys.filter((key) => key.status === 'active')}
          onCreate={() => setPersonalKeyDialog({ name: '', expiresOn: '' })}
          onReveal={(personalKey) => mutate(async () => {
              const data = await api(`/api/pool/personal-keys/${personalKey.id}/reveal`, { method: 'POST', body: '{}' });
              setKeyDialog({ personal: true, name: personalKey.name, apiKey: data.apiKey });
            }, null, `personal-key-reveal:${personalKey.id}`)}
          onRotate={(personalKey) => mutate(async () => {
              const data = await api(`/api/pool/personal-keys/${personalKey.id}/rotate`, { method: 'POST', body: '{}' });
              setKeyDialog({ personal: true, name: personalKey.name, apiKey: data.apiKey });
            }, null, `personal-key-rotate:${personalKey.id}`)}
          onRevoke={setPersonalKeyRevokeTarget}
          isActionLoading={isActionLoading}
        />
      </Grid>
      {login && (
        <Grid columns={SHARING_CARD_GRID_COLUMNS} gap={2}>
          <CodexLoginCard login={login} onRetry={() => void startCodexLogin()} onCancel={() => void cancelCodexLogin()} />
        </Grid>
      )}
      <VStack gap={4}>
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <SegmentedControl label="Sharing workspace" value={view} onChange={(nextView) => {
            setView(nextView);
            setTableOffset(0);
            resetTablePage();
          }} size="md" layout="hug">
            <SegmentedControlItem value="community-offers" label={tabLabel('Community offers', 'community-offers')} />
            <SegmentedControlItem value="my-offers" label={tabLabel('My offers', 'my-offers')} />
            <SegmentedControlItem value="quota-requests" label={tabLabel('Friends seeking quota', 'quota-requests')} />
            <SegmentedControlItem value="sent-requests" label={tabLabel('Sent requests', 'sent-requests')} />
            <SegmentedControlItem value="approvals" label={tabLabel('Approvals', 'approvals')} />
            <SegmentedControlItem value="my-access" label={tabLabel('My access', 'my-access')} />
            <SegmentedControlItem value="shared-by-me" label={tabLabel('Shared by me', 'shared-by-me')} />
          </SegmentedControl>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <TextInput
              label="Search provider or consumer email"
              isLabelHidden
              value={emailQuery}
              onChange={(nextQuery) => {
                setEmailQuery(typeof nextQuery === 'string' ? nextQuery : nextQuery?.target?.value || '');
                setTableOffset(0);
                resetTablePage();
              }}
              placeholder="Search provider or consumer email..."
              hasClear
              width={300}
            />
            {offerableUpstreams.length > 0 && (
              <Button label="Publish offer" variant="primary" onClick={() => setOfferDialog({ upstreamId: offerableUpstreams[0].id, quotaDollars: 10, expiresOn: '' })} />
            )}
            {view === 'quota-requests' && !activeOwnQuotaRequest && (
              <Button label="Ask friends" variant="primary" onClick={() => setQuotaRequestDialog({ quotaDollars: 10, expiresOn: '' })} />
            )}
          </HStack>
        </HStack>

      {view === 'community-offers' && (
        <OffersView
          offers={communityOffers}
          upstreams={upstreams}
          emailQuery={emailQuery}
          tablePage={sharingTable}
          emptyTitle="No community offers"
          emptyDescription="Offers from other Codex Share members will appear here."
          onRequest={(offer) => void mutate(async () => {
            await api('/api/pool/tickets', {
              method: 'POST',
              body: JSON.stringify({ offerId: offer.id })
            });
          }, `Requested $${money(offer.availableDollars)} quota`, `offer-request:${offer.id}`)}
          isActionLoading={isActionLoading}
          onEdit={(offer) => setOfferDialog({
            offer,
            upstreamId: offer.upstream.id,
            quotaDollars: offer.quotaDollars,
            status: offer.status,
            expiresOn: dateFromTimestamp(offer.expiresAt)
          })}
        />
      )}
      {view === 'my-offers' && (
        <OffersView
          offers={myOffers}
          tablePage={sharingTable}
          emailQuery={emailQuery}
          emptyTitle="No offers yet"
          emptyDescription={upstreams.length ? 'Publish an offer to share quota with the community.' : 'Your Codex account has no available upstream.'}
          onEdit={(offer) => setOfferDialog({
            offer,
            upstreamId: offer.upstream.id,
            quotaDollars: offer.quotaDollars,
            status: offer.status,
            expiresOn: dateFromTimestamp(offer.expiresAt)
          })}
        />
      )}
      {view === 'quota-requests' && (
        <QuotaRequestsView
          requests={visibleQuotaRequests}
          tablePage={sharingTable}
          emailQuery={emailQuery}
          canOffer={offerableUpstreams.length > 0}
          onCancel={(request) => void mutate(
            () => api(`/api/pool/quota-requests/${request.id}/cancel`, { method: 'POST', body: '{}' }),
            'Quota request cancelled',
            `quota-request-cancel:${request.id}`
          )}
          isActionLoading={isActionLoading}
          onOffer={(request) => setOfferDialog({
            upstreamId: offerableUpstreams[0].id,
            quotaDollars: request.quotaDollars,
            expiresOn: dateFromTimestamp(request.expiresAt)
          })}
        />
      )}
      {view === 'sent-requests' && (
        <TicketsView
          tickets={sentTickets}
          tablePage={sharingTable}
          emailQuery={emailQuery}
          emptyTitle="No sent requests"
          emptyDescription="Quota requests you send will appear here."
          onCancel={(ticket) => void mutate(() => api(`/api/pool/tickets/${ticket.id}/cancel`, { method: 'POST', body: '{}' }), 'Ticket cancelled', `ticket-cancel:${ticket.id}`)}
          isActionLoading={isActionLoading}
        />
      )}
      {view === 'approvals' && (
        <TicketsView
          tickets={receivedTickets}
          tablePage={sharingTable}
          emailQuery={emailQuery}
          emptyTitle="No requests to approve"
          emptyDescription="Requests for your offered quota will appear here."
          onApprove={(ticket) => setTicketDialog({ ticket, quotaDollars: ticket.requestedQuotaDollars, approval: true })}
          onReject={(ticket) => void mutate(() => api(`/api/pool/tickets/${ticket.id}/reject`, { method: 'POST', body: '{}' }), 'Ticket rejected', `ticket-reject:${ticket.id}`)}
          onCancel={(ticket) => void mutate(() => api(`/api/pool/tickets/${ticket.id}/cancel`, { method: 'POST', body: '{}' }), 'Ticket cancelled', `ticket-cancel:${ticket.id}`)}
          isActionLoading={isActionLoading}
        />
      )}
      {view === 'my-access' && (
        <SessionsView
          sessions={requestedSessions}
          tablePage={sharingTable}
          emailQuery={emailQuery}
          emptyTitle="No shared access"
          emptyDescription="Approved requests will create a share session here."
          onTestConnection={(session) => void testSessionConnection(session)}
          testingSessionId={testingSessionId}
          onStatus={(session, status) => void mutate(
            () => api(`/api/pool/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
            status === 'active' ? 'Session resumed' : 'Session paused',
            `session-status:${session.id}`
          )}
          onRevoke={(session) => void mutate(
            () => api(`/api/pool/sessions/${session.id}/revoke`, { method: 'POST', body: '{}' }),
            'Session revoked',
            `session-revoke:${session.id}`
          )}
          isActionLoading={isActionLoading}
          onReveal={(session) => mutate(async () => {
              const data = await api(`/api/pool/sessions/${session.id}/reveal-key`, { method: 'POST', body: '{}' });
              setKeyDialog({ session, apiKey: data.apiKey });
            }, null, `session-reveal:${session.id}`)}
          onRotate={(session) => mutate(async () => {
              const data = await api(`/api/pool/sessions/${session.id}/rotate-key`, { method: 'POST', body: '{}' });
              setKeyDialog({ session, apiKey: data.apiKey });
            }, null, `session-rotate:${session.id}`)}
        />
      )}
      {view === 'shared-by-me' && (
        <SessionsView
          sessions={sharingSessions}
          tablePage={sharingTable}
          emailQuery={emailQuery}
          emptyTitle="No active shares"
          emptyDescription="Sessions you approve for other members will appear here."
          onEdit={(session) => setSessionDialog({
            session,
            quotaDollars: session.grantedQuotaDollars,
            expiresOn: dateFromTimestamp(session.expiresAt),
            mode: 'resize'
          })}
          onAddQuota={(session) => setSessionDialog({ session, quotaDollars: 1, mode: 'add' })}
          onStatus={(session, status) => void mutate(
            () => api(`/api/pool/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
            status === 'active' ? 'Session resumed' : 'Session paused',
            `session-status:${session.id}`
          )}
          onRevoke={(session) => void mutate(
            () => api(`/api/pool/sessions/${session.id}/revoke`, { method: 'POST', body: '{}' }),
            'Session revoked',
            `session-revoke:${session.id}`
          )}
          isActionLoading={isActionLoading}
          onReveal={(session) => mutate(async () => {
              const data = await api(`/api/pool/sessions/${session.id}/reveal-key`, { method: 'POST', body: '{}' });
              setKeyDialog({ session, apiKey: data.apiKey });
            }, null, `session-reveal:${session.id}`)}
          onRotate={(session) => mutate(async () => {
              const data = await api(`/api/pool/sessions/${session.id}/rotate-key`, { method: 'POST', body: '{}' });
              setKeyDialog({ session, apiKey: data.apiKey });
            }, null, `session-rotate:${session.id}`)}
        />
      )}
      </VStack>

      <OfferDialog
        value={offerDialog}
        upstreams={upstreams}
        offerableUpstreams={offerableUpstreams}
        onClose={() => setOfferDialog(null)}
        onSave={(value) => mutate(async () => {
          const path = value.offer ? `/api/pool/offers/${value.offer.id}` : '/api/pool/offers';
          const method = value.offer ? 'PATCH' : 'POST';
          await api(path, {
            method,
            body: JSON.stringify({
              ...(!value.offer ? { upstreamId: value.upstreamId } : {}),
              quotaDollars: value.quotaDollars,
              expiresAt: expiryTimestamp(value.expiresOn),
              ...(value.offer ? { status: value.status } : {})
            })
          });
          setOfferDialog(null);
        }, value.offer ? 'Offer updated' : 'Offer published')}
        onChange={setOfferDialog}
      />
      <AiswitchProjectDialog
        value={aiswitchDialog}
        onClose={() => setAiswitchDialog(null)}
        onChange={setAiswitchDialog}
        onSave={(value) => mutate(async () => {
          const editing = Boolean(value.upstream);
          await api(editing ? `/api/pool/upstreams/${value.upstream.id}` : '/api/pool/upstreams/aiswitch', {
            method: editing ? 'PATCH' : 'POST',
            body: JSON.stringify(editing
              ? {
                  projectId: value.projectId,
                  ...(value.projectKey.trim() ? { projectKey: value.projectKey } : {})
                }
              : value)
          });
          setAiswitchDialog(null);
        }, aiswitchDialog?.upstream ? 'AISwitch project updated' : 'AISwitch project added with a manual share budget')}
      />
      <ManualBudgetDialog
        value={manualBudgetDialog}
        onClose={() => setManualBudgetDialog(null)}
        onChange={setManualBudgetDialog}
        onSave={(value) => mutate(async () => {
          await api(`/api/pool/upstreams/${value.upstream.id}/manual-budget`, {
            method: 'PUT',
            body: JSON.stringify({ quotaDollars: value.quotaDollars })
          });
          setManualBudgetDialog(null);
        }, 'AISwitch manual share budget updated')}
      />
      <PersonalKeyDialog
        value={personalKeyDialog}
        onClose={() => setPersonalKeyDialog(null)}
        onChange={setPersonalKeyDialog}
        onSave={(value) => mutate(async () => {
          const data = await api('/api/pool/personal-keys', {
            method: 'POST',
            body: JSON.stringify({
              name: value.name,
              expiresAt: expiryTimestamp(value.expiresOn)
            })
          });
          setPersonalKeyDialog(null);
          setKeyDialog({ personal: true, name: data.personalKey.name, apiKey: data.apiKey });
        }, 'Pool key created')}
      />
      <QuotaRequestDialog
        value={quotaRequestDialog}
        onClose={() => setQuotaRequestDialog(null)}
        onChange={setQuotaRequestDialog}
        onSave={(value) => mutate(async () => {
          await api('/api/pool/quota-requests', {
            method: 'POST',
            body: JSON.stringify({
              quotaDollars: value.quotaDollars,
              expiresAt: expiryTimestamp(value.expiresOn)
            })
          });
          setQuotaRequestDialog(null);
        }, 'Friends can now see your quota request')}
      />
      <TicketDialog
        value={ticketDialog}
        onClose={() => setTicketDialog(null)}
        onChange={setTicketDialog}
        onSave={(value) => mutate(async () => {
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
        onSave={(value) => mutate(async () => {
          await api(`/api/pool/sessions/${value.session.id}`, {
            method: 'PATCH',
            body: JSON.stringify(value.mode === 'add'
              ? { additionalQuotaDollars: value.quotaDollars }
              : {
                  quotaDollars: value.quotaDollars,
                  ...(value.expiresOn !== dateFromTimestamp(value.session.expiresAt)
                    ? { expiresAt: expiryTimestamp(value.expiresOn) }
                    : {})
                })
          });
          setSessionDialog(null);
        }, sessionDialog?.mode === 'add' ? 'Session quota added' : 'Session updated')}
      />
      <KeyDialog value={keyDialog} onClose={() => setKeyDialog(null)} onNotice={onNotice} />
      <CredentialsDialog
        value={credentialsDialog}
        onClose={() => setCredentialsDialog(null)}
        onChange={setCredentialsDialog}
        onNotice={onNotice}
      />
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
      <AlertDialog
        isOpen={Boolean(personalKeyRevokeTarget)}
        onOpenChange={(isOpen) => { if (!isOpen && !personalKeyActionLoading) setPersonalKeyRevokeTarget(null); }}
        title="Revoke pool key?"
        description={personalKeyRevokeTarget
          ? `"${personalKeyRevokeTarget.name}" will stop working immediately. Existing share sessions are not changed.`
          : ''}
        actionLabel="Revoke"
        actionVariant="destructive"
        isActionLoading={personalKeyActionLoading}
        onAction={async () => {
          const target = personalKeyRevokeTarget;
          if (!target) return;
          setPersonalKeyActionLoading(true);
          const changed = await mutate(() => api(`/api/pool/personal-keys/${target.id}/revoke`, { method: 'POST', body: '{}' }), 'Pool key revoked');
          setPersonalKeyActionLoading(false);
          if (changed) setPersonalKeyRevokeTarget(null);
        }}
      />
      <AlertDialog
        isOpen={Boolean(providerRevokeTarget)}
        onOpenChange={(isOpen) => { if (!isOpen && !providerActionLoading) setProviderRevokeTarget(null); }}
        title="Revoke all sharing?"
        description={providerRevokeTarget
          ? `Close every offer and revoke every share session backed by ${providerRevokeTarget.name}. This cannot be undone.`
          : ''}
        actionLabel="Revoke all"
        actionVariant="destructive"
        isActionLoading={providerActionLoading}
        onAction={async () => {
          const target = providerRevokeTarget;
          if (!target) return;
          setProviderActionLoading(true);
          const changed = await mutate(
            () => api(`/api/pool/providers/${target.id}/revoke-all`, { method: 'POST', body: '{}' }),
            'All sharing from this Codex account was revoked'
          );
          setProviderActionLoading(false);
          if (changed) setProviderRevokeTarget(null);
        }}
      />
    </VStack>
    </LoadingOverlay>
  );
}

function LoadingOverlay({ isLoading, children }) {
  return (
    <Overlay
      isOpen={isLoading}
      position="fill"
      align="center"
      content={<Spinner size="lg" shade="onMedia" aria-label="Loading sharing workspace" />}
    >
      {children}
    </Overlay>
  );
}

function QuotaOverview({
  upstreams,
  isRefreshing,
  onRefresh,
  onLinkCodex,
  onImportAuthJson,
  onAddAiswitch,
  onEditAiswitch,
  onRevealCredentials,
  onTestConnection,
  testingUpstreamId,
  onToggleSharing,
  onRevokeAll,
  onSetManualBudget,
  isActionLoading = () => false
}) {
  const hasAiswitch = upstreams.some((upstream) => upstream.quotaSource === 'aiswitch');
  const orderedUpstreams = [...upstreams].sort((left, right) =>
    Number(left.quotaSource === 'aiswitch') - Number(right.quotaSource === 'aiswitch')
  );
  if (!upstreams.length) {
    return (
      <Card variant="muted" padding={3}>
        <VStack gap={2} hAlign="center">
          <VStack gap={1} hAlign="center">
            <Heading level={3} maxLines={1}>No share provider linked</Heading>
            <Text type="supporting" color="secondary" maxLines={1}>Link Codex quota or add an AISwitch project to publish an offer.</Text>
          </VStack>
          <HStack justify="center" gap={1} wrap="wrap">
            <Button label="Login with Codex" size="sm" variant="primary" onClick={onLinkCodex} />
            <Button label="Login with auth.json" size="sm" variant="secondary" onClick={onImportAuthJson} />
            <Button label="Add AISwitch project" size="sm" variant="dashed" onClick={onAddAiswitch} />
          </HStack>
        </VStack>
      </Card>
    );
  }
  return (
    <Card variant="muted" height="100%" padding={3}>
      <VStack gap={2}>
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <VStack gap={1}>
            <Heading level={3} maxLines={1}>Your share providers</Heading>
            <Text type="supporting" color="secondary" maxLines={1}>Codex quota refreshes automatically; AISwitch share budgets are owner-managed.</Text>
          </VStack>
          <HStack gap={2} wrap="wrap">
            <Button label="View credentials" size="sm" variant="secondary" onClick={onRevealCredentials} />
            <Button label="Refresh quota" size="sm" variant="secondary" isLoading={isRefreshing} onClick={onRefresh} />
          </HStack>
        </HStack>
        <Grid columns={PROVIDER_CARD_GRID_COLUMNS} gap={2}>
          {orderedUpstreams.map((upstream) => (
            <QuotaCard
              key={upstream.id}
              upstream={upstream}
              onLinkCodex={onLinkCodex}
              onImportAuthJson={onImportAuthJson}
              onTestConnection={onTestConnection}
              isTestingConnection={testingUpstreamId === upstream.id}
              onToggleSharing={onToggleSharing}
              onRevokeAll={onRevokeAll}
              onSetManualBudget={onSetManualBudget}
              onEditAiswitch={onEditAiswitch}
              isActionLoading={isActionLoading}
            />
          ))}
          {!hasAiswitch && (
            <VStack hAlign="center" vAlign="center" height="100%">
              <Button label="Add AISwitch project" size="sm" variant="dashed" onClick={onAddAiswitch} />
            </VStack>
          )}
        </Grid>
      </VStack>
    </Card>
  );
}

function PersonalKeyCard({ personalKeys, onCreate, onReveal, onRotate, onRevoke, isActionLoading = () => false }) {
  const activeSessionCount = personalKeys[0]?.activeSessionCount || 0;
  const remainingQuota = personalKeys[0]?.remainingQuotaDollars || 0;
  return (
    <Card variant="muted" height="100%" padding={3}>
      <VStack gap={2}>
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <VStack gap={1}>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Heading level={3} maxLines={1}>My Pool Keys</Heading>
              <Badge label={activeSessionCount ? 'active access' : 'no active access'} variant={activeSessionCount ? 'green' : 'neutral'} />
            </HStack>
            <Text type="supporting" color="secondary" maxLines={1}>
              {activeSessionCount} active {activeSessionCount === 1 ? 'session' : 'sessions'} · ${money(remainingQuota)} available
            </Text>
          </VStack>
          <Button label="Create key" size="sm" variant="primary" onClick={onCreate} />
        </HStack>
        {!personalKeys.length && (
          <Text type="supporting" color="secondary" maxLines={1}>Create a named key for each device or client you use.</Text>
        )}
        {personalKeys.map((personalKey) => (
          <VStack key={personalKey.id} gap={1}>
            <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
              <VStack gap={1}>
                <HStack gap={1} vAlign="center" wrap="wrap">
                  <Text weight="bold" maxLines={1}>{personalKey.name}</Text>
                  <Badge
                    label={personalKey.status}
                    variant={personalKey.status === 'active' ? 'green' : 'neutral'}
                  />
                </HStack>
                <Text type="supporting" color="secondary" maxLines={1}>
                  {activitySummary(personalKey.activity)}
                  {personalKey.expiresAt ? ` · Expires ${dateTime(personalKey.expiresAt)}` : ''}
                </Text>
              </VStack>
              {personalKey.status === 'active' && (
                <HStack gap={1} wrap="wrap">
                  <Button label="Reveal" size="sm" variant="secondary" isLoading={isActionLoading(`personal-key-reveal:${personalKey.id}`)} isDisabled={isActionLoading(`personal-key-reveal:${personalKey.id}`)} onClick={() => void onReveal(personalKey)} />
                  <Button label="Rotate" size="sm" variant="secondary" isLoading={isActionLoading(`personal-key-rotate:${personalKey.id}`)} isDisabled={isActionLoading(`personal-key-rotate:${personalKey.id}`)} onClick={() => void onRotate(personalKey)} />
                  <Button label="Revoke" size="sm" variant="ghost" onClick={() => onRevoke(personalKey)} />
                </HStack>
              )}
            </HStack>
          </VStack>
        ))}
      </VStack>
    </Card>
  );
}

function QuotaCard({ upstream, onLinkCodex, onImportAuthJson, onTestConnection, isTestingConnection, onToggleSharing, onRevokeAll, onSetManualBudget, onEditAiswitch, isActionLoading = () => false }) {
  const quota = upstream.quota;
  const isAiswitch = upstream.quotaSource === 'aiswitch';
  const percentage = Number.isFinite(quota?.remainingPercent) ? Math.max(0, Math.min(100, quota.remainingPercent)) : null;
  const issue = upstream.providerIssue;
  const commitment = upstream.commitment;
  const sharingPaused = upstream.sharing?.status === 'paused';
  return (
    <Card variant={issue ? 'red' : 'default'} height="100%" padding={3}>
      <VStack gap={2} height="100%" vAlign="between">
        <VStack gap={2}>
          <HStack justify="between" vAlign="start" gap={2}>
            <VStack gap={1}>
              <Text weight="bold" maxLines={1}>{upstream.email || upstream.name}</Text>
              <Text type="supporting" color="secondary" maxLines={1}>{isAiswitch ? 'AISwitch · manual share budget' : quota?.label || 'Waiting for provider quota'}</Text>
            </VStack>
            <HStack gap={1} vAlign="center">
              {isAiswitch && <Button label="Edit" size="sm" variant="secondary" onClick={() => onEditAiswitch(upstream)} />}
              {issue && <ProviderIssueBadge issue={issue} />}
            </HStack>
          </HStack>
          <Text weight="bold" maxLines={1}>{isAiswitch ? `$${money(commitment?.actualQuotaDollars)} manual budget left` : quotaRemaining(quota)}</Text>
          {percentage !== null && (
            <ProgressBar
              label="Provider quota remaining"
              isLabelHidden
              value={percentage}
              max={100}
              variant={quotaProgressVariant(percentage)}
            />
          )}
          <Text type="supporting" color="secondary" maxLines={1}>{isAiswitch ? 'Decreases only from Codex Share session usage.' : quotaTiming(quota)}</Text>
          {commitment && (
            <Text type="supporting" color="secondary" maxLines={1}>
              ${money(commitment.totalCommitmentDollars)} committed · {Number.isFinite(commitment.offerableQuotaDollars)
                ? `$${money(commitment.offerableQuotaDollars)} available to offer`
                : 'offerable quota unavailable'}
            </Text>
          )}
          {commitment?.underfundedQuotaDollars > 0 && (
            <Badge label={`$${money(commitment.underfundedQuotaDollars)} underfunded`} variant="error" />
          )}
        </VStack>
        <HStack justify="end" gap={1} wrap="wrap">
          <IconButton
            label="Test connection"
            tooltip="Test connection"
            icon={<PlugZap size={16} />}
            size="sm"
            variant="secondary"
            isLoading={isTestingConnection}
            isDisabled={isTestingConnection}
            onClick={() => onTestConnection(upstream)}
          />
          {isAiswitch && <Button label="Set budget" size="sm" variant="secondary" onClick={() => onSetManualBudget(upstream)} />}
          {issue?.code === 'provider_reauth_required' && (
            <>
              <Button label="Reconnect" size="sm" variant="primary" onClick={onLinkCodex} />
              <Button label="Use auth.json" size="sm" variant="secondary" onClick={onImportAuthJson} />
            </>
          )}
          <Button
            label={sharingPaused ? 'Resume sharing' : 'Pause sharing'}
            size="sm"
            variant="secondary"
            isLoading={isActionLoading(`provider-sharing:${upstream.id}`)}
            isDisabled={isActionLoading(`provider-sharing:${upstream.id}`)}
            onClick={() => void onToggleSharing(upstream)}
          />
          <Button label="Revoke all" size="sm" variant="ghost" onClick={() => onRevokeAll(upstream)} />
        </HStack>
      </VStack>
    </Card>
  );
}

const SHARING_TABLE_PAGE_SIZE = 10;
const SHARING_TABLE_PAGE_SIZE_OPTIONS = [10, 20, 50];

function PaginatedSharingTable({ items, columns, emailQuery = '', emptyTitle, emptyDescription, tableLabel, tablePage }) {
  if (!items.length) {
    return filteredEmptyState(emailQuery, emptyTitle, emptyDescription);
  }
  const currentPage = Math.floor(tablePage.offset / tablePage.pageSize) + 1;
  return (
    <VStack gap={2}>
      <Card padding={0}>
        <Table
          data={items}
          columns={columns}
          idKey="id"
          textOverflow="truncate"
        />
      </Card>
      <Pagination
        page={currentPage}
        onChange={(nextPage) => tablePage.onPageChange((nextPage - 1) * tablePage.pageSize)}
        totalItems={tablePage.totalItems}
        pageSize={tablePage.pageSize}
        pageSizeOptions={SHARING_TABLE_PAGE_SIZE_OPTIONS}
        onPageSizeChange={tablePage.onPageSizeChange}
        variant="count"
        size="sm"
        label={tableLabel}
      />
    </VStack>
  );
}

function OffersView({ offers, emailQuery = '', emptyTitle, emptyDescription, onRequest, onEdit, tablePage, isActionLoading = () => false }) {
  const columns = [
    { key: 'provider', header: 'Provider', width: proportional(2), renderCell: (offer) => <Text maxLines={1}>{accountLabel(offer.provider)}</Text> },
    { key: 'offered', header: 'Offered', width: pixel(120), renderCell: (offer) => <Text weight="bold" maxLines={1}>${money(offer.quotaDollars)}</Text> },
    {
      key: 'status',
      header: 'Status',
      width: proportional(2),
      renderCell: (offer) => {
        const issue = offer.status === 'active' ? offer.upstream?.providerIssue : null;
        return (
          <HStack gap={1} wrap="wrap">
            {!offer.isUsable && <Badge label="unusable" variant="error" />}
            {issue && <ProviderIssueBadge issue={issue} />}
            <Badge label={offer.status} variant={offer.status === 'active' ? 'green' : 'neutral'} />
            <UpstreamSourceBadge upstream={offer.upstream} />
          </HStack>
        );
      }
    },
    {
      key: 'expiry',
      header: 'Expires',
      width: proportional(1.5),
      renderCell: (offer) => <Text type="supporting" color="secondary" maxLines={1}>{offer.expiresAt ? dateTime(offer.expiresAt) : 'Unavailable'}</Text>
    },
    {
      key: 'actions',
      header: '',
      width: pixel(150),
      renderCell: (offer) => (
        <HStack justify="end" gap={1}>
          {offer.isProvider
            ? <Button label="Edit" size="sm" variant="secondary" onClick={() => onEdit(offer)} />
            : offer.hasPendingRequest
              ? <Button label="Requested" size="sm" variant="secondary" isDisabled />
              : <Button label="Request quota" size="sm" variant="primary" isLoading={isActionLoading(`offer-request:${offer.id}`)} isDisabled={offer.status !== 'active' || !offer.isUsable || offer.availableDollars <= 0 || isActionLoading(`offer-request:${offer.id}`)} onClick={() => void onRequest(offer)} />}
        </HStack>
      )
    }
  ];
  return <PaginatedSharingTable items={offers} columns={columns} emailQuery={emailQuery} emptyTitle={emptyTitle} emptyDescription={emptyDescription} tableLabel="Offers table" tablePage={tablePage} />;
}

function TicketsView({ tickets, emailQuery = '', emptyTitle, emptyDescription, onApprove, onReject, onCancel, tablePage, isActionLoading = () => false }) {
  const counterpart = tickets[0]?.direction === 'received' ? 'consumer' : 'provider';
  const columns = [
    { key: 'counterpart', header: counterpart === 'consumer' ? 'Consumer' : 'Provider', width: proportional(2), renderCell: (ticket) => <Text maxLines={1}>{accountLabel(ticket[counterpart])}</Text> },
    {
      key: 'request',
      header: 'Request',
      width: proportional(2),
      renderCell: (ticket) => (
        <VStack gap={1}>
          <Text weight="bold" maxLines={1}>${money(ticket.requestedQuotaDollars)} requested{ticket.approvedQuotaDollars !== null ? ` · $${money(ticket.approvedQuotaDollars)} approved` : ''}</Text>
          <Text type="supporting" color="secondary" maxLines={1}>{ticket.upstream?.name || 'Unavailable upstream'}</Text>
        </VStack>
      )
    },
    {
      key: 'status',
      header: 'Status',
      width: proportional(1.5),
      renderCell: (ticket) => {
        const issue = ticket.status === 'pending' ? ticket.upstream?.providerIssue : null;
        return (
          <HStack gap={1} wrap="wrap">
            <Badge label={ticket.direction} variant="neutral" />
            <Badge label={ticket.status} variant={ticket.status === 'pending' ? 'warning' : ticket.status === 'approved' ? 'green' : 'neutral'} />
            {issue && <ProviderIssueBadge issue={issue} />}
          </HStack>
        );
      }
    },
    {
      key: 'timing',
      header: 'Timing',
      width: proportional(1.5),
      renderCell: (ticket) => (
        <Text type="supporting" color="secondary" maxLines={1}>
          {ticket.status === 'pending' && ticket.expiresAt ? `Expires ${dateTime(ticket.expiresAt)}` : ticket.resolvedAt ? `Resolved ${dateTime(ticket.resolvedAt)}` : '—'}
        </Text>
      )
    },
    {
      key: 'actions',
      header: '',
      width: pixel(190),
      renderCell: (ticket) => ticket.status === 'pending' && (
        <HStack justify="end" gap={1}>
          {ticket.direction === 'received' ? (
            <>
              <Button label="Reject" size="sm" variant="secondary" isLoading={isActionLoading(`ticket-reject:${ticket.id}`)} isDisabled={isActionLoading(`ticket-reject:${ticket.id}`)} onClick={() => void onReject(ticket)} />
              <Button label="Approve" size="sm" variant="primary" isDisabled={Boolean(ticket.upstream?.providerIssue) || isActionLoading(`ticket-reject:${ticket.id}`)} onClick={() => onApprove(ticket)} />
            </>
          ) : <Button label="Cancel" size="sm" variant="secondary" isLoading={isActionLoading(`ticket-cancel:${ticket.id}`)} isDisabled={isActionLoading(`ticket-cancel:${ticket.id}`)} onClick={() => void onCancel(ticket)} />}
        </HStack>
      )
    }
  ];
  return <PaginatedSharingTable items={tickets} columns={columns} emailQuery={emailQuery} emptyTitle={emptyTitle} emptyDescription={emptyDescription} tableLabel="Requests table" tablePage={tablePage} />;
}

function SessionsView({
  sessions,
  emailQuery = '',
  emptyTitle,
  emptyDescription,
  onEdit,
  onAddQuota,
  onStatus,
  onRevoke,
  onReveal,
  onRotate,
  onTestConnection,
  testingSessionId,
  tablePage,
  isActionLoading = () => false
}) {
  const columns = [
    { key: 'provider', header: 'Provider', width: proportional(1.5), renderCell: (session) => <Text maxLines={1}>{accountLabel(session.provider)}</Text> },
    { key: 'consumer', header: 'Consumer', width: proportional(1.5), renderCell: (session) => <Text maxLines={1}>{accountLabel(session.consumer)}</Text> },
    {
      key: 'quota',
      header: 'Remaining',
      width: proportional(2),
      renderCell: (session) => {
        const remainingPercent = session.grantedQuotaDollars > 0
          ? Math.min(100, session.remainingQuotaDollars / session.grantedQuotaDollars * 100)
          : 0;
        const quotaVariant = quotaProgressVariant(remainingPercent, ['active', 'paused', 'exhausted'].includes(session.status));
        return (
          <VStack gap={1}>
            <Text weight="bold" maxLines={1}>${money(session.consumedQuotaDollars)} used of ${money(session.grantedQuotaDollars)} · ${money(session.remainingQuotaDollars)} remaining</Text>
            <ProgressBar label="Share quota remaining" isLabelHidden value={remainingPercent} max={100} variant={quotaVariant} />
            {session.isUnderfunded && session.status === 'active' && (
              <Text type="supporting" color="secondary" maxLines={1}>${money(session.backedRemainingQuotaDollars)} currently backed</Text>
            )}
          </VStack>
        );
      }
    },
    {
      key: 'status',
      header: 'Status',
      width: proportional(2),
      renderCell: (session) => {
        const issue = session.status === 'active' ? session.providerIssue : null;
        const hasProviderIssue = Boolean(issue);
        const providerPaused = session.status === 'active' && session.providerSharingStatus === 'paused';
        return (
          <HStack gap={1} wrap="wrap">
            {hasProviderIssue && <ProviderIssueBadge issue={issue} />}
            {providerPaused && <Badge label="Provider paused" variant="warning" />}
            {(!hasProviderIssue && !providerPaused || session.status !== 'active') && (
              <Badge label={session.status} variant={session.status === 'active' ? 'green' : session.status === 'exhausted' ? 'warning' : 'neutral'} />
            )}
            <UpstreamSourceBadge upstream={session.upstream} />
          </HStack>
        );
      }
    },
    {
      key: 'expiry',
      header: 'Expires',
      width: proportional(1.5),
      renderCell: (session) => <Text type="supporting" color="secondary" maxLines={1}>{session.expiresAt ? dateTime(session.expiresAt) : 'No expiry'}</Text>
    },
    { key: 'activity', header: 'Activity', width: proportional(2), renderCell: (session) => <ActivitySummary activity={session.activity} /> },
    {
      key: 'actions',
      header: '',
      width: pixel(220),
      renderCell: (session) => {
        const issue = session.status === 'active' ? session.providerIssue : null;
        const hasProviderIssue = Boolean(issue);
        const providerPaused = session.status === 'active' && session.providerSharingStatus === 'paused';
        return (
          <HStack justify="end" gap={1} wrap="wrap">
            {session.role === 'consumer' && session.status === 'active' && (
              <IconButton label="Test connection" tooltip="Test connection" icon={<PlugZap size={16} />} size="sm" variant="secondary" isLoading={testingSessionId === session.id} isDisabled={testingSessionId === session.id || hasProviderIssue || providerPaused || session.remainingQuotaDollars <= 0} onClick={() => onTestConnection(session)} />
            )}
            {session.canRevealKey && <IconButton label="Reveal key" tooltip="Reveal key" icon={<Eye size={16} />} size="sm" variant="primary" isLoading={isActionLoading(`session-reveal:${session.id}`)} isDisabled={isActionLoading(`session-reveal:${session.id}`)} onClick={() => void onReveal(session)} />}
            {session.canRotateKey && <IconButton label={session.canRevealKey ? 'Generate new key' : 'Generate key'} tooltip={session.canRevealKey ? 'Generate new key' : 'Generate key'} icon={<KeyRound size={16} />} size="sm" variant="primary" isLoading={isActionLoading(`session-rotate:${session.id}`)} isDisabled={isActionLoading(`session-rotate:${session.id}`)} onClick={() => void onRotate(session)} />}
            {session.role === 'provider' && !['revoked', 'exhausted'].includes(session.status) && (
              <IconButton label={session.status === 'paused' ? 'Resume' : 'Pause'} tooltip={session.status === 'paused' ? 'Resume' : 'Pause'} icon={session.status === 'paused' ? <Play size={16} /> : <Pause size={16} />} size="sm" variant="secondary" isLoading={isActionLoading(`session-status:${session.id}`)} isDisabled={isActionLoading(`session-status:${session.id}`)} onClick={() => void onStatus(session, session.status === 'paused' ? 'active' : 'paused')} />
            )}
            {session.role === 'provider' && session.status === 'exhausted' && <IconButton label="Add quota" tooltip="Add quota" icon={<Plus size={16} />} size="sm" variant="primary" onClick={() => onAddQuota(session)} />}
            {session.role === 'provider' && !['revoked', 'exhausted'].includes(session.status) && <IconButton label="Resize quota" tooltip="Resize quota" icon={<Scaling size={16} />} size="sm" variant="secondary" onClick={() => onEdit(session)} />}
            {session.status !== 'revoked' && <IconButton label={session.role === 'consumer' ? 'Leave session' : 'Revoke session'} tooltip={session.role === 'consumer' ? 'Leave session' : 'Revoke session'} icon={session.role === 'consumer' ? <LogOut size={16} /> : <Ban size={16} />} size="sm" variant="secondary" isLoading={isActionLoading(`session-revoke:${session.id}`)} isDisabled={isActionLoading(`session-revoke:${session.id}`)} onClick={() => void onRevoke(session)} />}
          </HStack>
        );
      }
    }
  ];
  return <PaginatedSharingTable items={sessions} columns={columns} emailQuery={emailQuery} emptyTitle={emptyTitle} emptyDescription={emptyDescription} tableLabel="Access table" tablePage={tablePage} />;
}

function QuotaRequestsView({ requests, emailQuery = '', canOffer, onCancel, onOffer, tablePage, isActionLoading = () => false }) {
  const columns = [
    { key: 'requester', header: 'Requester', width: proportional(2), renderCell: (request) => <Text maxLines={1}>{accountLabel(request.requester)}</Text> },
    { key: 'requested', header: 'Requested', width: pixel(130), renderCell: (request) => <Text weight="bold" maxLines={1}>${money(request.quotaDollars)}</Text> },
    { key: 'status', header: 'Status', width: pixel(110), renderCell: (request) => <Badge label={request.status} variant={request.status === 'active' ? 'green' : 'neutral'} /> },
    { key: 'expiry', header: 'Expires', width: proportional(1.5), renderCell: (request) => <Text type="supporting" color="secondary" maxLines={1}>{request.expiresAt ? dateTime(request.expiresAt) : 'No expiry'}</Text> },
    {
      key: 'actions',
      header: '',
      width: pixel(190),
      renderCell: (request) => (
        <HStack justify="end" gap={1}>
          {request.isMine && request.status === 'active' && <Button label="Cancel" size="sm" variant="secondary" isLoading={isActionLoading(`quota-request-cancel:${request.id}`)} isDisabled={isActionLoading(`quota-request-cancel:${request.id}`)} onClick={() => void onCancel(request)} />}
          {!request.isMine && request.status === 'active' && canOffer && <Button label="Publish matching offer" size="sm" variant="primary" onClick={() => onOffer(request)} />}
        </HStack>
      )
    }
  ];
  return <PaginatedSharingTable items={requests} columns={columns} emailQuery={emailQuery} emptyTitle="No friends are asking for quota" emptyDescription="Active requests from Codex Share members will appear here." tableLabel="Quota requests table" tablePage={tablePage} />;
}

function ActivitySummary({ activity }) {
  const details = [activitySummary(activity)];
  if (activity?.models?.length > 0) details.push(`Models: ${activity.models.join(', ')}`);
  if (activity?.recentFailures?.length > 0) {
    details.push(`Recent errors: ${activity.recentFailures.map((failure) => failure.code).join(', ')}`);
  }
  return <Text type="supporting" color="secondary" maxLines={1} hasTruncateTooltip={false}>{details.join(' · ')}</Text>;
}

function ProviderIssueBadge({ issue }) {
  return <Badge label={issue.code === 'provider_reauth_required' ? 'Sign-in required' : 'Unavailable'} variant="error" />;
}

function UpstreamSourceBadge({ upstream }) {
  const isAiswitch = upstream?.quotaSource === 'aiswitch';
  return <Badge label={isAiswitch ? 'aiswitch' : 'codex'} variant={isAiswitch ? 'teal' : 'purple'} />;
}

function CodexLoginCard({ login, onCancel, onRetry }) {
  const waiting = ['starting', 'waiting'].includes(login.status);
  const retryable = ['failed', 'cancelled'].includes(login.status);
  return (
    <Card variant="muted" height="100%" padding={3}>
      <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
        <VStack gap={1}>
          <HStack gap={2} vAlign="center">
            <Text weight="bold" maxLines={1}>Codex sign-in</Text>
            <Badge label={login.status} variant={login.status === 'completed' ? 'green' : login.status === 'failed' ? 'error' : 'warning'} />
          </HStack>
          {login.userCode
            ? <Text maxLines={1}>{`Open ${login.verificationUrl} and enter code ${login.userCode}.`}</Text>
            : <Text type="supporting" color="secondary" maxLines={1}>Starting the OpenAI device sign-in flow...</Text>}
          {login.errorCode && <Text type="supporting" color="secondary" maxLines={1}>{login.errorCode}</Text>}
        </VStack>
        <HStack gap={1}>
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
                  description="Pasted credentials are encrypted in Codex Share and are not saved in browser storage."
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

function AiswitchProjectDialog({ value, onClose, onSave, onChange }) {
  const [guideOpen, setGuideOpen] = useState(false);
  const editing = Boolean(value?.upstream);
  return (
    <>
      <Dialog isOpen={Boolean(value)} onOpenChange={onClose} purpose="form" width={520}>
        <Layout
          header={<DialogHeader title={editing ? 'Edit AISwitch project' : 'Add AISwitch project'} subtitle="Share it through the same offer and session flow as Codex quota" onOpenChange={onClose} hasDivider />}
          content={(
            <LayoutContent>
              {value && <VStack gap={3}>
                <Banner
                  title={editing ? 'Update project details' : 'Manual share budget'}
                  description={editing
                    ? 'Update the project ID or replace the project key. Leave the key blank to keep the current key.'
                    : 'AISwitch quota cannot be queried here. Set the amount currently available for sharing; Codex Share will decrement it only as shared sessions spend.'}
                  status="info"
                />
                <TextInput
                  label="AISwitch project ID"
                  value={value.projectId || ''}
                  onChange={(projectId) => onChange({ ...value, projectId })}
                  hasAutoFocus
                  isRequired
                />
                <TextInput
                  label={editing ? 'New AISwitch project key (optional)' : 'AISwitch project key'}
                  value={value.projectKey || ''}
                  onChange={(projectKey) => onChange({ ...value, projectKey })}
                  placeholder={editing ? 'Leave blank to keep the current key' : undefined}
                  isRequired={!editing}
                />
                {!editing && (
                  <NumberInput
                    label="Manual share budget (USD)"
                    value={value.quotaDollars}
                    onChange={(quotaDollars) => onChange({ ...value, quotaDollars })}
                    min={0.01}
                    step={0.01}
                    isRequired
                  />
                )}
              </VStack>}
            </LayoutContent>
          )}
          footer={(
            <DialogFooter
              startContent={(
                <Link label="How to get AISwitch project" onClick={() => setGuideOpen(true)}>
                  <HStack gap={1} vAlign="center">
                    <Icon icon={CircleHelp} size="sm" />
                    <Text>How to get AISwitch project</Text>
                  </HStack>
                </Link>
              )}
              onClose={onClose}
              onSave={() => onSave(value)}
              saveLabel={editing ? 'Save changes' : 'Add project'}
              isSaveDisabled={!String(value?.projectId || '').trim()
                || (!editing && !String(value?.projectKey || '').trim())
                || (!editing && Number(value?.quotaDollars) <= 0)}
            />
          )}
        />
      </Dialog>
      <AiswitchProjectGuide isOpen={guideOpen} onClose={() => setGuideOpen(false)} />
    </>
  );
}

const AISWITCH_PROJECT_SCRIPT = "fetch('/api/v1/cqp/ccswitch/api_key/get_or_generate',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json()).then(r=>console.log(r.data))";

function AiswitchProjectGuide({ isOpen, onClose }) {
  return (
    <UserGuideDialog
      isOpen={isOpen}
      onClose={onClose}
      title="How to get an AISwitch project"
      subtitle="Retrieve your project ID and API key from Compass"
    >
      <VStack gap={2}>
        <Text weight="bold">1. Open Compass</Text>
        <Text type="supporting" color="secondary">
          Open <Link href="https://compass.llm.shopee.io/integration/my" isExternalLink>compass.llm.shopee.io/integration/my</Link> and sign in.
        </Text>
      </VStack>
      <VStack gap={2}>
        <Text weight="bold">2. Generate or retrieve the project key</Text>
        <Text type="supporting" color="secondary">Open your browser DevTools console, paste this script, and run it.</Text>
        <CodeBlock code={AISWITCH_PROJECT_SCRIPT} language="javascript" hasCopyButton isWrapped width="100%" />
      </VStack>
      <VStack gap={2}>
        <Text weight="bold">3. Enter the returned values</Text>
        <Text type="supporting" color="secondary">
          Copy <Code>project_id</Code> into AISwitch project ID and <Code>api_key</Code> into AISwitch project key in the form.
        </Text>
      </VStack>
    </UserGuideDialog>
  );
}

function ManualBudgetDialog({ value, onClose, onSave, onChange }) {
  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} purpose="form" width={460}>
      <Layout
        header={<DialogHeader title="Set AISwitch share budget" subtitle={value?.upstream?.name} onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            {value && <VStack gap={3}>
              <Banner
                title="Enter the current available amount"
                description="This replaces the pool-side remaining budget. It does not query or change AISwitch itself."
                status="info"
              />
              <NumberInput
                label="Manual share budget (USD)"
                value={value.quotaDollars}
                onChange={(quotaDollars) => onChange({ ...value, quotaDollars })}
                min={0}
                step={0.01}
                isRequired
                hasAutoFocus
              />
            </VStack>}
          </LayoutContent>
        )}
        footer={<DialogFooter onClose={onClose} onSave={() => onSave(value)} saveLabel="Set budget" isSaveDisabled={!Number.isFinite(Number(value?.quotaDollars)) || Number(value?.quotaDollars) < 0} />}
      />
    </Dialog>
  );
}

function OfferDialog({ value, upstreams, offerableUpstreams, onClose, onSave, onChange }) {
  const selectedUpstream = upstreams.find((item) => item.id === value?.upstreamId) || value?.offer?.upstream;
  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} purpose="form" width={460}>
      <Layout
        header={<DialogHeader title={value?.offer ? 'Edit offer' : 'Publish offer'} onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            {value && <VStack gap={3}>
              {value.offer ? (
                <TextInput label="Share source" value={selectedUpstream?.name || ''} isDisabled />
              ) : (
                <Selector
                  label="Share source"
                  options={offerableUpstreams.map((upstream) => ({
                    value: upstream.id,
                    label: `${upstream.name} · ${upstream.quotaSource === 'aiswitch' ? 'AISwitch' : 'Codex'}`
                  }))}
                  value={value.upstreamId}
                  onChange={(upstreamId) => onChange((current) => ({ ...current, upstreamId }))}
                  width="100%"
                />
              )}
              <NumberInput
                label="Shareable quota (USD)"
                value={value.quotaDollars}
                onChange={(quotaDollars) => onChange((current) => ({ ...current, quotaDollars }))}
                onInput={(event) => {
                  const quotaInputValid = event.currentTarget.validity.valid;
                  onChange((current) => ({ ...current, quotaInputValid }));
                }}
                min={0.01}
                step={0.01}
                isRequired
              />
              <DateInput
                label="Expires on"
                value={value.expiresOn || undefined}
                onChange={(expiresOn) => onChange({ ...value, expiresOn: expiresOn || '' })}
                min={todayDate()}
                isOptional
                hasClear
                width="100%"
              />
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
        footer={(
          <DialogFooter
            onClose={onClose}
            onSave={() => onSave(value)}
            saveLabel={value?.offer ? 'Save offer' : 'Publish'}
            isSaveDisabled={value?.quotaInputValid === false}
          />
        )}
      />
    </Dialog>
  );
}

function PersonalKeyDialog({ value, onClose, onSave, onChange }) {
  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} purpose="form" width={460}>
      <Layout
        header={<DialogHeader title="Create pool key" subtitle="Use a separate key for each device or client" onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            {value && (
              <VStack gap={3}>
                <TextInput
                  label="Key name"
                  value={value.name}
                  onChange={(name) => onChange({ ...value, name })}
                  placeholder="Laptop, CI, editor"
                  hasAutoFocus
                />
                <DateInput
                  label="Expires on"
                  value={value.expiresOn || undefined}
                  onChange={(expiresOn) => onChange({ ...value, expiresOn: expiresOn || '' })}
                  min={todayDate()}
                  isOptional
                  hasClear
                  width="100%"
                />
              </VStack>
            )}
          </LayoutContent>
        )}
        footer={(
          <DialogFooter
            onClose={onClose}
            onSave={() => onSave(value)}
            saveLabel="Create key"
            isSaveDisabled={!value?.name.trim()}
          />
        )}
      />
    </Dialog>
  );
}

function QuotaRequestDialog({ value, onClose, onSave, onChange }) {
  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} purpose="form" width={460}>
      <Layout
        header={<DialogHeader title="Ask friends for quota" onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            {value && (
              <VStack gap={3}>
                <NumberInput
                  label="Quota needed (USD)"
                  value={value.quotaDollars}
                  onChange={(quotaDollars) => onChange((current) => ({ ...current, quotaDollars }))}
                  onInput={(event) => {
                    const quotaInputValid = event.currentTarget.validity.valid;
                    onChange((current) => ({ ...current, quotaInputValid }));
                  }}
                  min={0.01}
                  step={0.01}
                  isRequired
                />
                <DateInput
                  label="Expires on"
                  value={value.expiresOn || undefined}
                  onChange={(expiresOn) => onChange({ ...value, expiresOn: expiresOn || '' })}
                  min={todayDate()}
                  isOptional
                  hasClear
                  width="100%"
                />
              </VStack>
            )}
          </LayoutContent>
        )}
        footer={(
          <DialogFooter
            onClose={onClose}
            onSave={() => onSave(value)}
            saveLabel="Post request"
            isSaveDisabled={value?.quotaInputValid === false}
          />
        )}
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
            {value && (
              <NumberInput
                label="Approved quota (USD)"
                value={value.quotaDollars}
                onChange={(quotaDollars) => onChange((current) => ({ ...current, quotaDollars }))}
                onInput={(event) => {
                  const quotaInputValid = event.currentTarget.validity.valid;
                  onChange((current) => ({ ...current, quotaInputValid }));
                }}
                min={0.01}
                step={0.01}
                isRequired
              />
            )}
          </LayoutContent>
        )}
        footer={(
          <DialogFooter
            onClose={onClose}
            onSave={() => onSave(value)}
            saveLabel="Approve"
            isSaveDisabled={value?.quotaInputValid === false}
          />
        )}
      />
    </Dialog>
  );
}

function SessionDialog({ value, onClose, onSave, onChange }) {
  const addingQuota = value?.mode === 'add';
  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} purpose="form" width={420}>
      <Layout
        header={<DialogHeader title={addingQuota ? 'Add session quota' : 'Resize share session'} subtitle={accountLabel(value?.session.consumer)} onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            {value && (
              <VStack gap={3}>
                <NumberInput
                  label={addingQuota ? 'Additional quota (USD)' : 'Granted quota (USD)'}
                  value={value.quotaDollars}
                  onChange={(quotaDollars) => onChange((current) => ({ ...current, quotaDollars }))}
                  onInput={(event) => {
                    const quotaInputValid = event.currentTarget.validity.valid;
                    onChange((current) => ({ ...current, quotaInputValid }));
                  }}
                  min={addingQuota ? 0.01 : value.session.consumedQuotaDollars}
                  step={0.01}
                  isRequired
                />
                {!addingQuota && (
                  <DateInput
                    label="Expires on"
                    description="Can only be extended, subject to the provider quota reset."
                    value={value.expiresOn || undefined}
                    onChange={(expiresOn) => onChange((current) => ({ ...current, expiresOn: expiresOn || '' }))}
                    min={value.expiresOn || todayDate()}
                    isRequired
                    width="100%"
                  />
                )}
              </VStack>
            )}
          </LayoutContent>
        )}
        footer={(
          <DialogFooter
            onClose={onClose}
            onSave={() => onSave(value)}
            saveLabel={addingQuota ? 'Add quota' : 'Update quota'}
            isSaveDisabled={value?.quotaInputValid === false}
          />
        )}
      />
    </Dialog>
  );
}

function KeyDialog({ value, onClose, onNotice }) {
  const personal = value?.personal;
  const [modelState, setModelState] = useState({ status: 'idle', ids: [] });
  useEffect(() => {
    if (!value?.apiKey) {
      setModelState({ status: 'idle', ids: [] });
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setModelState({ status: 'loading', ids: [] });
    void fetch(appUrl('/v1/models'), {
      headers: { authorization: `Bearer ${value.apiKey}` },
      signal: controller.signal
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error('Unable to load models');
        return [...new Set((body.data || []).map((model) => model.id).filter(Boolean))];
      })
      .then((ids) => {
        if (active) setModelState({ status: 'loaded', ids });
      })
      .catch((error) => {
        if (active && error.name !== 'AbortError') setModelState({ status: 'error', ids: [] });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [value?.apiKey]);
  const models = modelState.status === 'loading'
    ? 'Loading available models…'
    : modelState.status === 'error'
      ? 'Unable to load models.'
      : modelState.ids.join(', ') || 'No models available.';
  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} width={600}>
      <Layout
        header={<DialogHeader title={personal ? value?.name || 'Pool key' : 'Share session API key'} subtitle={personal ? 'Routes each request to one of your active share sessions' : 'Available until this share session is revoked'} onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            <VStack gap={3}>
              {!personal && (
                <Banner
                  title="Use your Personal API key for uninterrupted access"
                  description="This key works only for this session. Use a Personal API key to route requests across all your active share sessions and avoid interruptions when this session ends."
                  status="info"
                />
              )}
              <TextInput label="API key" value={value?.apiKey || ''} isReadOnly />
              <TextInput label="API base URL" value={apiBaseUrl()} isReadOnly />
              <VStack gap={1}>
                <FieldLabel label="Available models" inputID="available-models" isGroupLabel />
                <Text type="supporting">{models}</Text>
              </VStack>
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

function CredentialsDialog({ value, onClose, onChange, onNotice }) {
  const selected = value?.entries.find((entry) => entry.id === value.selectedId);
  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} width={640}>
      <Layout
        header={<DialogHeader title="Current credentials" subtitle={selected?.name} onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            <VStack gap={3}>
              <Banner title="Provider credentials" description="This is the current credential data for your linked provider." status="warning" />
              {value?.entries.length > 1 && (
                <Selector
                  label="Provider"
                  options={value.entries.map((entry) => ({ value: entry.id, label: entry.name }))}
                  value={value.selectedId}
                  onChange={(selectedId) => onChange({ ...value, selectedId })}
                  width="100%"
                />
              )}
              <TextArea label="Credential data" value={selected ? JSON.stringify(selected.credentials, null, 2) : ''} rows={20} isReadOnly hasSpellCheck={false} />
            </VStack>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter hasDivider>
            <HStack justify="end" gap={2}>
              <Button label="Copy" variant="primary" onClick={async () => {
                await navigator.clipboard.writeText(JSON.stringify(selected.credentials, null, 2));
                onNotice('Credentials copied');
              }} />
              <Button label="Done" variant="secondary" onClick={onClose} />
            </HStack>
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function DialogFooter({ startContent = null, onClose, onSave, saveLabel, isSaveDisabled = false }) {
  const [isSaving, setIsSaving] = useState(false);
  const save = async () => {
    if (isSaving || isSaveDisabled) return;
    setIsSaving(true);
    try {
      await onSave();
    } finally {
      setIsSaving(false);
    }
  };
  return (
    <LayoutFooter hasDivider>
      <HStack justify={startContent ? 'between' : 'end'} vAlign="center" gap={2} wrap="wrap">
        {startContent}
        <HStack gap={2}>
          <Button label="Cancel" variant="secondary" isDisabled={isSaving} onClick={onClose} />
          <Button label={saveLabel} variant="primary" isLoading={isSaving} isDisabled={isSaveDisabled || isSaving} onClick={() => void save()} />
        </HStack>
      </HStack>
    </LayoutFooter>
  );
}

function quotaProgressVariant(value, isAvailable = true) {
  if (!isAvailable || !Number.isFinite(value)) return 'neutral';
  const percentage = Math.max(0, Math.min(100, value));
  if (percentage <= 15) return 'error';
  if (percentage <= 30) return 'warning';
  return 'success';
}

function apiBaseUrl() {
  return appUrl('/v1');
}

function appUrl(path) {
  return new URL(String(path).replace(/^\//, ''), document.baseURI).toString();
}

function filteredEmptyState(query, defaultTitle, defaultDescription) {
  const displayedQuery = query.trim();
  return (
    <EmptyState
      title={displayedQuery ? 'No matching accounts' : defaultTitle}
      description={displayedQuery
        ? `No provider or consumer email matches "${displayedQuery}".`
        : defaultDescription}
    />
  );
}

function accountLabel(account) {
  return account?.email || account?.displayName || 'Unknown account';
}

function quotaRemaining(quota) {
  if (!quota) return 'Quota has not been refreshed';
  if (Number.isFinite(quota.remainingDollars)) return `$${money(quota.remainingDollars)} left`;
  if (Number.isFinite(quota.remainingPercent)) return `${money(quota.remainingPercent)}% left`;
  if (Number.isFinite(quota.remainingUnits)) return `${money(quota.remainingUnits)} units left`;
  return 'Quota available';
}

function quotaTiming(quota) {
  const reset = quota?.resetAt ? `Resets ${dateTime(quota.resetAt)}` : 'Reset time unavailable';
  return quota?.observedAt ? `${reset} · Updated ${dateTime(quota.observedAt)}` : reset;
}

function activitySummary(activity) {
  if (!activity || activity.requestCount === 0) return 'No API activity yet';
  const lastUsed = activity.lastUsedAt ? ` · Last used ${dateTime(activity.lastUsedAt)}` : '';
  return `${activity.successCount} of ${activity.requestCount} requests succeeded · $${money(activity.spendTodayDollars)} today · $${money(activity.totalSpendDollars)} total${lastUsed}`;
}

function todayDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function dateFromTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toISOString().slice(0, 10);
}

function expiryTimestamp(value) {
  if (!value) return null;
  const date = new Date(`${value}T23:59:59.999`);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
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

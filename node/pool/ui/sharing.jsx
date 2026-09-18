import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Pagination } from '@astryxdesign/core/Pagination';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Switch } from '@astryxdesign/core/Switch';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { HStack, Layout, LayoutContent, LayoutFooter, StackItem, VStack } from '@astryxdesign/core/Layout';
import { Ban, CircleHelp, Eye, KeyRound, LogOut, Pause, Play, PlugZap, Plus, Scaling } from 'lucide-react';
import { UserGuideDialog } from './UserGuideDialog.jsx';
import { useLanguage } from './i18n.jsx';

const SHARING_VIEWS = new Set([
  'community-offers',
  'my-offers',
  'sent-requests',
  'approvals',
  'my-access',
  'shared-by-me'
]);
const PROVIDER_SECTIONS = new Set(['my-offers', 'approvals', 'shared-by-me']);
const CONSUMER_SECTIONS = new Set(['community-offers', 'sent-requests', 'my-access']);
const SHARING_VIEW_STORAGE_KEY = 'codex_pool_sharing_view';
const SHARING_SECTION_STORAGE_KEY = 'codex_pool_sharing_section';
const SHARING_CARD_GRID_COLUMNS = { minWidth: 280, max: 3, repeat: 'fill' };
const LOGIN_CARD_GRID_COLUMNS = { minWidth: 280, max: 2, repeat: 'fill' };
const PROVIDER_CARD_GRID_COLUMNS = { minWidth: 220, max: 3, repeat: 'fit' };
const PROVIDER_RANK = { codex: 0, ais: 1, aiswitch: 1, claude: 2 };
function upstreamProviderRank(u) {
  return PROVIDER_RANK[u?.type] ?? PROVIDER_RANK[u?.quotaSource] ?? 3;
}
const SHARING_LIST_CONFIG = {
  'community-offers': { resource: 'offers', key: 'offers', role: 'community' },
  'my-offers': { resource: 'offers', key: 'offers', role: 'mine' },
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

function initialSharingSection(initialView) {
  try {
    const stored = window.localStorage.getItem(SHARING_SECTION_STORAGE_KEY);
    if (stored === 'provider' || stored === 'consumer') return stored;
  } catch {}
  return PROVIDER_SECTIONS.has(initialView) ? 'provider' : 'consumer';
}

function csrfToken() {
  for (const item of document.cookie.split(';')) {
    const [name, ...parts] = item.trim().split('=');
    if (name !== 'codex_pool_csrf') continue;
    try { return decodeURIComponent(parts.join('=')); } catch { return ''; }
  }
  return '';
}

function connectionSuccessMessage(t, connection) {
  const answer = typeof connection?.answer === 'string' && connection.answer.trim() ? t('connectionAnswer', { answer: connection.answer.trim() }) : '';
  return t('connectionSuccess', { endpoint: connection.endpoint, model: connection.model, latency: connection.latencyMs, answer });
}

const STATUS_LABEL_KEYS = {
  active: 'active',
  paused: 'paused',
  closed: 'closed',
  pending: 'statusPending',
  approved: 'statusApproved',
  rejected: 'statusRejected',
  cancelled: 'statusCancelled',
  expired: 'statusExpired',
  exhausted: 'statusExhausted',
  revoked: 'statusRevoked',
  starting: 'loginStatusStarting',
  waiting: 'loginStatusWaiting',
  completed: 'loginStatusCompleted',
  failed: 'loginStatusFailed'
};

function statusLabel(t, status) {
  return t(STATUS_LABEL_KEYS[status] || status);
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

export function SharingWorkspace({ onNotice, onLoadingChange = () => {} }) {
  const { t } = useLanguage();
  const api = useSharingApi();
  const [account, setAccount] = useState(null);
  const [view, setView] = useState(initialSharingView);
  const [section, setSection] = useState(() => initialSharingSection(initialSharingView()));
  const [tablePage, setTablePage] = useState({ items: [], totalItems: 0, hasMore: false, nextOffset: null });
  const [tableTotals, setTableTotals] = useState({});
  const [tableOffset, setTableOffset] = useState(0);
  const [tablePageSize, setTablePageSize] = useState(10);
  const [showPastData, setShowPastData] = useState(false);
  const [upstreams, setUpstreams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [smartSession, setSmartSession] = useState(() => {
    try { return window.localStorage.getItem('session'); } catch { return null; }
  });
  const [smartAuthenticating, setSmartAuthenticating] = useState(false);
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
  const [login, setLogin] = useState(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [authJsonDialog, setAuthJsonDialog] = useState(false);
  const [authJson, setAuthJson] = useState('');
  const [authJsonLoading, setAuthJsonLoading] = useState(false);
  const [aisDialog, setAisDialog] = useState(null);
  const [claudeDialog, setClaudeDialog] = useState(null);
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
            onNotice(t('signedInWithCodex'));
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
  }, [api, onNotice, t]);

  const syncSmartSession = useCallback(async (sessionVal) => {
    if (!sessionVal) return;
    setSmartAuthenticating(true);
    try {
      await api('/auth/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: sessionVal })
      });
      await load();
    } catch (err) {
      onNotice(err.message || t('smartAuthFailedToast'), true);
    } finally {
      setSmartAuthenticating(false);
    }
  }, [api, load, onNotice, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handleFocusOrVisible = () => {
      let currentSession = null;
      try {
        currentSession = window.localStorage.getItem('session');
      } catch {}
      setSmartSession(currentSession);
      if (currentSession && !account && !smartAuthenticating) {
        void syncSmartSession(currentSession);
      }
    };

    window.addEventListener('focus', handleFocusOrVisible);
    document.addEventListener('visibilitychange', handleFocusOrVisible);
    window.addEventListener('storage', handleFocusOrVisible);

    // Initial check on mount if localStorage already has session
    let initialSession = null;
    try { initialSession = window.localStorage.getItem('session'); } catch {}
    if (initialSession && !account) {
      void syncSmartSession(initialSession);
    }

    return () => {
      window.removeEventListener('focus', handleFocusOrVisible);
      document.removeEventListener('visibilitychange', handleFocusOrVisible);
      window.removeEventListener('storage', handleFocusOrVisible);
    };
  }, [account, smartAuthenticating, syncSmartSession]);

  useEffect(() => {
    onLoadingChange(loading);
    return () => onLoadingChange(false);
  }, [loading, onLoadingChange]);

  const loadTable = useCallback(async ({ background = true } = {}) => {
    if (!account) return;
    const requestVersion = ++tableRequestVersion.current;
    const config = SHARING_LIST_CONFIG[view];
    const params = new URLSearchParams({
      limit: String(tablePageSize),
      offset: String(tableOffset),
      includePast: String(showPastData)
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
        nextOffset: data.nextOffset ?? null
      });
    } catch (nextError) {
      if (requestVersion !== tableRequestVersion.current) return;
      if (!background) onNotice(nextError.message, true);
    }
  }, [account, api, emailQuery, onNotice, showPastData, tableOffset, tablePageSize, view]);

  useEffect(() => {
    if (!account) return undefined;
    const timer = window.setTimeout(() => void loadTable(), emailQuery.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [account, emailQuery, loadTable]);

  const handleSectionChange = useCallback((nextSection) => {
    setSection(nextSection);
    try {
      window.localStorage.setItem(SHARING_SECTION_STORAGE_KEY, nextSection);
    } catch {}
    if (nextSection === 'provider') {
      if (!PROVIDER_SECTIONS.has(view)) {
        setView('my-offers');
        try { window.localStorage.setItem(SHARING_VIEW_STORAGE_KEY, 'my-offers'); } catch {}
      }
    } else {
      if (!CONSUMER_SECTIONS.has(view)) {
        setView('community-offers');
        try { window.localStorage.setItem(SHARING_VIEW_STORAGE_KEY, 'community-offers'); } catch {}
      }
    }
    setTableOffset(0);
    resetTablePage();
  }, [resetTablePage, view]);

  const handleViewChange = useCallback((nextView) => {
    setView(nextView);
    try {
      window.localStorage.setItem(SHARING_VIEW_STORAGE_KEY, nextView);
    } catch {}
    if (PROVIDER_SECTIONS.has(nextView)) {
      setSection('provider');
      try { window.localStorage.setItem(SHARING_SECTION_STORAGE_KEY, 'provider'); } catch {}
    } else if (CONSUMER_SECTIONS.has(nextView)) {
      setSection('consumer');
      try { window.localStorage.setItem(SHARING_SECTION_STORAGE_KEY, 'consumer'); } catch {}
    }
    setTableOffset(0);
    resetTablePage();
  }, [resetTablePage]);

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
          onNotice(t('signedInWithCodex'));
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
  }, [api, load, login, onNotice, t]);

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
      onNotice(t('codexSignInCancelled'));
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
      onNotice(t('signedInFromAuthJson'));
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
    try { window.localStorage.removeItem('session'); } catch {}
    setSmartSession(null);
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
      if (!silent) onNotice(t('aisQuotaExternal'));
      return;
    }
    setQuotaRefreshing(true);
    try {
      await Promise.all(refreshable.map((upstream) => api(`/api/pool/upstreams/${upstream.id}/refresh-quota`, {
        method: 'POST',
        body: '{}'
      })));
      if (!silent) onNotice(t('codexQuotaRefreshed'));
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
        onNotice(t('noProviderCredentials'), true);
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
      onNotice(connectionSuccessMessage(t, connection));
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
      onNotice(connectionSuccessMessage(t, connection));
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
    const hasSmartSession = !!smartSession;
    return (
      <VStack gap={2}>
        <Grid columns={LOGIN_CARD_GRID_COLUMNS} gap={2} minHeight={120}>
          <Card height="100%" padding={3}>
            <VStack height="100%" justify="between" gap={2}>
              <VStack gap={1}>
                <Heading level={2} maxLines={1}>{t('quotaSharing')}</Heading>
                <Text type="supporting" color="secondary" maxLines={1}>
                  {!hasSmartSession
                    ? t('loginSmartPrompt')
                    : t('authenticatingSmart')}
                </Text>
              </VStack>
              {!hasSmartSession ? (
                <HStack justify="end" gap={1} wrap="wrap">
                  <Button
                    label={t('loginWithSmart')}
                    variant="primary"
                    onClick={() => {
                      window.open('/login', '_blank', 'noopener,noreferrer');
                    }}
                  />
                </HStack>
              ) : (
                <HStack justify="end" gap={1} wrap="wrap">
                  <Button
                    label={t('authenticating')}
                    variant="primary"
                    isLoading={true}
                    disabled={true}
                  />
                </HStack>
              )}
            </VStack>
          </Card>
        </Grid>
        <CodexLoginDialog
          login={login}
          onClose={() => setLogin(null)}
          onRetry={() => void startCodexLogin()}
          onCancel={() => void cancelCodexLogin()}
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
      </VStack>
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
    <VStack gap={2}>
      <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
        <VStack gap={1}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Heading level={2}>{t('quotaSharing')}</Heading>
            <Badge label={accountLabel(account, t)} variant="neutral" />
          </HStack>
        </VStack>
        <HStack gap={1} wrap="wrap">
          <Button label={t('signOut')} variant="secondary" onClick={() => void logout()} />
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
            onAddAis={() => setAisDialog({ projectId: '', projectKey: '' })}
            onEditAis={(upstream) => setAisDialog({
              upstream,
              projectId: upstream.projectId || '',
              projectKey: ''
            })}
            onAddClaude={() => setClaudeDialog({ oauthToken: '', authJson: '' })}
            onEditClaude={(upstream) => setClaudeDialog({
              upstream,
              oauthToken: '',
              authJson: ''
            })}
            onRevealCredentials={() => void revealCredentials()}
            onTestConnection={(upstream) => void testConnection(upstream)}
            testingUpstreamId={testingUpstreamId}
            onToggleSharing={(upstream) => void mutate(
              () => api(`/api/pool/providers/${upstream.id}/${upstream.sharing?.status === 'paused' ? 'resume' : 'pause'}`, {
                method: 'POST',
                body: '{}'
              }),
              upstream.sharing?.status === 'paused' ? t('sharingResumed') : t('sharingPaused'),
              `provider-sharing:${upstream.id}`
            )}
            isActionLoading={isActionLoading}
            onRevokeAll={setProviderRevokeTarget}
          />
        </GridSpan>
        <PersonalKeyCard
          personalKeys={showPastData ? personalKeys : personalKeys.filter((key) => key.status === 'active')}
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
      <CodexLoginDialog
        login={login}
        onClose={() => setLogin(null)}
        onRetry={() => void startCodexLogin()}
        onCancel={() => void cancelCodexLogin()}
      />
      <VStack gap={2}>
        <VStack paddingBlock={1}>
          <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
            <SegmentedControl
              label={t('dashboardSection')}
              value={section}
              onChange={handleSectionChange}
              size="lg"
              layout="hug"
            >
              <SegmentedControlItem value="provider" label={t('forProviders')} />
              <SegmentedControlItem value="consumer" label={t('forConsumers')} />
            </SegmentedControl>
          </HStack>
        </VStack>

        <VStack paddingBlock={2}>
          <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          {section === 'provider' ? (
            <SegmentedControl label={t('providerTabs')} value={view} onChange={handleViewChange} size="md" layout="hug">
              <SegmentedControlItem value="my-offers" label={tabLabel(t('tabMyOffers'), 'my-offers')} />
              <SegmentedControlItem value="approvals" label={tabLabel(t('tabApprovals'), 'approvals')} />
              <SegmentedControlItem value="shared-by-me" label={tabLabel(t('tabSharedByMe'), 'shared-by-me')} />
            </SegmentedControl>
          ) : (
            <SegmentedControl label={t('consumerTabs')} value={view} onChange={handleViewChange} size="md" layout="hug">
              <SegmentedControlItem value="community-offers" label={tabLabel(t('tabCommunityOffers'), 'community-offers')} />
              <SegmentedControlItem value="my-access" label={tabLabel(t('tabMyAccess'), 'my-access')} />
              <SegmentedControlItem value="sent-requests" label={tabLabel(t('tabSentRequests'), 'sent-requests')} />
            </SegmentedControl>
          )}
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Switch
              label={t('seePastData')}
              value={showPastData}
              onChange={(nextShowPastData) => {
                setShowPastData(nextShowPastData);
                setTableOffset(0);
                resetTablePage();
              }}
            />
            <TextInput
              label={t('searchByEmailLabel')}
              isLabelHidden
              value={emailQuery}
              onChange={(nextQuery) => {
                setEmailQuery(typeof nextQuery === 'string' ? nextQuery : nextQuery?.target?.value || '');
                setTableOffset(0);
                resetTablePage();
              }}
              placeholder={t('searchByEmail')}
              hasClear
              width={300}
            />
            {offerableUpstreams.length > 0 && (
              <Button label={t('publishOffer')} variant="primary" onClick={() => setOfferDialog({ upstreamId: offerableUpstreams[0].id, quotaDollars: 10, expiresOn: '', visibility: 'public', allowedEmails: '' })} />
            )}
          </HStack>
          </HStack>
        </VStack>

      {view === 'community-offers' && (
        <OffersView
          offers={communityOffers}
          upstreams={upstreams}
          emailQuery={emailQuery}
          tablePage={sharingTable}
          emptyTitle={t('emptyCommunityOffersTitle')}
          emptyDescription={t('emptyCommunityOffersDesc')}
          onRequest={(offer) => void mutate(async () => {
            await api('/api/pool/tickets', {
              method: 'POST',
              body: JSON.stringify({ offerId: offer.id })
            });
          }, t('requestedQuotaToast', { amount: money(offer.availableDollars) }), `offer-request:${offer.id}`)}
          isActionLoading={isActionLoading}
          onEdit={(offer) => setOfferDialog({
            offer,
            upstreamId: offer.upstream.id,
            quotaDollars: offer.quotaDollars,
            status: offer.status,
            visibility: offer.visibility || 'public',
            allowedEmails: Array.isArray(offer.allowedEmails) ? offer.allowedEmails.join(', ') : '',
            expiresOn: dateFromTimestamp(offer.expiresAt)
          })}
        />
      )}
      {view === 'my-offers' && (
        <OffersView
          offers={myOffers}
          tablePage={sharingTable}
          emailQuery={emailQuery}
          emptyTitle={t('emptyMyOffersTitle')}
          emptyDescription={upstreams.length ? t('emptyMyOffersDesc') : t('noUpstreamForOffers')}
          onEdit={(offer) => setOfferDialog({
            offer,
            upstreamId: offer.upstream.id,
            quotaDollars: offer.quotaDollars,
            status: offer.status,
            visibility: offer.visibility || 'public',
            allowedEmails: Array.isArray(offer.allowedEmails) ? offer.allowedEmails.join(', ') : '',
            expiresOn: dateFromTimestamp(offer.expiresAt)
          })}
        />
      )}
      {view === 'sent-requests' && (
        <TicketsView
          tickets={sentTickets}
          tablePage={sharingTable}
          emailQuery={emailQuery}
          emptyTitle={t('emptySentRequestsTitle')}
          emptyDescription={t('emptySentRequestsDesc')}
          onCancel={(ticket) => void mutate(() => api(`/api/pool/tickets/${ticket.id}/cancel`, { method: 'POST', body: '{}' }), t('ticketCancelled'), `ticket-cancel:${ticket.id}`)}
          isActionLoading={isActionLoading}
        />
      )}
      {view === 'approvals' && (
        <TicketsView
          tickets={receivedTickets}
          tablePage={sharingTable}
          emailQuery={emailQuery}
          emptyTitle={t('emptyApprovalsTitle')}
          emptyDescription={t('emptyApprovalsDesc')}
          onApprove={(ticket) => setTicketDialog({ ticket, quotaDollars: ticket.requestedQuotaDollars, approval: true })}
          onReject={(ticket) => void mutate(() => api(`/api/pool/tickets/${ticket.id}/reject`, { method: 'POST', body: '{}' }), t('ticketRejected'), `ticket-reject:${ticket.id}`)}
          onCancel={(ticket) => void mutate(() => api(`/api/pool/tickets/${ticket.id}/cancel`, { method: 'POST', body: '{}' }), t('ticketCancelled'), `ticket-cancel:${ticket.id}`)}
          isActionLoading={isActionLoading}
        />
      )}
      {view === 'my-access' && (
        <SessionsView
          sessions={requestedSessions}
          tablePage={sharingTable}
          emailQuery={emailQuery}
          emptyTitle={t('emptyMyAccessTitle')}
          emptyDescription={t('emptyMyAccessDesc')}
          onTestConnection={(session) => void testSessionConnection(session)}
          testingSessionId={testingSessionId}
          onStatus={(session, status) => void mutate(
            () => api(`/api/pool/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
            status === 'active' ? t('sessionResumed') : t('sessionPaused'),
            `session-status:${session.id}`
          )}
          onRevoke={(session) => void mutate(
            () => api(`/api/pool/sessions/${session.id}/revoke`, { method: 'POST', body: '{}' }),
            t('sessionRevoked'),
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
          emptyTitle={t('emptySharedByMeTitle')}
          emptyDescription={t('emptySharedByMeDesc')}
          onEdit={(session) => setSessionDialog({
            session,
            quotaDollars: session.grantedQuotaDollars,
            expiresOn: dateFromTimestamp(session.expiresAt),
            mode: 'resize'
          })}
          onAddQuota={(session) => setSessionDialog({ session, quotaDollars: 1, mode: 'add' })}
          onStatus={(session, status) => void mutate(
            () => api(`/api/pool/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
            status === 'active' ? t('sessionResumed') : t('sessionPaused'),
            `session-status:${session.id}`
          )}
          onRevoke={(session) => void mutate(
            () => api(`/api/pool/sessions/${session.id}/revoke`, { method: 'POST', body: '{}' }),
            t('sessionRevoked'),
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
              visibility: value.visibility || 'public',
              allowedEmails: value.visibility === 'restricted'
                ? (value.allowedEmails || '').split(',').map((e) => e.trim()).filter(Boolean)
                : [],
              ...(value.offer ? { status: value.status } : {})
            })
          });
          setOfferDialog(null);
        }, value.offer ? t('offerUpdated') : t('offerPublished'))}
        onChange={setOfferDialog}
      />
      <AisProjectDialog
        value={aisDialog}
        onClose={() => setAisDialog(null)}
        onChange={setAisDialog}
        onSave={(value) => mutate(async () => {
          const editing = Boolean(value.upstream);
          await api(editing ? `/api/pool/upstreams/${value.upstream.id}` : '/api/pool/upstreams/ais', {
            method: editing ? 'PATCH' : 'POST',
            body: JSON.stringify(editing
              ? {
                  projectId: value.projectId,
                  ...(value.projectKey.trim() ? { projectKey: value.projectKey } : {})
                }
              : value)
          });
          setAisDialog(null);
        }, aisDialog?.upstream ? t('aisProjectUpdated') : t('aisProjectAdded'))}
      />
      <ClaudeUpstreamDialog
        value={claudeDialog}
        onClose={() => setClaudeDialog(null)}
        onChange={setClaudeDialog}
        onSave={(value) => mutate(async () => {
          const editing = Boolean(value.upstream);
          await api(editing ? `/api/pool/upstreams/${value.upstream.id}` : '/api/pool/upstreams/claude', {
            method: editing ? 'PATCH' : 'POST',
            body: JSON.stringify(value)
          });
          setClaudeDialog(null);
        }, claudeDialog?.upstream ? t('claudeAccountUpdated') : t('claudeAccountLinked'))}
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
        }, t('poolKeyCreated'))}
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
        }, t('ticketApproved'))}
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
        }, sessionDialog?.mode === 'add' ? t('sessionQuotaAdded') : t('sessionUpdated'))}
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
        title={t('revokeKeyConfirmTitle')}
        description={personalKeyRevokeTarget
          ? t('revokeKeyConfirmDesc', { name: personalKeyRevokeTarget.name })
          : ''}
        actionLabel={t('revokeAction')}
        actionVariant="destructive"
        isActionLoading={personalKeyActionLoading}
        onAction={async () => {
          const target = personalKeyRevokeTarget;
          if (!target) return;
          setPersonalKeyActionLoading(true);
          const changed = await mutate(() => api(`/api/pool/personal-keys/${target.id}/revoke`, { method: 'POST', body: '{}' }), t('poolKeyRevoked'));
          setPersonalKeyActionLoading(false);
          if (changed) setPersonalKeyRevokeTarget(null);
        }}
      />
      <AlertDialog
        isOpen={Boolean(providerRevokeTarget)}
        onOpenChange={(isOpen) => { if (!isOpen && !providerActionLoading) setProviderRevokeTarget(null); }}
        title={t('revokeAllSharingTitle')}
        description={providerRevokeTarget
          ? t('revokeAllSharingDesc', { name: providerRevokeTarget.name })
          : ''}
        actionLabel={t('revokeAllAction')}
        actionVariant="destructive"
        isActionLoading={providerActionLoading}
        onAction={async () => {
          const target = providerRevokeTarget;
          if (!target) return;
          setProviderActionLoading(true);
          const changed = await mutate(
            () => api(`/api/pool/providers/${target.id}/revoke-all`, { method: 'POST', body: '{}' }),
            t('providerSharingRevoked')
          );
          setProviderActionLoading(false);
          if (changed) setProviderRevokeTarget(null);
        }}
      />
    </VStack>
  );
}

function QuotaOverview({
  upstreams,
  isRefreshing,
  onRefresh,
  onLinkCodex,
  onImportAuthJson,
  onAddAis,
  onEditAis,
  onAddClaude,
  onEditClaude,
  onRevealCredentials,
  onTestConnection,
  testingUpstreamId,
  onToggleSharing,
  onRevokeAll,
  isActionLoading = () => false
}) {
  const { t } = useLanguage();
  const orderedUpstreams = useMemo(() => (
    [...upstreams].sort((left, right) => upstreamProviderRank(left) - upstreamProviderRank(right))
  ), [upstreams]);
  if (!upstreams.length) {
    return (
      <Card variant="muted" padding={3}>
        <VStack gap={2} hAlign="center">
          <VStack gap={1} hAlign="center">
            <Heading level={3} maxLines={1}>{t('noShareProviderLinked')}</Heading>
            <Text type="supporting" color="secondary" maxLines={1}>{t('noShareProviderDesc')}</Text>
          </VStack>
          <HStack justify="center" gap={1} wrap="wrap">
            <Button label={t('linkCodex')} size="sm" variant="secondary" onClick={onLinkCodex} />
            <Button label={t('linkClaude')} size="sm" variant="secondary" onClick={onAddClaude} />
            <Button label={t('linkAis')} size="sm" variant="secondary" onClick={onAddAis} />
          </HStack>
        </VStack>
      </Card>
    );
  }
  return (
    <Card variant="muted" height="100%" padding={2}>
      <VStack gap={2}>
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <VStack gap={1}>
            <Heading level={3} maxLines={1}>{t('yourShareProviders')}</Heading>
            <Text type="supporting" color="secondary" maxLines={1}>{t('shareProvidersDesc')}</Text>
          </VStack>
          <HStack gap={2} wrap="wrap">
            <Button label={t('linkCodex')} size="sm" variant="secondary" onClick={onLinkCodex} />
            <Button label={t('linkClaude')} size="sm" variant="secondary" onClick={onAddClaude} />
            <Button label={t('linkAis')} size="sm" variant="secondary" onClick={onAddAis} />
            <Button label={t('credentials')} size="sm" variant="ghost" onClick={onRevealCredentials} />
            <Button label={t('refreshQuota')} size="sm" variant="ghost" isLoading={isRefreshing} onClick={onRefresh} />
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
              onEditAis={onEditAis}
              onEditClaude={onEditClaude}
              isActionLoading={isActionLoading}
            />
          ))}
        </Grid>
      </VStack>
    </Card>
  );
}

function PersonalKeyCard({ personalKeys, onCreate, onReveal, onRotate, onRevoke, isActionLoading = () => false }) {
  const { t } = useLanguage();
  const activeSessionCount = personalKeys[0]?.activeSessionCount || 0;
  const remainingQuota = personalKeys[0]?.remainingQuotaDollars || 0;
  return (
    <Card variant="muted" height="100%" padding={2}>
      <VStack gap={2}>
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <VStack gap={1}>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Heading level={3} maxLines={1}>{t('myKeys')}</Heading>
              <Badge label={activeSessionCount ? t('activeAccess') : t('noActiveAccess')} variant={activeSessionCount ? 'green' : 'neutral'} />
            </HStack>
            <Text type="supporting" color="secondary" maxLines={1}>
              {t('keysActiveSummary', { count: activeSessionCount, amount: money(remainingQuota) })}
            </Text>
          </VStack>
          <Button label={t('createKey')} size="sm" variant="primary" onClick={onCreate} />
        </HStack>
        {!personalKeys.length && (
          <Text type="supporting" color="secondary" maxLines={1}>{t('createKeyPrompt')}</Text>
        )}
        {personalKeys.map((personalKey) => (
          <VStack key={personalKey.id} gap={1}>
            <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
              <VStack gap={1}>
                <HStack gap={1} vAlign="center" wrap="wrap">
                  <Text weight="bold" maxLines={1}>{personalKey.name}</Text>
                  <Badge
                    label={statusLabel(t, personalKey.status)}
                    variant={personalKey.status === 'active' ? 'green' : 'neutral'}
                  />
                </HStack>
                <Text type="supporting" color="secondary" maxLines={1}>
                  {activitySummary(t, personalKey.activity)}
                  {personalKey.expiresAt ? ` · ${t('expiresAtLabel', { date: dateTime(t, personalKey.expiresAt) })}` : ''}
                </Text>
              </VStack>
              {personalKey.status === 'active' && (
                <HStack gap={1} wrap="wrap">
                  <Button label={t('reveal')} size="sm" variant="secondary" isLoading={isActionLoading(`personal-key-reveal:${personalKey.id}`)} isDisabled={isActionLoading(`personal-key-reveal:${personalKey.id}`)} onClick={() => void onReveal(personalKey)} />
                  <Button label={t('rotate')} size="sm" variant="secondary" isLoading={isActionLoading(`personal-key-rotate:${personalKey.id}`)} isDisabled={isActionLoading(`personal-key-rotate:${personalKey.id}`)} onClick={() => void onRotate(personalKey)} />
                  <Button label={t('revoke')} size="sm" variant="ghost" onClick={() => onRevoke(personalKey)} />
                </HStack>
              )}
            </HStack>
          </VStack>
        ))}
      </VStack>
    </Card>
  );
}

function QuotaCard({ upstream, onLinkCodex, onImportAuthJson, onTestConnection, isTestingConnection, onToggleSharing, onRevokeAll, onEditAis, onEditClaude, isActionLoading = () => false }) {
  const { t } = useLanguage();
  const quota = upstream.quota;
  const isAis = upstream.quotaSource === 'ais';
  const isClaude = upstream.type === 'claude';
  const hasUnknownQuota = isAis || isClaude;
  const percentage = Number.isFinite(quota?.remainingPercent) ? Math.max(0, Math.min(100, quota.remainingPercent)) : null;
  const issue = upstream.providerIssue;
  const commitment = upstream.commitment;
  const sharingPaused = upstream.sharing?.status === 'paused';
  const providerTypeLabel = isAis
    ? t('aisExternalQuota')
    : isClaude
      ? t('claudeExternalQuota')
      : (quota?.label || t('waitingProviderQuota'));
  const dedicatedAppName = isClaude ? t('claudeDedicatedApp') : t('aisDedicatedApp');
  const unknownQuotaExplanation = t('unknownQuotaCardExplanation', { app: dedicatedAppName });
  return (
    <Card variant={issue ? 'red' : 'default'} height="100%" padding={3}>
      <VStack gap={2} height="100%" vAlign="between">
        <VStack gap={2}>
          <HStack justify="between" vAlign="start" gap={2}>
            <StackItem size="fill">
              <VStack gap={1}>
                <Text weight="bold" maxLines={1}>{upstream.email || upstream.name}</Text>
                <Text type="supporting" color="secondary" maxLines={1}>{providerTypeLabel}</Text>
              </VStack>
            </StackItem>
            <HStack gap={1} vAlign="center">
              {isAis && <Button label={t('edit')} size="sm" variant="secondary" onClick={() => onEditAis(upstream)} />}
              {isClaude && <Button label={t('edit')} size="sm" variant="secondary" onClick={() => onEditClaude(upstream)} />}
              {issue && <ProviderIssueBadge issue={issue} />}
            </HStack>
          </HStack>
          {hasUnknownQuota ? (
            <HStack gap={1.5} vAlign="center">
              <Text weight="bold" maxLines={1}>{t('unknownQuota')}</Text>
              <Tooltip
                content={(
                  <VStack gap={0} maxWidth={320}>
                    <Text color="inherit" display="block" textWrap="wrap">
                      {unknownQuotaExplanation}
                    </Text>
                  </VStack>
                )}
                hasHoverIndication={false}
              >
                <span
                  tabIndex={0}
                  role="button"
                  aria-label={t('unknownQuotaInfo')}
                  style={{ display: 'inline-flex', cursor: 'help', verticalAlign: 'middle' }}
                >
                  <Icon icon={CircleHelp} size="sm" color="info" />
                </span>
              </Tooltip>
            </HStack>
          ) : (
            <Text weight="bold" maxLines={1}>{quotaRemaining(t, quota)}</Text>
          )}
          {!hasUnknownQuota && percentage !== null && (
            <ProgressBar
              label={t('providerQuotaRemaining')}
              isLabelHidden
              value={percentage}
              max={100}
              variant={quotaProgressVariant(percentage)}
            />
          )}
          <Text type="supporting" color="secondary" maxLines={1}>
            {hasUnknownQuota
              ? t('checkBalanceIn', { app: dedicatedAppName })
              : quotaTiming(t, quota)}
          </Text>
          {commitment && (
            <Text type="supporting" color="secondary" maxLines={1}>
              {hasUnknownQuota
                ? t('committedUnknownQuota', { amount: money(commitment.totalCommitmentDollars) })
                : `${t('committedAmount', { amount: money(commitment.totalCommitmentDollars) })} · ${Number.isFinite(commitment.offerableQuotaDollars)
                  ? t('availableToOffer', { amount: money(commitment.offerableQuotaDollars) })
                  : t('offerableQuotaUnavailable')}`}
            </Text>
          )}
          {commitment?.underfundedQuotaDollars > 0 && (
            <Badge label={t('underfundedBadge', { amount: money(commitment.underfundedQuotaDollars) })} variant="error" />
          )}
        </VStack>
        <HStack justify="end" gap={1} wrap="wrap">
          <IconButton
            label={t('testConnection')}
            tooltip={t('testConnection')}
            icon={<PlugZap size={16} />}
            size="sm"
            variant="secondary"
            isLoading={isTestingConnection}
            isDisabled={isTestingConnection}
            onClick={() => onTestConnection(upstream)}
          />
          {issue?.code === 'provider_reauth_required' && (
            <>
              {isClaude ? (
                <Button label={t('updateToken')} size="sm" variant="primary" onClick={() => onEditClaude(upstream)} />
              ) : (
                <>
                  <Button label={t('reconnect')} size="sm" variant="primary" onClick={onLinkCodex} />
                  <Button label={t('useAuthJson')} size="sm" variant="secondary" onClick={onImportAuthJson} />
                </>
              )}
            </>
          )}
          <Button
            label={sharingPaused ? t('resumeSharing') : t('pauseSharing')}
            size="sm"
            variant="secondary"
            isLoading={isActionLoading(`provider-sharing:${upstream.id}`)}
            isDisabled={isActionLoading(`provider-sharing:${upstream.id}`)}
            onClick={() => void onToggleSharing(upstream)}
          />
          <Button label={t('revokeAll')} size="sm" variant="ghost" onClick={() => onRevokeAll(upstream)} />
        </HStack>
      </VStack>
    </Card>
  );
}

const SHARING_TABLE_PAGE_SIZE = 10;
const SHARING_TABLE_PAGE_SIZE_OPTIONS = [10, 20, 50];

function PaginatedSharingTable({ items, columns, emailQuery = '', emptyTitle, emptyDescription, tableLabel, tablePage }) {
  const { t } = useLanguage();
  if (!items.length) {
    return filteredEmptyState(t, emailQuery, emptyTitle, emptyDescription);
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
  const { t } = useLanguage();
  const columns = [
    { key: 'provider', header: t('provider'), width: proportional(2), renderCell: (offer) => <Text maxLines={1}>{accountLabel(offer.provider, t)}</Text> },
    { key: 'offered', header: t('offered'), width: pixel(120), renderCell: (offer) => <Text weight="bold" maxLines={1}>${money(offer.quotaDollars)}</Text> },
    {
      key: 'status',
      header: t('status'),
      width: proportional(2),
      renderCell: (offer) => {
        const issue = offer.status === 'active' ? offer.upstream?.providerIssue : null;
        const isRestricted = offer.visibility === 'restricted';
        const emails = offer.allowedEmails || [];
        const tooltipContent = isRestricted
          ? (emails.length > 0 ? emails.join(', ') : null)
          : null;
        const badge = (
          <Badge
            label={isRestricted ? t('visibilityBadgeRestricted', { count: emails.length }) : t('visibilityBadgePublic')}
            variant={isRestricted ? 'amber' : 'neutral'}
          />
        );
        return (
          <HStack gap={1} wrap="wrap">
            {!offer.isUsable && <Badge label={t('unusableBadge')} variant="error" />}
            {issue && <ProviderIssueBadge issue={issue} />}
            <Badge label={statusLabel(t, offer.status)} variant={offer.status === 'active' ? 'green' : 'neutral'} />
            {tooltipContent ? (
              <Tooltip content={tooltipContent} placement="top">
                {badge}
              </Tooltip>
            ) : badge}
            <UpstreamSourceBadge upstream={offer.upstream} />
          </HStack>
        );
      }
    },
    {
      key: 'expiry',
      header: t('expires'),
      width: proportional(1.5),
      renderCell: (offer) => <Text type="supporting" color="secondary" maxLines={1}>{offer.expiresAt ? dateTime(t, offer.expiresAt) : t('unavailable')}</Text>
    },
    {
      key: 'actions',
      header: '',
      width: pixel(150),
      renderCell: (offer) => (
        <HStack justify="end" gap={1}>
          {offer.isProvider
            ? <Button label={t('edit')} size="sm" variant="secondary" onClick={() => onEdit(offer)} />
            : offer.hasPendingRequest
              ? <Button label={t('requestedBtn')} size="sm" variant="secondary" isDisabled />
              : <Button label={t('requestQuotaBtn')} size="sm" variant="primary" isLoading={isActionLoading(`offer-request:${offer.id}`)} isDisabled={offer.status !== 'active' || !offer.isUsable || offer.availableDollars <= 0 || isActionLoading(`offer-request:${offer.id}`)} onClick={() => void onRequest(offer)} />}
        </HStack>
      )
    }
  ];
  return <PaginatedSharingTable items={offers} columns={columns} emailQuery={emailQuery} emptyTitle={emptyTitle} emptyDescription={emptyDescription} tableLabel={t('offersTable')} tablePage={tablePage} />;
}

function TicketsView({ tickets, emailQuery = '', emptyTitle, emptyDescription, onApprove, onReject, onCancel, tablePage, isActionLoading = () => false }) {
  const { t } = useLanguage();
  const counterpart = tickets[0]?.direction === 'received' ? 'consumer' : 'provider';
  const columns = [
    { key: 'counterpart', header: counterpart === 'consumer' ? t('consumer') : t('provider'), width: proportional(2), renderCell: (ticket) => <Text maxLines={1}>{accountLabel(ticket[counterpart], t)}</Text> },
    {
      key: 'request',
      header: t('requestCol'),
      width: proportional(2),
      renderCell: (ticket) => (
        <VStack gap={1}>
          <Text weight="bold" maxLines={1}>{ticket.approvedQuotaDollars !== null
            ? t('requestedApproved', { requested: money(ticket.requestedQuotaDollars), approved: money(ticket.approvedQuotaDollars) })
            : t('requestedOnly', { requested: money(ticket.requestedQuotaDollars) })}</Text>
          <Text type="supporting" color="secondary" maxLines={1}>{ticket.upstream?.name || t('unavailableUpstream')}</Text>
        </VStack>
      )
    },
    {
      key: 'status',
      header: t('status'),
      width: proportional(1.5),
      renderCell: (ticket) => {
        const issue = ticket.status === 'pending' ? ticket.upstream?.providerIssue : null;
        return (
          <HStack gap={1} wrap="wrap">
            <Badge label={ticket.direction === 'received' ? t('receivedDirection') : t('sentDirection')} variant="neutral" />
            <Badge label={statusLabel(t, ticket.status)} variant={ticket.status === 'pending' ? 'warning' : ticket.status === 'approved' ? 'green' : 'neutral'} />
            {issue && <ProviderIssueBadge issue={issue} />}
          </HStack>
        );
      }
    },
    {
      key: 'timing',
      header: t('timingCol'),
      width: proportional(1.5),
      renderCell: (ticket) => (
        <Text type="supporting" color="secondary" maxLines={1}>
          {ticket.status === 'pending' && ticket.expiresAt ? t('expiresAtLabel', { date: dateTime(t, ticket.expiresAt) }) : ticket.resolvedAt ? t('resolvedAt', { date: dateTime(t, ticket.resolvedAt) }) : '—'}
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
              <Button label={t('rejectBtn')} size="sm" variant="secondary" isLoading={isActionLoading(`ticket-reject:${ticket.id}`)} isDisabled={isActionLoading(`ticket-reject:${ticket.id}`)} onClick={() => void onReject(ticket)} />
              <Button label={t('approveBtn')} size="sm" variant="primary" isDisabled={Boolean(ticket.upstream?.providerIssue) || isActionLoading(`ticket-reject:${ticket.id}`)} onClick={() => onApprove(ticket)} />
            </>
          ) : <Button label={t('cancelBtn')} size="sm" variant="secondary" isLoading={isActionLoading(`ticket-cancel:${ticket.id}`)} isDisabled={isActionLoading(`ticket-cancel:${ticket.id}`)} onClick={() => void onCancel(ticket)} />}
        </HStack>
      )
    }
  ];
  return <PaginatedSharingTable items={tickets} columns={columns} emailQuery={emailQuery} emptyTitle={emptyTitle} emptyDescription={emptyDescription} tableLabel={t('requestsTable')} tablePage={tablePage} />;
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
  const { t } = useLanguage();
  const columns = [
    { key: 'provider', header: t('provider'), width: proportional(1.5), renderCell: (session) => <Text maxLines={1}>{accountLabel(session.provider, t)}</Text> },
    { key: 'consumer', header: t('consumer'), width: proportional(1.5), renderCell: (session) => <Text maxLines={1}>{accountLabel(session.consumer, t)}</Text> },
    {
      key: 'quota',
      header: t('remainingCol'),
      width: proportional(2),
      renderCell: (session) => {
        const remainingPercent = session.grantedQuotaDollars > 0
          ? Math.min(100, session.remainingQuotaDollars / session.grantedQuotaDollars * 100)
          : 0;
        const quotaVariant = quotaProgressVariant(remainingPercent, ['active', 'paused', 'exhausted'].includes(session.status));
        return (
          <VStack gap={1}>
            <Text type="supporting" color="secondary" maxLines={1}>{t('usedOfRemaining', { used: money(session.consumedQuotaDollars), granted: money(session.grantedQuotaDollars), remaining: money(session.remainingQuotaDollars) })}</Text>
            <ProgressBar label={t('remainingCol')} isLabelHidden value={remainingPercent} max={100} variant={quotaVariant} />
            {session.isUnderfunded && session.status === 'active' && (
              <Text type="supporting" color="secondary" maxLines={1}>{t('currentlyBacked', { amount: money(session.backedRemainingQuotaDollars) })}</Text>
            )}
          </VStack>
        );
      }
    },
    {
      key: 'status',
      header: t('status'),
      width: proportional(2),
      renderCell: (session) => {
        const issue = session.status === 'active' ? session.providerIssue : null;
        const hasProviderIssue = Boolean(issue);
        const providerPaused = session.status === 'active' && session.providerSharingStatus === 'paused';
        return (
          <HStack gap={1} wrap="wrap">
            {hasProviderIssue && <ProviderIssueBadge issue={issue} />}
            {providerPaused && <Badge label={t('providerPaused')} variant="warning" />}
            {(!hasProviderIssue && !providerPaused || session.status !== 'active') && (
              <Badge label={statusLabel(t, session.status)} variant={session.status === 'active' ? 'green' : session.status === 'exhausted' ? 'warning' : 'neutral'} />
            )}
            <UpstreamSourceBadge upstream={session.upstream} />
          </HStack>
        );
      }
    },
    {
      key: 'expiry',
      header: t('expires'),
      width: proportional(1.5),
      renderCell: (session) => <Text type="supporting" color="secondary" maxLines={1}>{session.expiresAt ? dateTime(t, session.expiresAt) : t('noExpiry')}</Text>
    },
    { key: 'activity', header: t('activity'), width: proportional(2), renderCell: (session) => <ActivitySummary activity={session.activity} /> },
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
              <IconButton label={t('testConnection')} tooltip={t('testConnection')} icon={<PlugZap size={16} />} size="sm" variant="secondary" isLoading={testingSessionId === session.id} isDisabled={testingSessionId === session.id || hasProviderIssue || providerPaused || session.remainingQuotaDollars <= 0} onClick={() => onTestConnection(session)} />
            )}
            {session.canRevealKey && <IconButton label={t('revealKey')} tooltip={t('revealKey')} icon={<Eye size={16} />} size="sm" variant="primary" isLoading={isActionLoading(`session-reveal:${session.id}`)} isDisabled={isActionLoading(`session-reveal:${session.id}`)} onClick={() => void onReveal(session)} />}
            {session.canRotateKey && <IconButton label={session.canRevealKey ? t('generateNewKey') : t('generateKey')} tooltip={session.canRevealKey ? t('generateNewKey') : t('generateKey')} icon={<KeyRound size={16} />} size="sm" variant="primary" isLoading={isActionLoading(`session-rotate:${session.id}`)} isDisabled={isActionLoading(`session-rotate:${session.id}`)} onClick={() => void onRotate(session)} />}
            {session.role === 'provider' && !['revoked', 'exhausted'].includes(session.status) && (
              <IconButton label={session.status === 'paused' ? t('resumeAction') : t('pauseAction')} tooltip={session.status === 'paused' ? t('resumeAction') : t('pauseAction')} icon={session.status === 'paused' ? <Play size={16} /> : <Pause size={16} />} size="sm" variant="secondary" isLoading={isActionLoading(`session-status:${session.id}`)} isDisabled={isActionLoading(`session-status:${session.id}`)} onClick={() => void onStatus(session, session.status === 'paused' ? 'active' : 'paused')} />
            )}
            {session.role === 'provider' && session.status === 'exhausted' && <IconButton label={t('addQuotaAction')} tooltip={t('addQuotaAction')} icon={<Plus size={16} />} size="sm" variant="primary" onClick={() => onAddQuota(session)} />}
            {session.role === 'provider' && !['revoked', 'exhausted'].includes(session.status) && <IconButton label={t('resizeQuota')} tooltip={t('resizeQuota')} icon={<Scaling size={16} />} size="sm" variant="secondary" onClick={() => onEdit(session)} />}
            {session.status !== 'revoked' && <IconButton label={session.role === 'consumer' ? t('leaveSession') : t('revokeSession')} tooltip={session.role === 'consumer' ? t('leaveSession') : t('revokeSession')} icon={session.role === 'consumer' ? <LogOut size={16} /> : <Ban size={16} />} size="sm" variant="secondary" isLoading={isActionLoading(`session-revoke:${session.id}`)} isDisabled={isActionLoading(`session-revoke:${session.id}`)} onClick={() => void onRevoke(session)} />}
          </HStack>
        );
      }
    }
  ];
  return <PaginatedSharingTable items={sessions} columns={columns} emailQuery={emailQuery} emptyTitle={emptyTitle} emptyDescription={emptyDescription} tableLabel={t('accessTable')} tablePage={tablePage} />;
}

function ActivitySummary({ activity }) {
  const { t } = useLanguage();
  return <Text type="supporting" color="secondary" maxLines={1}>{activitySummary(t, activity)}</Text>;
}

function ProviderIssueBadge({ issue }) {
  const { t } = useLanguage();
  return <Badge label={issue.code === 'provider_reauth_required' ? t('signInRequired') : t('unavailable')} variant="error" />;
}

function UpstreamSourceBadge({ upstream }) {
  const { t } = useLanguage();
  const isClaude = upstream?.type === 'claude';
  const isAis = upstream?.quotaSource === 'ais';
  const hasUnknownQuota = isAis || isClaude;
  const dedicatedAppName = isClaude ? t('claudeDesktopApp') : t('aisSwitchApp');
  const badge = isClaude
    ? <Badge label="claude" variant="blue" />
    : <Badge label={isAis ? 'ais' : 'codex'} variant={isAis ? 'teal' : 'purple'} />;

  if (!hasUnknownQuota) {
    return badge;
  }

  return (
    <HStack gap={1} vAlign="center">
      {badge}
      <Tooltip
        content={(
          <VStack gap={0} maxWidth={280}>
            <Text color="inherit" display="block" textWrap="wrap">
              {t('unknownQuotaSourceExplanation', { app: dedicatedAppName })}
            </Text>
          </VStack>
        )}
        hasHoverIndication={false}
      >
        <span
          tabIndex={0}
          role="button"
          aria-label={t('externalQuotaNotice')}
          style={{ display: 'inline-flex', cursor: 'help', verticalAlign: 'middle' }}
        >
          <Icon icon={CircleHelp} size="sm" color="info" />
        </span>
      </Tooltip>
    </HStack>
  );
}

function CodexLoginDialog({ login, onClose, onCancel, onRetry }) {
  const { t } = useLanguage();
  if (!login) return null;
  const waiting = ['starting', 'waiting'].includes(login.status);
  const retryable = ['failed', 'cancelled'].includes(login.status);
  const [isOpeningSignIn, setIsOpeningSignIn] = useState(false);

  useEffect(() => {
    if (!waiting) setIsOpeningSignIn(false);
  }, [waiting]);

  const openSignIn = () => {
    setIsOpeningSignIn(true);
    if (login.verificationUrl) {
      window.open(login.verificationUrl, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <Dialog isOpen={Boolean(login)} onOpenChange={onClose} purpose="form" width={540}>
      <Layout
        header={(
          <DialogHeader
            title={t('linkCodexDialogTitle')}
            subtitle={t('linkCodexDialogSub')}
            onOpenChange={onClose}
            hasDivider
          />
        )}
        content={(
          <LayoutContent>
            <VStack gap={3}>
              <HStack justify="between" vAlign="center">
                <Text type="supporting" color="secondary">{t('connectionStatus')}</Text>
                <Badge
                  label={statusLabel(t, login.status)}
                  variant={login.status === 'completed' ? 'green' : login.status === 'failed' ? 'error' : 'warning'}
                />
              </HStack>

              {login.userCode ? (
                <VStack gap={3}>
                  <VStack gap={1}>
                    <Text weight="bold">{t('codexStep1Title')}</Text>
                    <Text type="supporting" color="secondary">
                      {t('codexStep1Detail')}
                    </Text>
                    <HStack gap={2} vAlign="center">
                      <Button
                        label={t('openVerificationPage')}
                        variant="primary"
                        isLoading={isOpeningSignIn}
                        onClick={openSignIn}
                      />
                      <Text type="supporting" color="secondary">
                        {t('opensInNewTab')}
                      </Text>
                    </HStack>
                  </VStack>

                  <VStack gap={1}>
                    <Text weight="bold">{t('codexStep2Title')}</Text>
                    <Text type="supporting" color="secondary">
                      {t('codexStep2Desc')}
                    </Text>
                    <CodeBlock
                      code={login.userCode}
                      language="text"
                      hasCopyButton
                      width="100%"
                    />
                  </VStack>
                </VStack>
              ) : (
                <VStack gap={2} vAlign="center" justify="center" style={{ padding: '24px 0' }}>
                  <Text color="secondary">{t('generatingDeviceCode')}</Text>
                </VStack>
              )}

              {login.errorCode && (
                <Banner title={t('authorizationError')} description={login.errorCode} status="error" />
              )}
            </VStack>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter hasDivider>
            <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
              <HStack gap={2}>
                {waiting && <Button label={t('cancelSignIn')} variant="ghost" onClick={onCancel} />}
              </HStack>
              <HStack gap={2}>
                {retryable && <Button label={t('retry')} variant="primary" onClick={onRetry} />}
                <Button label={t('close')} variant="secondary" onClick={onClose} />
              </HStack>
            </HStack>
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function AuthJsonLoginDialog({ isOpen, value, isLoading, onChange, onClose, onSubmit }) {
  const { t } = useLanguage();
  return (
    <Dialog isOpen={isOpen} onOpenChange={onClose} purpose="form" width={640}>
      <Layout
        header={<DialogHeader title={t('loginWithAuthJson')} onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            <form id="auth-json-login-form" onSubmit={onSubmit}>
              <VStack gap={3}>
                <Banner
                  title={t('credentialImport')}
                  description={t('credentialImportDesc')}
                  status="warning"
                />
                <TextArea
                  label={t('codexAuthJson')}
                  value={value}
                  onChange={onChange}
                  placeholder={t('authJsonPlaceholder')}
                  rows={6}
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
              <Button label={t('cancelBtn')} variant="secondary" isDisabled={isLoading} onClick={onClose} />
              <Button
                label={t('loginBtn')}
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

function AisProjectDialog({ value, onClose, onSave, onChange }) {
  const { t } = useLanguage();
  const [guideOpen, setGuideOpen] = useState(false);
  const editing = Boolean(value?.upstream);
  return (
    <>
      <Dialog isOpen={Boolean(value)} onOpenChange={onClose} purpose="form" width={520}>
        <Layout
          header={<DialogHeader title={editing ? t('editAisDialogTitle') : t('linkAisDialogTitle')} subtitle={t('linkAisDialogSub')} onOpenChange={onClose} hasDivider />}
          content={(
            <LayoutContent>
              {value && <VStack gap={3}>
                <Banner
                  title={editing ? t('updateProjectDetails') : t('aisQuotaUnavailable')}
                  description={editing ? t('updateProjectDetailsDesc') : t('aisQuotaUnavailableDesc')}
                  status="info"
                />
                <TextInput
                  label={t('aisProjectId')}
                  value={value.projectId || ''}
                  onChange={(projectId) => onChange({ ...value, projectId })}
                  hasAutoFocus
                  isRequired
                />
                <TextInput
                  label={editing ? t('newAisProjectKeyOptional') : t('aisProjectKey')}
                  value={value.projectKey || ''}
                  onChange={(projectKey) => onChange({ ...value, projectKey })}
                  placeholder={editing ? t('aisProjectKeyLeaveEmpty') : undefined}
                  isRequired={!editing}
                />
              </VStack>}
            </LayoutContent>
          )}
          footer={(
            <DialogFooter
              startContent={(
                <Link label={t('howToGetAis')} onClick={() => setGuideOpen(true)}>
                  <HStack gap={1} vAlign="center">
                    <Icon icon={CircleHelp} size="sm" />
                    <Text>{t('howToGetAis')}</Text>
                  </HStack>
                </Link>
              )}
              onClose={onClose}
              onSave={() => onSave(value)}
              saveLabel={editing ? t('updateProjectBtn') : t('linkAis')}
              isSaveDisabled={!String(value?.projectId || '').trim()
                || (!editing && !String(value?.projectKey || '').trim())}
            />
          )}
        />
      </Dialog>
      <AisProjectGuide isOpen={guideOpen} onClose={() => setGuideOpen(false)} />
    </>
  );
}

const AIS_PROJECT_SCRIPT = "fetch('/api/v1/cqp/ccswitch/api_key/get_or_generate',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json()).then(r=>console.log(r.data))";

function AisProjectGuide({ isOpen, onClose }) {
  const { t } = useLanguage();
  return (
    <UserGuideDialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('aisGuideTitle')}
      subtitle={t('aisGuideSubtitle')}
    >
      <VStack gap={2}>
        <Text weight="bold">{t('aisGuideStep1Title')}</Text>
        <Text type="supporting" color="secondary">
          {t('aisGuideStep1Body')}<Link href="https://compass.llm.shopee.io/integration/my" isExternalLink>compass.llm.shopee.io/integration/my</Link>{t('aisGuideStep1And')}
        </Text>
      </VStack>
      <VStack gap={2}>
        <Text weight="bold">{t('aisGuideStep2Title')}</Text>
        <Text type="supporting" color="secondary">{t('aisGuideStep2Desc')}</Text>
        <CodeBlock code={AIS_PROJECT_SCRIPT} language="javascript" hasCopyButton isWrapped width="100%" />
      </VStack>
      <VStack gap={2}>
        <Text weight="bold">{t('aisGuideStep3Title')}</Text>
        <Text type="supporting" color="secondary">
          {t('aisGuideCopyPrefix')}<Code>project_id</Code>{t('aisGuideCopyMid')}<Code>api_key</Code>{t('aisGuideCopySuffix')}
        </Text>
      </VStack>
    </UserGuideDialog>
  );
}

function ClaudeUpstreamDialog({ value, onClose, onSave, onChange }) {
  const { t } = useLanguage();
  const editing = Boolean(value?.upstream);
  const token = String(value?.token || '').trim();
  const isValid = token.startsWith('sk-ant-oat') || token.startsWith('{');
  const isSaveDisabled = !isValid;

  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} purpose="form" width={540}>
      <Layout
        header={(
          <DialogHeader
            title={editing ? t('updateClaudeTitle') : t('linkClaude')}
            subtitle={t('claudeSetupTokenSub')}
            onOpenChange={onClose}
            hasDivider
          />
        )}
        content={(
          <LayoutContent>
            {value && (
              <VStack gap={3}>
                <VStack gap={1}>
                  <Text weight="bold">{t('claudeStep1Title')}</Text>
                  <Text type="supporting" color="secondary">
                    {t('claudeStep1Body')}
                  </Text>
                  <CodeBlock
                    code="claude setup-token"
                    language="bash"
                    hasCopyButton
                    width="100%"
                  />
                </VStack>

                <VStack gap={1}>
                  <Text weight="bold">{t('claudeStep2Title')}</Text>
                  <Text type="supporting" color="secondary">
                    {t('claudeTokenPrefix')}<Code>sk-ant-oat...</Code>{t('claudeTokenMid')}<Code>sk-ant-oat01-</Code>{t('claudeTokenSuffix')}
                  </Text>
                  <TextInput
                    label={t('claudeSetupToken')}
                    value={value.token || ''}
                    onChange={(tokenVal) => onChange({ ...value, token: tokenVal })}
                    placeholder="sk-ant-oat..."
                    hasAutoFocus
                    isRequired
                    width="100%"
                  />
                </VStack>
              </VStack>
            )}
          </LayoutContent>
        )}
        footer={(
          <DialogFooter
            onClose={onClose}
            onSave={() => onSave(value)}
            saveLabel={editing ? t('updateToken') : t('linkClaude')}
            isSaveDisabled={isSaveDisabled}
          />
        )}
      />
    </Dialog>
  );
}

function OfferDialog({ value, upstreams, offerableUpstreams, onClose, onSave, onChange }) {
  const { t } = useLanguage();
  const selectedUpstream = upstreams.find((item) => item.id === value?.upstreamId) || value?.offer?.upstream;
  const isAis = selectedUpstream?.quotaSource === 'ais';
  const isClaude = selectedUpstream?.type === 'claude';
  const hasUnknownQuota = isAis || isClaude;
  const dedicatedAppName = isClaude ? t('claudeDedicatedApp') : t('aisDedicatedApp');
  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} purpose="form" width={460}>
      <Layout
        header={<DialogHeader title={value?.offer ? t('editOfferTitle') : t('publishOffer')} onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            {value && <VStack gap={3}>
              {value.offer ? (
                <TextInput label={t('shareSource')} value={selectedUpstream?.name || ''} isDisabled />
              ) : (
                <Selector
                  label={t('shareSource')}
                  options={offerableUpstreams.map((upstream) => ({
                    value: upstream.id,
                    label: `${upstream.name} · ${upstream.type === 'claude' ? 'Claude' : (upstream.quotaSource === 'ais' ? 'AIS' : 'Codex')}`
                  }))}
                  value={value.upstreamId}
                  onChange={(upstreamId) => onChange((current) => ({ ...current, upstreamId }))}
                  width="100%"
                />
              )}
              {hasUnknownQuota && (
                <Banner
                  title={t('externalQuotaNotice')}
                  description={t('unknownQuotaDialogExplanation', { app: dedicatedAppName })}
                  status="info"
                />
              )}
              <NumberInput
                label={t('shareableQuotaUsd')}
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
                label={t('expiresOn')}
                value={value.expiresOn || undefined}
                onChange={(expiresOn) => onChange({ ...value, expiresOn: expiresOn || '' })}
                min={todayDate()}
                isOptional
                hasClear
                width="100%"
              />
              <SegmentedControl
                label={t('offerVisibility')}
                value={value.visibility || 'public'}
                onChange={(visibility) => onChange({ ...value, visibility })}
              >
                <SegmentedControlItem value="public" label={t('visibilityPublic')} />
                <SegmentedControlItem value="restricted" label={t('visibilityRestricted')} />
              </SegmentedControl>
              {(value.visibility === 'restricted') && (
                <TextArea
                  label={t('visibilityRestricted')}
                  description={t('visibilityWhitelistHelp')}
                  placeholder={t('visibilityWhitelistPlaceholder')}
                  value={value.allowedEmails ?? ''}
                  onChange={(allowedEmails) => onChange({ ...value, allowedEmails })}
                  rows={3}
                  hasSpellCheck={false}
                  isRequired
                />
              )}
              {value.offer && (
                <SegmentedControl label={t('offerStatus')} value={value.status} onChange={(status) => onChange({ ...value, status })}>
                  <SegmentedControlItem value="active" label={t('active')} />
                  <SegmentedControlItem value="paused" label={t('paused')} />
                  <SegmentedControlItem value="closed" label={t('closed')} />
                </SegmentedControl>
              )}
            </VStack>}
          </LayoutContent>
        )}
        footer={(
          <DialogFooter
            onClose={onClose}
            onSave={() => onSave(value)}
            saveLabel={value?.offer ? t('saveOfferBtn') : t('publishBtn')}
            isSaveDisabled={value?.quotaInputValid === false || (value?.visibility === 'restricted' && (!value?.allowedEmails || !value.allowedEmails.trim()))}
          />
        )}
      />
    </Dialog>
  );
}

function PersonalKeyDialog({ value, onClose, onSave, onChange }) {
  const { t } = useLanguage();
  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} purpose="form" width={460}>
      <Layout
        header={<DialogHeader title={t('createPoolKeyTitle')} subtitle={t('createPoolKeySub')} onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            {value && (
              <VStack gap={3}>
                <TextInput
                  label={t('keyName')}
                  value={value.name}
                  onChange={(name) => onChange({ ...value, name })}
                  placeholder={t('keyNamePlaceholder')}
                  hasAutoFocus
                />
                <DateInput
                  label={t('expiresOn')}
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
            saveLabel={t('createKeyBtn')}
            isSaveDisabled={!value?.name.trim()}
          />
        )}
      />
    </Dialog>
  );
}

function TicketDialog({ value, onClose, onSave, onChange }) {
  const { t } = useLanguage();
  const title = t('approveTicketTitle');
  const subtitle = accountLabel(value?.ticket?.consumer, t);
  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} purpose="form" width={420}>
      <Layout
        header={<DialogHeader title={title} subtitle={subtitle} onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            {value && (
              <NumberInput
                label={t('approvedQuotaUsd')}
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
            saveLabel={t('approveBtn')}
            isSaveDisabled={value?.quotaInputValid === false}
          />
        )}
      />
    </Dialog>
  );
}

function SessionDialog({ value, onClose, onSave, onChange }) {
  const { t } = useLanguage();
  const addingQuota = value?.mode === 'add';
  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} purpose="form" width={420}>
      <Layout
        header={<DialogHeader title={addingQuota ? t('addSessionQuotaDialogTitle') : t('resizeSessionDialogTitle')} subtitle={accountLabel(value?.session.consumer, t)} onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            {value && (
              <VStack gap={3}>
                <NumberInput
                  label={addingQuota ? t('additionalQuotaDollars') : t('grantedQuotaDollars')}
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
                    label={t('expiresOn')}
                    description={t('sessionExpiryHint')}
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
            saveLabel={addingQuota ? t('addQuotaBtn') : t('updateQuotaBtn')}
            isSaveDisabled={value?.quotaInputValid === false}
          />
        )}
      />
    </Dialog>
  );
}

function KeyDialog({ value, onClose, onNotice }) {
  const { t } = useLanguage();
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
      headers: {
        authorization: `Bearer ${value.apiKey}`,
        ...(value?.session?.upstream?.type === 'claude' ? { 'anthropic-version': '2023-06-01' } : {})
      },
      signal: controller.signal
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw body.error || new Error(t('unableToLoadModels'));
        return [...new Set((body.data || []).map((model) => model.id).filter(Boolean))];
      })
      .then((ids) => {
        if (active) setModelState({ status: 'loaded', ids });
      })
      .catch((error) => {
        if (active && error.name !== 'AbortError') {
          setModelState({ status: error.code === 'share_session_paused' ? 'paused' : 'error', ids: [] });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [value?.apiKey, value?.session?.upstream?.type]);
  const models = modelState.status === 'loading'
    ? t('loadingModels')
    : modelState.status === 'paused'
      ? t('sessionPaused')
      : modelState.status === 'error'
        ? t('unableToLoadModels')
        : modelState.ids.join(', ') || t('noModelsAvailable');
  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} width={600}>
      <Layout
        header={<DialogHeader title={personal ? value?.name || t('poolKeyTitle') : t('sessionApiKeyTitle')} subtitle={personal ? t('poolKeySub') : t('sessionKeySub')} onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            <VStack gap={3}>
              {!personal && (
                <Banner
                  title={t('personalKeyBannerTitle')}
                  description={t('personalKeyBannerDesc')}
                  status="info"
                />
              )}
              <TextInput label={t('apiKey')} value={value?.apiKey || ''} isReadOnly />
              {personal || value?.session?.upstream?.quotaSource === 'ais' ? (
                <>
                  <TextInput label={t('openAiApiBaseUrl')} value={apiBaseUrl()} isReadOnly />
                  <TextInput label={t('anthropicApiBaseUrl')} value={anthropicBaseUrl()} isReadOnly />
                </>
              ) : (
                <TextInput label={t('apiBaseUrl')} value={apiBaseUrl(value?.session?.upstream?.type)} isReadOnly />
              )}
              <VStack gap={1}>
                <FieldLabel label={t('availableModels')} inputID="available-models" isGroupLabel />
                <Text type="supporting">{models}</Text>
              </VStack>
            </VStack>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter hasDivider>
            <HStack justify="end" gap={2}>
              <Button label={t('copy')} variant="primary" onClick={async () => {
                await navigator.clipboard.writeText(value.apiKey);
                onNotice(t('apiKeyCopied'));
              }} />
              <Button label={t('done')} variant="secondary" onClick={onClose} />
            </HStack>
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function CredentialsDialog({ value, onClose, onChange, onNotice }) {
  const { t } = useLanguage();
  const selected = value?.entries.find((entry) => entry.id === value.selectedId);
  return (
    <Dialog isOpen={Boolean(value)} onOpenChange={onClose} width={640}>
      <Layout
        header={<DialogHeader title={t('currentCredentials')} subtitle={selected?.name} onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            <VStack gap={3}>
              <Banner title={t('providerCredentials')} description={t('providerCredentialsDesc')} status="warning" />
              {value?.entries.length > 1 && (
                <Selector
                  label={t('provider')}
                  options={value.entries.map((entry) => ({ value: entry.id, label: entry.name }))}
                  value={value.selectedId}
                  onChange={(selectedId) => onChange({ ...value, selectedId })}
                  width="100%"
                />
              )}
              <TextArea label={t('credentialData')} value={selected ? JSON.stringify(selected.credentials, null, 2) : ''} rows={20} isReadOnly hasSpellCheck={false} />
            </VStack>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter hasDivider>
            <HStack justify="end" gap={2}>
              <Button label={t('copy')} variant="primary" onClick={async () => {
                await navigator.clipboard.writeText(JSON.stringify(selected.credentials, null, 2));
                onNotice(t('credentialsCopied'));
              }} />
              <Button label={t('done')} variant="secondary" onClick={onClose} />
            </HStack>
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function DialogFooter({ startContent = null, onClose, onSave, saveLabel, isSaveDisabled = false }) {
  const { t } = useLanguage();
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
          <Button label={t('cancelBtn')} variant="secondary" isDisabled={isSaving} onClick={onClose} />
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

function anthropicBaseUrl() {
  return appUrl('').replace(/\/+$/, '');
}

function apiBaseUrl(upstreamType) {
  return upstreamType === 'claude' ? anthropicBaseUrl() : appUrl('/v1');
}

function appUrl(path) {
  return new URL(String(path).replace(/^\//, ''), document.baseURI).toString();
}

function filteredEmptyState(t, query, defaultTitle, defaultDescription) {
  const displayedQuery = query.trim();
  return (
    <EmptyState
      title={displayedQuery ? t('noMatchingAccounts') : defaultTitle}
      description={displayedQuery
        ? t('noEmailMatch', { query: displayedQuery })
        : defaultDescription}
    />
  );
}

function accountLabel(account, t) {
  return account?.email || account?.displayName || t('unknownAccount');
}

function quotaRemaining(t, quota) {
  if (!quota) return t('quotaNotRefreshed');
  if (Number.isFinite(quota.remainingDollars)) return t('quotaLeftUsd', { amount: money(quota.remainingDollars) });
  if (Number.isFinite(quota.remainingPercent)) return t('quotaLeftPercent', { percent: money(quota.remainingPercent) });
  if (Number.isFinite(quota.remainingUnits)) return t('quotaLeftUnits', { units: money(quota.remainingUnits) });
  return t('quotaAvailable');
}

function quotaTiming(t, quota) {
  const reset = quota?.resetAt ? t('resetsAt', { date: dateTime(t, quota.resetAt) }) : t('resetTimeUnavailable');
  return quota?.observedAt ? `${reset} · ${t('updatedAt', { date: dateTime(t, quota.observedAt) })}` : reset;
}

function activitySummary(t, activity) {
  if (!activity || activity.requestCount === 0) return t('noApiActivity');
  const lastUsed = activity.lastUsedAt ? ` · ${t('lastUsed', { date: dateTime(t, activity.lastUsedAt) })}` : '';
  return `${t('activitySummaryText', { success: activity.successCount, total: activity.requestCount, today: money(activity.spendTodayDollars), spent: money(activity.totalSpendDollars) })}${lastUsed}`;
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

function dateTime(t, value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return t('atAnUnknownTime');
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

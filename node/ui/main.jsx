import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import { AppShell } from '@astryxdesign/core/AppShell';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Field } from '@astryxdesign/core/Field';
import { Grid, GridSpan } from '@astryxdesign/core/Grid';
import { Heading, Text } from '@astryxdesign/core/Text';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Theme } from '@astryxdesign/core/theme';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from '@astryxdesign/core/Layout';

const DEFAULT_BULK_RULES = [
  { minQuotaLeft: 1000, capDollars: 100 },
  { minQuotaLeft: 500, capDollars: 50 },
  { minQuotaLeft: 200, capDollars: 20 },
  { minQuotaLeft: 100, capDollars: 10 },
  { minQuotaLeft: 50, capDollars: 5 },
  { minQuotaLeft: 0, capDollars: 0 }
];

const FILTER_OPTIONS = {
  status: [
    { value: '', label: 'Any status' },
    { value: 'active', label: 'Active' },
    { value: 'paused', label: 'Paused' },
    { value: 'disabled', label: 'Disabled' },
    { value: 'reauth_required', label: 'Reauth required' },
    { value: 'refresh_failed', label: 'Refresh failed' },
    { value: 'errored', label: 'Errored' },
    { value: 'exhausted', label: 'Exhausted' },
    { value: 'uncapped', label: 'Uncapped' }
  ],
  quota: [
    { value: '', label: 'Any quota' },
    { value: 'plenty', label: 'Plenty (≥70%)' },
    { value: 'moderate', label: 'Moderate (30–69%)' },
    { value: 'low', label: 'Low (<30%)' },
    { value: 'exhausted', label: 'Exhausted (0%)' },
    { value: 'unknown', label: 'Unknown' }
  ],
  sort: [
    { value: 'recent_active', label: 'Recent active' },
    { value: 'quota_asc', label: 'Least quota remaining (Urgent)' },
    { value: 'quota', label: 'Most quota remaining' },
    { value: 'expiry_asc', label: 'Earliest quota reset / expiry' },
    { value: 'expiry_desc', label: 'Latest quota reset / expiry' },
    { value: 'cap_left', label: 'Most spending cap left' },
    { value: 'cap_left_asc', label: 'Least spending cap left' }
  ]
};

const FORM_DEFAULTS = { type: 'codex', authJson: '', projectId: '', projectKey: '' };

function useStoredValue(key, fallback = '') {
  const [value, setValue] = useState(() => localStorage.getItem(key) ?? fallback);
  const update = useCallback((next) => {
    setValue(next);
    localStorage.setItem(key, next);
  }, [key]);
  return [value, update];
}

function useApi() {
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem('codex-pooler-api-key') || '');
  const api = useCallback(async (path, options = {}) => {
    const request = (key) => fetch(path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(options.headers || {})
      }
    });
    let response = await request(apiKey);
    if (response.status === 401) {
      const nextKey = window.prompt('Enter the Codex Pooler API key')?.trim() || '';
      if (nextKey) {
        sessionStorage.setItem('codex-pooler-api-key', nextKey);
        setApiKey(nextKey);
        response = await request(nextKey);
      }
    }
    const data = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  }, [apiKey]);
  return { api, apiKey };
}

function App() {
  const { api, apiKey } = useApi();
  const [upstreams, setUpstreams] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ text: '', error: false });
  const [formDialog, setFormDialog] = useState({ isOpen: false, mode: 'add', upstream: null });
  const [formValues, setFormValues] = useState(FORM_DEFAULTS);
  const [capUpstream, setCapUpstream] = useState(null);
  const [capValue, setCapValue] = useState(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkMode, setBulkMode] = useState('rules');
  const [bulkCapValue, setBulkCapValue] = useState(100);
  const [bulkRules, setBulkRules] = useState(DEFAULT_BULK_RULES);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [refreshTarget, setRefreshTarget] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshTokenTarget, setRefreshTokenTarget] = useState(null);
  const [isRefreshingToken, setIsRefreshingToken] = useState(false);
  const [filterQuery, setFilterQuery] = useStoredValue('codex_filter_filter-query');
  const [filterType, setFilterType] = useStoredValue('codex_filter_filter-type');
  const [filterStatus, setFilterStatus] = useStoredValue('codex_filter_filter-status');
  const [filterQuota, setFilterQuota] = useStoredValue('codex_filter_filter-quota');
  const [filterSort, setFilterSort] = useStoredValue('codex_filter_filter-sort', 'recent_active');
  const [themeMode, setThemeMode] = useStoredValue('codex_theme_mode', 'dark');
  const reloadTimer = useRef(null);
  const loadingRef = useRef(false);
  const editingIdRef = useRef(null);

  const show = useCallback((text, error = false) => {
    setMessage({ text, error });
  }, []);
  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const data = await api('/api/upstreams');
      setUpstreams(data.upstreams);
    } catch (error) {
      show(error.message, true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [api, show]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer = null;
    const scheduleReload = () => {
      if (reloadTimer.current) return;
      reloadTimer.current = window.setTimeout(() => {
        reloadTimer.current = null;
        void load();
      }, 250);
    };
    const watch = async () => {
      try {
        const response = await fetch('/api/upstreams/events', {
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}
        });
        if (!response.ok || !response.body) throw new Error('Upstream updates unavailable');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = '';
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const events = buffered.split('\n\n');
          buffered = events.pop();
          if (events.some((event) => event.includes('event: ready') || event.includes('event: upstreams'))) scheduleReload();
        }
      } catch {}
      if (!cancelled) retryTimer = window.setTimeout(watch, 1000);
    };
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    void watch();
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [apiKey, load]);

  const stats = useMemo(() => {
    let active = 0;
    let reauth = 0;
    let lowQuota = 0;
    let uncapped = 0;
    let exhausted = 0;
    let capLeft = 0;
    let capSpent = 0;
    let totalCodex = 0;
    let totalCompass = 0;
    upstreams.forEach((upstream) => {
      if (upstream.type === 'codex') totalCodex += 1;
      if (upstream.type === 'compass') totalCompass += 1;
      if (upstream.status === 'active') active += 1;
      if (upstream.status === 'reauth_required') reauth += 1;
      const quotaBand = getQuotaBand(upstream);
      if (quotaBand === 'exhausted' || upstream.status === 'exhausted') exhausted += 1;
      if (quotaBand === 'low') lowQuota += 1;
      const spending = upstream.spending || {};
      if (spending.capCredits <= 0) {
        uncapped += 1;
      } else {
        capLeft += Math.max(0, (spending.capDollars || 0) - (spending.spentDollars || 0));
        capSpent += spending.spentDollars || 0;
      }
    });
    return { total: upstreams.length, totalCodex, totalCompass, active, reauth, lowQuota, uncapped, exhausted, capLeft, capSpent };
  }, [upstreams]);

  const filteredUpstreams = useMemo(() => {
    let filtered = upstreams.slice();
    const query = filterQuery.trim().toLowerCase();
    if (query) {
      filtered = filtered.filter((upstream) => `${upstream.name || ''} ${upstream.id || ''} ${upstream.accountId || ''} ${upstream.projectId || ''}`.toLowerCase().includes(query));
    }
    if (filterType) filtered = filtered.filter((upstream) => upstream.type === filterType);
    if (filterStatus === 'exhausted') {
      filtered = filtered.filter((upstream) => getQuotaBand(upstream) === 'exhausted' || upstream.status === 'exhausted');
    } else if (filterStatus === 'uncapped') {
      filtered = filtered.filter((upstream) => !upstream.spending || upstream.spending.capCredits <= 0);
    } else if (filterStatus) {
      filtered = filtered.filter((upstream) => upstream.status === filterStatus);
    }
    if (filterQuota) filtered = filtered.filter((upstream) => getQuotaBand(upstream) === filterQuota);
    return filtered.sort((a, b) => sortUpstreams(a, b, filterSort));
  }, [filterQuery, filterType, filterStatus, filterQuota, filterSort, upstreams]);

  const updateForm = (field, value) => setFormValues((current) => ({ ...current, [field]: value }));
  const resetForm = useCallback(() => {
    editingIdRef.current = null;
    setFormValues(FORM_DEFAULTS);
    setFormDialog((s) => ({ ...s, isOpen: false }));
  }, []);

  const add = () => {
    resetForm();
    setFormDialog({ isOpen: true, mode: 'add', upstream: null });
  };

  const saveUpstream = async (values, mode, id) => {
    const data = { ...values };
    if (!data.authJson) delete data.authJson;
    if (!data.projectKey) delete data.projectKey;
    try {
      await api(mode === 'edit' ? `/api/upstreams/${id}` : '/api/upstreams', {
        method: mode === 'edit' ? 'PATCH' : 'POST',
        body: JSON.stringify(data)
      });
      show('Saved');
      await load();
      return true;
    } catch (error) {
      show(error.message, true);
      throw error;
    }
  };

  const edit = async (upstream) => {
    editingIdRef.current = upstream.id;

    const initialValues = { ...upstream, authJson: '', projectKey: '' };
    setFormValues(initialValues);
    setFormDialog({ isOpen: true, mode: 'edit', upstream });

    try {
      const res = await api(`/api/upstreams/${upstream.id}/credentials`);
      if (editingIdRef.current !== upstream.id) return;
      const creds = res?.credentials || {};
      let updatedJson = '';
      let updatedProjectKey = '';
      if (upstream.type === 'codex') {
        const tokens = {
          access_token: creds.accessToken || '',
          refresh_token: creds.refreshToken || '',
          id_token: creds.idToken || '',
          account_id: upstream.accountId || ''
        };
        updatedJson = JSON.stringify({ tokens }, null, 2);
      } else if (upstream.type === 'compass') {
        updatedProjectKey = creds.projectKey || creds.apiKey || '';
      }
      setFormValues((prev) => ({
        ...prev,
        authJson: updatedJson,
        projectKey: updatedProjectKey
      }));
    } catch {}
  };



  const refresh = (upstream) => {
    setRefreshTarget(upstream);
  };

  const confirmRefresh = async () => {
    if (!refreshTarget) return;
    setIsRefreshing(true);
    try {
      await api(`/api/upstreams/${refreshTarget.id}/refresh-quota`, { method: 'POST' });
      await load();
      show('Quota refreshed');
      setRefreshTarget(null);
    } catch (error) {
      show(error.message, true);
    } finally {
      setIsRefreshing(false);
    }
  };

  const promptRefreshToken = (upstream) => {
    setRefreshTokenTarget(upstream);
  };

  const confirmRefreshToken = async () => {
    if (!refreshTokenTarget) return;
    setIsRefreshingToken(true);
    try {
      await api(`/api/upstreams/${refreshTokenTarget.id}/refresh-token`, { method: 'POST' });
      show('Token refreshed');
      setRefreshTokenTarget(null);
      await load();
    } catch (error) {
      show(error.message, true);
    } finally {
      setIsRefreshingToken(false);
    }
  };

  const openCap = (upstream) => {
    setCapUpstream(upstream);
    setCapValue(upstream.spending?.capDollars > 0 ? upstream.spending.capDollars : null);
  };

  const saveCap = async (event) => {
    event.preventDefault();
    if (!capUpstream) return;
    await run(async () => {
      await api(`/api/upstreams/${capUpstream.id}/cap`, { method: 'PUT', body: JSON.stringify({ capDollars: capValue ?? 0 }) });
      setCapUpstream(null);
      await load();
    }, 'Cap updated', show);
  };

  const remove = (upstream) => {
    setDeleteTarget(upstream);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await api(`/api/upstreams/${deleteTarget.id}`, { method: 'DELETE' });
      await load();
      show('Deleted');
      setDeleteTarget(null);
    } catch (error) {
      show(error.message, true);
    } finally {
      setIsDeleting(false);
    }
  };

  const openBulkCaps = () => {
    setBulkMode('rules');
    setBulkCapValue(100);
    setBulkRules(DEFAULT_BULK_RULES);
    setBulkOpen(true);
  };

  const saveBulkCaps = async (event) => {
    event.preventDefault();
    const payload = bulkMode === 'rules'
      ? { rules: bulkRules.map(({ minQuotaLeft, capDollars }) => ({ minQuotaLeft, capDollars })) }
      : { target: bulkMode, capDollars: bulkCapValue };
    if (bulkMode === 'rules' && (!payload.rules.length || payload.rules.some((rule) => rule.minQuotaLeft == null || rule.capDollars == null))) {
      show('Enter non-negative numbers for every quota and cap', true);
      return;
    }
    if (bulkMode !== 'rules' && bulkCapValue == null) {
      show('Enter a cap amount', true);
      return;
    }
    await run(async () => {
      await api('/api/spending-caps/bulk', { method: 'POST', body: JSON.stringify(payload) });
      setBulkOpen(false);
      await load();
    }, 'Bulk caps updated', show);
  };

  return (
    <Theme theme={neutralTheme} mode={themeMode}>
      <AppShell variant="elevated" height="auto" contentPadding={4} mobileNav={false}>
        <VStack gap={6}>
          <HStack justify="between" vAlign="start" gap={3} wrap="wrap">
            <VStack gap={1}>
              <Heading level={1}>Codex Pooler Node</Heading>
              <Text type="supporting" color="secondary">Small local upstream and quota dashboard. Credentials never leave this server.</Text>
            </VStack>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Button
                label={themeMode === 'dark' ? 'Light mode' : 'Dark mode'}
                variant="secondary"
                onClick={() => setThemeMode(themeMode === 'dark' ? 'light' : 'dark')}
              />
              <Button label="Reload" variant="secondary" isLoading={loading} onClick={() => void load()} />
            </HStack>
          </HStack>

          <VStack gap={2}>
            <Heading level={2} id="metrics-title">Pool overview & metrics</Heading>
            <Grid columns={{ minWidth: 150, max: 8, repeat: 'fit' }} gap={2}>
              <Metric label="Total" value={stats.total} breakdown={`Codex ${stats.totalCodex} · Compass ${stats.totalCompass}`} />
              <Metric label="Active" value={stats.active} />
              <Metric label="Reauth required" value={stats.reauth} />
              <Metric label="Low quota (<30%)" value={stats.lowQuota} />
              <Metric label="Uncapped" value={stats.uncapped} />
              <Metric label="Exhausted" value={stats.exhausted} />
              <Metric label="Spending cap left" value={`$${formatNumber(stats.capLeft)}`} />
              <Metric label="Spending cap spent" value={`$${formatNumber(stats.capSpent)}`} />
            </Grid>
          </VStack>

          <VStack gap={2}>
            <Heading level={2} id="filters-title">Search & filter upstreams</Heading>
            <Grid columns={{ minWidth: 200, max: 5, repeat: 'fit' }} gap={2}>
              <TextInput label="Search" isLabelHidden value={filterQuery} onChange={setFilterQuery} placeholder="Search by name, id, or email..." hasClear />
              <SegmentedControl label="Type" value={filterType || 'all'} onChange={(value) => setFilterType(value === 'all' ? '' : value)}>
                <SegmentedControlItem value="all" label="All" />
                <SegmentedControlItem value="codex" label="Codex" />
                <SegmentedControlItem value="compass" label="Compass" />
              </SegmentedControl>
              <Selector label="Status" isLabelHidden options={FILTER_OPTIONS.status} value={filterStatus} onChange={setFilterStatus} />
              <Selector label="Quota" isLabelHidden options={FILTER_OPTIONS.quota} value={filterQuota} onChange={setFilterQuota} />
              <Selector label="Sort" isLabelHidden options={FILTER_OPTIONS.sort} value={filterSort} onChange={setFilterSort} />
            </Grid>
          </VStack>

          <VStack gap={2}>
            <HStack align="center" justify="between">
              <Heading level={2} id="upstreams-title">Configured upstreams</Heading>
              <HStack gap={2}>
                <Button label="Bulk set caps" size="sm" variant="secondary" onClick={() => setBulkOpen(true)} />
                <Button label="Add upstream" size="sm" variant="primary" onClick={add} />
              </HStack>
            </HStack>
            {filteredUpstreams.length ? (
              <Grid columns={{ minWidth: 280, max: 4, repeat: 'fit' }} gap={3}>{filteredUpstreams.map((upstream) => <UpstreamCard key={upstream.id} upstream={upstream} onRefresh={refresh} onRefreshToken={promptRefreshToken} isRefreshingToken={isRefreshingToken && refreshTokenTarget?.id === upstream.id} onEdit={edit} onCap={openCap} onDelete={remove} />)}</Grid>
            ) : (
              <EmptyState title={upstreams.length ? 'No matching upstreams' : 'No upstreams yet'} description={upstreams.length ? 'Try changing the current filters.' : 'Add a Codex or Compass upstream to start routing requests.'} />
            )}
          </VStack>

          <AlertDialog
            isOpen={Boolean(message.text)}
            onOpenChange={(isOpen) => { if (!isOpen) setMessage({ text: '', error: false }); }}
            title={message.error ? 'Error' : 'Notification'}
            description={message.text}
            actionLabel="OK"
            actionVariant={message.error ? 'destructive' : 'primary'}
            onAction={() => setMessage({ text: '', error: false })}
          />


          <CapDialog
            upstream={capUpstream}
            value={capValue}
            onValueChange={setCapValue}
            onClose={() => setCapUpstream(null)}
            onSubmit={saveCap}
          />

          <BulkCapDialog
            open={bulkOpen}
            mode={bulkMode}
            capValue={bulkCapValue}
            rules={bulkRules}
            onModeChange={setBulkMode}
            onCapValueChange={setBulkCapValue}
            onRulesChange={setBulkRules}
            onClose={() => setBulkOpen(false)}
            onSubmit={saveBulkCaps}
          />
          <AlertDialog
            isOpen={Boolean(deleteTarget)}
            onOpenChange={(isOpen) => { if (!isOpen) setDeleteTarget(null); }}
            title="Delete upstream?"
            description={deleteTarget ? `Are you sure you want to delete "${deleteTarget.type === 'codex' && deleteTarget.email ? deleteTarget.email : deleteTarget.name}" (${deleteTarget.id})? This action cannot be undone.` : ''}
            actionLabel="Delete"
            actionVariant="destructive"
            isActionLoading={isDeleting}
            onAction={confirmDelete}
          />
          <AlertDialog
            isOpen={Boolean(refreshTarget)}
            onOpenChange={(isOpen) => { if (!isOpen) setRefreshTarget(null); }}
            title="Refresh upstream quota?"
            description={refreshTarget ? `Fetch live quota information from provider for "${refreshTarget.name}"?` : ''}
            actionLabel="Refresh"
            actionVariant="primary"
            isActionLoading={isRefreshing}
            onAction={confirmRefresh}
          />
          <AlertDialog
            isOpen={Boolean(refreshTokenTarget)}
            onOpenChange={(isOpen) => { if (!isOpen) setRefreshTokenTarget(null); }}
            title="Refresh OAuth token?"
            description={refreshTokenTarget ? `Obtain new access token for "${refreshTokenTarget.name}" using refresh token?${refreshTokenTarget.email ? `\nEmail: ${refreshTokenTarget.email}` : ''}${refreshTokenTarget.accessTokenExpiresAt ? `\nExpires: ${formatTokenExpiry(refreshTokenTarget.accessTokenExpiresAt)}` : ''}` : ''}
            actionLabel="Refresh Token"
            actionVariant="primary"
            isActionLoading={isRefreshingToken}
            onAction={confirmRefreshToken}
          />
          <Dialog isOpen={formDialog.isOpen} onOpenChange={() => setFormDialog((s) => ({ ...s, isOpen: false }))} width={640} purpose="form">
            <Layout
              header={<DialogHeader title={formDialog.mode === 'edit' ? 'Edit upstream' : 'Add upstream'} hasDivider />}
              content={(
                <LayoutContent>
                  <form id="upstream-form" onSubmit={async (e) => {
                    e.preventDefault();
                    await saveUpstream(formValues, formDialog.mode, formDialog.upstream?.id);
                    setFormDialog((s) => ({ ...s, isOpen: false }));
                  }}>
                    <VStack gap={3}>
                      <Selector
                        label="Type"
                        options={[{ value: 'codex', label: 'Codex' }, { value: 'compass', label: 'Compass' }]}
                        value={formValues.type}
                        onChange={(value) => updateForm('type', value)}
                        isDisabled={formDialog.mode === 'edit'}
                        width="100%"
                      />
                      {formValues.type === 'codex' ? (
                        <TextArea
                          label="Codex auth.json"
                          description="The account name is derived from the JWT email."
                          value={formValues.authJson || ''}
                          onChange={(value) => updateForm('authJson', value)}
                          placeholder="Paste auth.json here (tokens.access_token, refresh_token, id_token)"
                          rows={20}
                          htmlName="authJson"
                        />
                      ) : (
                        <Grid columns={{ minWidth: 280, max: 2, repeat: 'fit' }} gap={3}>
                          <TextInput label="Project ID" value={formValues.projectId || ''} onChange={(value) => updateForm('projectId', value)} placeholder="e.g. prj_12345" />
                          <TextInput label="Project key" value={formValues.projectKey || ''} onChange={(value) => updateForm('projectKey', value)} placeholder="e.g. key_67890" />
                          <GridSpan columns="full">
                            <Text type="supporting" color="secondary">The account name is derived from the project ID.</Text>
                          </GridSpan>
                        </Grid>
                      )}
                    </VStack>
                  </form>
                </LayoutContent>
              )}
              footer={(
                <LayoutFooter hasDivider>
                  <HStack justify="end" gap={2}>
                    <Button label="Cancel" variant="secondary" onClick={() => setFormDialog((s) => ({ ...s, isOpen: false }))} />
                    <Button label="Save" variant="primary" type="submit" form="upstream-form" />
                  </HStack>
                </LayoutFooter>
              )}
            />
          </Dialog>
        </VStack>
      </AppShell>
    </Theme>
  );
}

function Metric({ label, value, breakdown }) {
  return (
    <Card variant="muted" padding={2}>
      <VStack gap={1}>
        <Text type="supporting" color="secondary">{label}</Text>
        <Heading level={3} type="display-3">{value}</Heading>
        {breakdown && <Text type="supporting" color="secondary">{breakdown}</Text>}
      </VStack>
    </Card>
  );
}

function UpstreamCard({ upstream, onRefresh, onRefreshToken, isRefreshingToken, onEdit, onCap, onDelete }) {
  const quota = upstream.quota;
  const spending = upstream.spending || {};
  const quotaRemaining = quota ? Math.min(100, Math.max(0, quota.remainingPercent)) : 0;
  const spendingRemaining = spending.capCredits > 0 ? Math.min(100, Math.max(0, 100 - spending.percentUsed)) : 0;
  const compassWorkspaceId = upstream.type === 'compass' ? (upstream.metadata?.workspace_id ?? upstream.metadata?.workspaceId) : null;
  const compassUrl = compassWorkspaceId ? `https://smart.shopee.io/workspace-management?tab=quota&workspace_id=${compassWorkspaceId}` : null;
  const tokenExpiry = upstream.type === 'compass'
    ? (compassUrl ? <a href={compassUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-text-link, inherit)', textDecoration: 'underline' }}>More Info</a> : 'No expiry')
    : upstream.accessTokenExpiresAt ? formatTokenExpiry(upstream.accessTokenExpiresAt) : 'Expiry unknown';
  const expiresSoon = upstream.type === 'codex' && upstream.accessTokenExpiresAt && new Date(upstream.accessTokenExpiresAt).getTime() - Date.now() < 12 * 60 * 60 * 1000;
  const capHeading = spending.capCredits > 0 ? `${formatPercent(spendingRemaining)} left` : 'No spending cap';
  const capRemainingDollars = Math.max(0, (spending.capDollars || 0) - (spending.spentDollars || 0));
  const capUsage = spending.capCredits > 0
    ? `$${formatNumber(capRemainingDollars)} left of $${formatNumber(spending.capDollars)} · ${spending.status}`
    : 'Set a cap to make this upstream routable';
  const recentActiveText = formatTimeAgo(getRecentActiveTs(upstream));
  const tokenRefresh = upstream.tokenRefresh;
  const quotaVariant = !quota ? 'neutral' : quotaRemaining <= 15 ? 'error' : quotaRemaining <= 30 ? 'warning' : 'accent';
  const spendingVariant = spending.capCredits <= 0 ? 'neutral' : spendingRemaining <= 15 ? 'error' : spendingRemaining <= 30 ? 'warning' : 'accent';
  const trackBgMap = {
    error: 'var(--color-background-red)',
    warning: 'var(--color-background-yellow)',
    accent: 'var(--color-background-blue)',
  };
  return (
    <Card>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <VStack gap={1}>
            <Heading level={3}>{upstream.name}</Heading>
            {expiresSoon ? <Badge label={tokenExpiry} variant="warning" /> : <Text type="supporting" color="secondary">{tokenExpiry}</Text>}
            {tokenRefresh?.status === 'failed' && <Badge label="Token refresh failed" variant="error" />}
            {tokenRefresh?.status === 'reauth_required' && <Badge label="Reauthentication required" variant="error" />}
          </VStack>
          <Badge label={upstream.type} variant={upstream.type === 'compass' ? 'teal' : 'purple'} />
        </HStack>
        <VStack gap={1}>
          <HStack justify="between" vAlign="center" gap={2} wrap="wrap"><Text type="label" weight="bold">{quota ? `${formatPercent(quota.remainingPercent)} left` : 'Not refreshed'}</Text><Text type="supporting" color="secondary">{quota ? `reset ${formatDate(quota.resetAt)}` : 'Click refresh to read provider quota'}</Text></HStack>
          <ProgressBar
            label="Quota remaining"
            value={!quota ? 0 : quotaRemaining}
            max={100}
            isLabelHidden
            variant={quotaVariant}
            style={trackBgMap[quotaVariant] ? { '--color-background-muted': trackBgMap[quotaVariant] } : undefined}
          />
          {quotaCount(quota) && <Text type="supporting" color="secondary">{quotaCount(quota)}</Text>}
        </VStack>
        <VStack gap={1}>
          <Text type="label" weight="bold">{capHeading}</Text>
          <ProgressBar
            label="Spending cap remaining"
            value={spending.capCredits <= 0 ? 0 : spendingRemaining}
            max={100}
            isLabelHidden
            variant={spendingVariant}
            style={trackBgMap[spendingVariant] ? { '--color-background-muted': trackBgMap[spendingVariant] } : undefined}
          />
          <HStack justify="between" vAlign="center" gap={2}>
            <Text type="supporting" color="secondary">{capUsage}</Text>
            {recentActiveText && <Text type="supporting" color="secondary">{recentActiveText}</Text>}
          </HStack>
        </VStack>
        <HStack gap={2} wrap="wrap">
          <Button label="Refresh" size="sm" variant="secondary" onClick={() => onRefresh(upstream)} />
          {upstream.type === 'codex' && <Button label="Refresh token" size="sm" variant="secondary" isLoading={isRefreshingToken} isDisabled={isRefreshingToken || tokenRefresh?.status === 'refreshing'} onClick={() => onRefreshToken(upstream)} />}
          <Button label="Edit" size="sm" variant="secondary" onClick={() => onEdit(upstream)} />
          <Button label="Set cap" size="sm" variant="secondary" onClick={() => onCap(upstream)} />
          <Button label="Delete" size="sm" variant="destructive" onClick={() => onDelete(upstream)} />
        </HStack>
      </VStack>
    </Card>
  );
}

function CapDialog({ upstream, value, onValueChange, onClose, onSubmit }) {
  return (
    <Dialog isOpen={Boolean(upstream)} onOpenChange={onClose} purpose="form" width={400}>
      <Layout
        header={<DialogHeader title="Set spending cap" subtitle={upstream ? `For ${upstream.name}` : undefined} onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            <form id="single-cap-form" onSubmit={onSubmit}>
              <VStack gap={3}>
                <Text type="supporting" color="secondary">Enter 0 to clear this upstream's spending cap.</Text>
                <NumberInput label="Cap (USD)" value={value} onChange={onValueChange} min={0} step={0.01} hasClear />
              </VStack>
            </form>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter hasDivider>
            <HStack justify="end" gap={2}>
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button label="Save cap" variant="primary" type="submit" form="single-cap-form" />
            </HStack>
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function BulkCapDialog({ open, mode, capValue, rules, onModeChange, onCapValueChange, onRulesChange, onClose, onSubmit }) {
  const updateRule = (index, field, value) => onRulesChange(rules.map((rule, current) => current === index ? { ...rule, [field]: value } : rule));
  return (
    <Dialog isOpen={open} onOpenChange={onClose} purpose="form" width={560}>
      <Layout
        header={<DialogHeader title="Set spending caps" subtitle="Apply a cap strategy to multiple upstreams." onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            <form id="bulk-cap-form" onSubmit={onSubmit}>
              <VStack gap={4}>
                <Text type="supporting" color="secondary">Quota rules use monthly quota left in USD. The original server preset is pre-filled.</Text>
                <Selector
                  label="Strategy"
                  options={[{ value: 'rules', label: 'Original quota presets' }, { value: 'all', label: 'Set one cap for all upstreams' }, { value: 'cap_reached', label: 'Replace caps already reached' }, { value: 'uncapped', label: 'Set caps on uncapped upstreams' }]}
                  value={mode}
                  onChange={onModeChange}
                />
                {mode === 'rules' ? (
                  <VStack gap={2}>
                    {rules.map((rule, index) => (
                      <Grid key={index} gap={4} columns={2} align="end">
                        <NumberInput label="Monthly quota left" value={rule.minQuotaLeft} onChange={(value) => updateRule(index, 'minQuotaLeft', value)} min={0} step={0.01} hasClear />
                        <HStack align="end" gap={4}>
                          <NumberInput width="100%" label="Spend cap" value={rule.capDollars} onChange={(value) => updateRule(index, 'capDollars', value)} min={0} step={0.01} hasClear />
                          <Field label={<VisuallyHidden>Remove</VisuallyHidden>}>
                            <Button label="Remove rule" tooltip="Remove rule" size="md" variant="ghost" isIconOnly icon="×" onClick={() => onRulesChange(rules.filter((_, current) => current !== index))} />
                          </Field>
                        </HStack>
                      </Grid>
                    ))}
                    <Button label="Add rule" variant="secondary" onClick={() => onRulesChange([...rules, { minQuotaLeft: null, capDollars: null }])} />
                  </VStack>
                ) : (
                  <NumberInput label="Cap (USD)" value={capValue} onChange={onCapValueChange} min={0} step={0.01} hasClear />
                )}
              </VStack>
            </form>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter hasDivider>
            <HStack justify="end" gap={2}>
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button label="Save caps" variant="primary" type="submit" form="bulk-cap-form" />
            </HStack>
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

async function run(action, success, show) {
  try {
    await action();
    show(success);
  } catch (error) {
    show(error.message, true);
  }
}

function getQuotaBand(upstream) {
  const remaining = upstream.quota ? upstream.quota.remainingPercent : null;
  if (remaining == null || !Number.isFinite(remaining)) return 'unknown';
  if (remaining <= 0) return 'exhausted';
  if (remaining < 30) return 'low';
  if (remaining < 70) return 'moderate';
  return 'plenty';
}

function getExpiryTs(upstream) {
  if (!upstream.quota?.resetAt) return null;
  const timestamp = new Date(upstream.quota.resetAt).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function getRecentActiveTs(upstream) {
  const dates = [
    upstream.spending?.lastActivityAt,
    upstream.lastSuccessfulAt
  ].filter(Boolean);
  if (dates.length === 0) return 0;
  return Math.max(...dates.map(d => new Date(d).getTime()).filter(t => !Number.isNaN(t)));
}

function sortUpstreams(a, b, sort) {
  if (sort === 'recent_active') return getRecentActiveTs(b) - getRecentActiveTs(a) || nameSort(a, b);
  if (sort === 'quota') return quotaValue(b) - quotaValue(a) || nameSort(a, b);
  if (sort === 'quota_asc') return (quotaValue(a, 99999999) - quotaValue(b, 99999999)) || nameSort(a, b);
  if (sort === 'cap_left') return capValue(b, -1) - capValue(a, -1) || nameSort(a, b);
  if (sort === 'cap_left_asc') return capValue(a, 99999999) - capValue(b, 99999999) || nameSort(a, b);
  if (sort === 'expiry_asc' || sort === 'expiry_desc') {
    const missing = sort === 'expiry_asc' ? Infinity : -Infinity;
    const aTime = getExpiryTs(a) ?? missing;
    const bTime = getExpiryTs(b) ?? missing;
    return sort === 'expiry_asc' ? aTime - bTime || nameSort(a, b) : bTime - aTime || nameSort(a, b);
  }
  return nameSort(a, b);
}

function quotaValue(upstream, missing = -1) {
  if (!upstream.quota) return missing;
  return upstream.quota.remainingDollars ?? upstream.quota.remainingPercent ?? missing;
}

function capValue(upstream, missing) {
  const spending = upstream.spending;
  return spending?.capCredits > 0 ? Math.max(0, (spending.capDollars || 0) - (spending.spentDollars || 0)) : missing;
}

function nameSort(a, b) { return (a.name || '').localeCompare(b.name || ''); }
function formatNumber(value) { return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
function formatPercent(value) { return `${Math.round(Number(value) || 0)}%`; }
function quotaCount(quota) {
  if (!quota || !Number.isFinite(quota.remainingDollars) || !Number.isFinite(quota.limitDollars)) return '';
  const remaining = Math.max(0, quota.remainingDollars);
  return `$${formatNumber(remaining)} left of $${formatNumber(quota.limitDollars)}`;
}
function formatDate(value) { return value ? new Date(value).toLocaleString() : 'unknown'; }
function formatTokenExpiry(value) {
  const hours = Math.floor((new Date(value).getTime() - Date.now()) / (60 * 60 * 1000));
  if (hours < 0) return `Expired ${Math.ceil(-hours / 24)} day${Math.ceil(-hours / 24) === 1 ? '' : 's'} ago`;
  return `Expires in ${Math.floor(hours / 24)} day${Math.floor(hours / 24) === 1 ? '' : 's'} ${hours % 24} hour${hours % 24 === 1 ? '' : 's'}`;
}
function formatTimeAgo(ts) {
  if (!ts || ts <= 0) return 'no activity';
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'active just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `active ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `active ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `active ${days}d ago`;
}

createRoot(document.getElementById('root')).render(<App />);

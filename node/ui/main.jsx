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
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Field } from '@astryxdesign/core/Field';
import { Grid, GridSpan } from '@astryxdesign/core/Grid';
import { Heading, Text } from '@astryxdesign/core/Text';
import { Icon } from '@astryxdesign/core/Icon';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Switch } from '@astryxdesign/core/Switch';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { defineTheme, Theme } from '@astryxdesign/core/theme';
import { ToastViewport, useToast } from '@astryxdesign/core/Toast';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import { neutralTheme } from '@astryxdesign/theme-neutral';
import { HStack, Layout, LayoutContent, LayoutFooter, StackItem, VStack } from '@astryxdesign/core/Layout';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { PlugZap } from 'lucide-react';

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
    { value: 'reauth_required', label: 'Reauth required' },
    { value: 'refresh_failed', label: 'Refresh failed' },
    { value: 'cooling_down', label: 'Cooling down' },
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

const DEFAULT_PACING = {
  enabled: false,
  minStartIntervalMs: 0,
  modelIntervals: [],
  maxQueueDepth: 20,
  maxQueueAgeMs: 30000
};
const FORM_DEFAULTS = { name: '', type: 'codex', authJson: '', projectId: '', projectKey: '', accessToken: '', refreshToken: '', email: '', accountId: '', quotaSource: 'compass', pacing: DEFAULT_PACING };

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
      const nextKey = window.prompt('Enter the Relaydeck API key')?.trim() || '';
      if (nextKey) {
        sessionStorage.setItem('codex-pooler-api-key', nextKey);
        setApiKey(nextKey);
        response = await request(nextKey);
      }
    }
    const data = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || 'Request failed');
    return data;
  }, [apiKey]);
  return { api, apiKey };
}

const VIRTUAL_MIN_ITEMS = 24;
const VIRTUAL_OVERSCAN_ROWS = 2;
const METRIC_GRID_COLUMNS = { minWidth: 132, max: 10, repeat: 'fill' };
const UPSTREAM_GRID_COLUMNS = { minWidth: 280, max: 3, repeat: 'fill' };
const relayTheme = defineTheme({
  name: 'relaydeck',
  extends: neutralTheme,
  components: {
    toast: {
      base: { userSelect: 'text' }
    }
  }
});

// Windowed grid: renders only the rows near the viewport and reserves the rest
// of the height with padding. Row height and column count are measured from the
// live grid, so the responsive `repeat: fill` layout keeps working.
// ponytail: assumes uniform row height (cards are fixed-height); switch to
// per-row measurement if card contents ever vary in height.
function VirtualGrid({ items, renderItem, onVisibleItemsChange }) {
  const wrapperRef = useRef(null);
  const [metrics, setMetrics] = useState(null);
  const [range, setRange] = useState({ start: 0, end: VIRTUAL_MIN_ITEMS });
  const isVirtual = items.length > VIRTUAL_MIN_ITEMS;

  const measure = useCallback(() => {
    const grid = wrapperRef.current?.firstElementChild;
    const first = grid?.firstElementChild;
    if (!first) return;
    const styles = getComputedStyle(grid);
    const columns = styles.gridTemplateColumns.split(' ').filter((track) => parseFloat(track) > 0).length || 1;
    const rowHeight = first.getBoundingClientRect().height + (parseFloat(styles.rowGap) || 0);
    if (!(rowHeight > 0)) return;
    setMetrics((prev) => (prev && prev.columns === columns && Math.abs(prev.rowHeight - rowHeight) < 1 ? prev : { columns, rowHeight }));
  }, []);

  useEffect(() => {
    if (!isVirtual) { setMetrics(null); return undefined; }
    measure();
    const grid = wrapperRef.current?.firstElementChild;
    if (!grid || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [isVirtual, measure, items.length]);

  useEffect(() => {
    if (!isVirtual || !metrics) return undefined;
    const { rowHeight, columns } = metrics;
    const update = () => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const above = Math.max(0, -wrapper.getBoundingClientRect().top);
      const startRow = Math.max(0, Math.floor(above / rowHeight) - VIRTUAL_OVERSCAN_ROWS);
      const rows = Math.ceil(window.innerHeight / rowHeight) + VIRTUAL_OVERSCAN_ROWS * 2;
      const start = startRow * columns;
      const end = Math.min(items.length, start + rows * columns);
      setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    update();
    // capture:true also catches scrolling on any ancestor container.
    window.addEventListener('scroll', update, { capture: true, passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, { capture: true });
      window.removeEventListener('resize', update);
    };
  }, [isVirtual, metrics, items.length]);

  const windowed = isVirtual && metrics;
  const start = windowed ? Math.min(range.start, Math.max(0, items.length - 1)) : 0;
  const end = windowed ? range.end : isVirtual ? VIRTUAL_MIN_ITEMS : items.length;
  const columns = metrics?.columns || 1;
  const totalRows = Math.ceil(items.length / columns);
  const paddingTop = windowed ? (start / columns) * metrics.rowHeight : 0;
  const paddingBottom = windowed ? Math.max(0, (totalRows - Math.ceil(end / columns)) * metrics.rowHeight) : 0;

  useEffect(() => {
    onVisibleItemsChange?.(items.slice(start, end).map(({ id }) => id));
  }, [end, items, onVisibleItemsChange, start]);

  useEffect(() => () => onVisibleItemsChange?.([]), [onVisibleItemsChange]);

  return (
    <div ref={wrapperRef} style={{ paddingTop, paddingBottom }}>
      <Grid columns={UPSTREAM_GRID_COLUMNS} gap={2}>{items.slice(start, end).map(renderItem)}</Grid>
    </div>
  );
}

function Dashboard({ themeMode, setThemeMode }) {
  const { api, apiKey } = useApi();
  const toast = useToast();
  const [upstreams, setUpstreams] = useState([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [isManualReloading, setIsManualReloading] = useState(false);
  const [pacing, setPacing] = useState([]);
  const [formDialog, setFormDialog] = useState({ isOpen: false, mode: 'add', upstream: null });
  const [formValues, setFormValues] = useState(FORM_DEFAULTS);
  const [currentCredentials, setCurrentCredentials] = useState(null);
  const [currentCredentialsLoading, setCurrentCredentialsLoading] = useState(false);
  const [credentialTarget, setCredentialTarget] = useState(null);
  const [credentialValue, setCredentialValue] = useState('');
  const [credentialSaving, setCredentialSaving] = useState(false);
  const [credentialError, setCredentialError] = useState('');
  const [capUpstream, setCapUpstream] = useState(null);
  const [capValue, setCapValue] = useState(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState('');
  const [compatibilityOpen, setCompatibilityOpen] = useState(false);
  const [compatibility, setCompatibility] = useState(null);
  const [compatibilityLoading, setCompatibilityLoading] = useState(false);
  const [compatibilityError, setCompatibilityError] = useState('');
  const [compatibilityResetTarget, setCompatibilityResetTarget] = useState(null);
  const [compatibilityActionLoading, setCompatibilityActionLoading] = useState(false);
  const [systemStatusOpen, setSystemStatusOpen] = useState(false);
  const [systemStatus, setSystemStatus] = useState(null);
  const [systemStatusLoading, setSystemStatusLoading] = useState(false);
  const [systemStatusError, setSystemStatusError] = useState('');
  const [routingPolicy, setRoutingPolicy] = useState({ strategy: 'least-recent-success', quotaFreshnessMs: 300000 });
  const [bulkMode, setBulkMode] = useState('rules');
  const [bulkCapValue, setBulkCapValue] = useState(100);
  const [bulkRules, setBulkRules] = useState(DEFAULT_BULK_RULES);
  const [bulkUnknownValue, setBulkUnknownValue] = useState(5);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [refreshTarget, setRefreshTarget] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshTokenTarget, setRefreshTokenTarget] = useState(null);
  const [isRefreshingToken, setIsRefreshingToken] = useState(false);
  const [testingUpstreamId, setTestingUpstreamId] = useState(null);
  const [cooldownTarget, setCooldownTarget] = useState(null);
  const [isClearingCooldown, setIsClearingCooldown] = useState(false);
  const [filterQuery, setFilterQuery] = useStoredValue('codex_filter_filter-query');
  const [filterType, setFilterType] = useStoredValue('codex_filter_filter-type');
  const [filterStatus, setFilterStatus] = useStoredValue('codex_filter_filter-status');
  const [filterQuota, setFilterQuota] = useStoredValue('codex_filter_filter-quota');
  const [filterSort, setFilterSort] = useStoredValue('codex_filter_filter-sort', 'recent_active');
  const [visibleUpstreamIds, setVisibleUpstreamIds] = useState([]);
  const reloadTimer = useRef(null);
  const loadingRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const focusedQuotaRefreshingRef = useRef(false);

  const show = useCallback((text, error = false) => {
    toast({
      body: text,
      type: error ? 'error' : 'info',
      isAutoHide: !error,
      uniqueID: error ? 'relaydeck-error' : undefined
    });
    if (error) raiseToastViewport();
  }, [toast]);
  const loadSystemStatus = useCallback(async (pacingRows = null) => {
    const [diagnosticsData, catalogData, hostData, compatibilityData, pacingData] = await Promise.all([
      api('/api/diagnostics'),
      api('/api/model-catalog'),
      api('/api/codex-host-health'),
      api('/api/compatibility'),
      pacingRows === null ? api('/api/pacing') : { pacing: pacingRows }
    ]);
    const nextPacing = pacingData.pacing || [];
    setDiagnostics(diagnosticsData);
    setCompatibility(compatibilityData.compatibility);
    setPacing(nextPacing);
    setSystemStatus({
      diagnostics: diagnosticsData,
      catalog: catalogData.catalog,
      hostHealth: hostData.hostHealth,
      pacing: nextPacing,
      compatibility: compatibilityData.compatibility
    });
  }, [api]);
  const load = useCallback(async (manual = false, includeSystemStatus = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (manual) setIsManualReloading(true);
    try {
      const [upstreamData, routingData, pacingData] = await Promise.all([
        api('/api/upstreams'),
        api('/api/routing'),
        api('/api/pacing')
      ]);
      setUpstreams(upstreamData.upstreams);
      setRoutingPolicy(routingData.policy);
      setPacing(pacingData.pacing || []);
      setLoadError('');
      if (includeSystemStatus) {
        try {
          await loadSystemStatus(pacingData.pacing || []);
          setSystemStatusError('');
        } catch (error) {
          setSystemStatusError(error.message);
          if (manual) show(error.message, true);
        }
      } else {
        setSystemStatus((current) => current ? { ...current, pacing: pacingData.pacing || [] } : current);
      }
    } catch (error) {
      setLoadError(error.message);
      if (hasLoadedRef.current || manual) show(error.message, true);
    } finally {
      loadingRef.current = false;
      hasLoadedRef.current = true;
      setHasLoaded(true);
      if (manual) setIsManualReloading(false);
    }
  }, [api, loadSystemStatus, show]);

  const updateVisibleUpstreamIds = useCallback((nextIds) => {
    setVisibleUpstreamIds((current) => current.length === nextIds.length && current.every((id, index) => id === nextIds[index]) ? current : nextIds);
  }, []);

  useEffect(() => { void load(false, true); }, [load]);

  useEffect(() => {
    let timer = null;
    let cancelled = false;
    const focused = () => document.visibilityState === 'visible' && document.hasFocus();
    const refreshFocusedQuota = async () => {
      if (cancelled || !focused() || focusedQuotaRefreshingRef.current || !visibleUpstreamIds.length) return;
      focusedQuotaRefreshingRef.current = true;
      try {
        const ids = encodeURIComponent(visibleUpstreamIds.join(','));
        await api(`/api/upstreams/refresh-quota?ids=${ids}&force=false`, { method: 'POST' });
        if (!cancelled) await load();
      } catch {
        // Background refresh remains available.
      } finally {
        focusedQuotaRefreshingRef.current = false;
      }
    };
    const updateTimer = () => {
      if (timer) window.clearInterval(timer);
      timer = null;
      if (focused()) {
        void refreshFocusedQuota();
        timer = window.setInterval(() => void refreshFocusedQuota(), 60_000);
      }
    };
    window.addEventListener('focus', updateTimer);
    window.addEventListener('blur', updateTimer);
    document.addEventListener('visibilitychange', updateTimer);
    updateTimer();
    return () => {
      cancelled = true;
      window.removeEventListener('focus', updateTimer);
      window.removeEventListener('blur', updateTimer);
      document.removeEventListener('visibilitychange', updateTimer);
      if (timer) window.clearInterval(timer);
    };
  }, [api, load, visibleUpstreamIds]);

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

  const filteredUpstreams = useMemo(() => {
    let filtered = upstreams.slice();
    const query = filterQuery.trim().toLowerCase();
    if (query) {
      filtered = filtered.filter((upstream) => matchesSearch([upstream.name, upstream.email, upstream.id, upstream.accountId, upstream.projectId], query));
    }
    if (filterType) filtered = filtered.filter((upstream) => upstream.type === filterType);
    if (filterStatus === 'exhausted') {
      filtered = filtered.filter((upstream) => getQuotaBand(upstream) === 'exhausted');
    } else if (filterStatus === 'uncapped') {
      filtered = filtered.filter((upstream) => !upstream.spending || upstream.spending.capCredits <= 0);
    } else if (filterStatus === 'reauth_required') {
      filtered = filtered.filter(isReauthRequired);
    } else if (filterStatus === 'refresh_failed') {
      filtered = filtered.filter((upstream) => upstream.tokenRefresh?.status === 'failed');
    } else if (filterStatus === 'cooling_down') {
      filtered = filtered.filter(hasActiveCooldown);
    }
    if (filterQuota) filtered = filtered.filter((upstream) => getQuotaBand(upstream) === filterQuota);
    return filtered.sort((a, b) => sortUpstreams(a, b, filterSort));
  }, [filterQuery, filterType, filterStatus, filterQuota, filterSort, upstreams]);

  // Metrics reflect the current filters (e.g. Type=Codex shows Codex-only counts), not the full pool.
  const stats = useMemo(() => {
    let reauth = 0;
    let coolingDown = 0;
    let lowQuota = 0;
    let uncapped = 0;
    let exhausted = 0;
    let capLeft = 0;
    let capSpent = 0;
    let totalCodex = 0;
    let activeCodex = 0;
    let totalCompass = 0;
    let activeCompass = 0;
    let totalClaude = 0;
    let activeClaude = 0;
    filteredUpstreams.forEach((upstream) => {
      const active = isUpstreamActive(upstream);
      if (upstream.type === 'codex') {
        totalCodex += 1;
        if (active) activeCodex += 1;
      }
      if (upstream.type === 'compass') {
        totalCompass += 1;
        if (active) activeCompass += 1;
      }
      if (upstream.type === 'claude') {
        totalClaude += 1;
        if (active) activeClaude += 1;
      }
      if (isReauthRequired(upstream)) reauth += 1;
      if (hasActiveCooldown(upstream)) coolingDown += 1;
      const quotaBand = getQuotaBand(upstream);
      if (quotaBand === 'exhausted') exhausted += 1;
      if (quotaBand === 'low') lowQuota += 1;
      const spending = upstream.spending || {};
      if (spending.capCredits <= 0) {
        uncapped += 1;
      } else {
        capLeft += Math.max(0, (spending.capDollars || 0) - (spending.spentDollars || 0));
        capSpent += spending.spentDollars || 0;
      }
    });
    return { totalCodex, activeCodex, totalCompass, activeCompass, totalClaude, activeClaude, reauth, coolingDown, lowQuota, uncapped, exhausted, capLeft, capSpent };
  }, [filteredUpstreams]);

  const updateForm = (field, value) => setFormValues((current) => ({ ...current, [field]: value }));
  const updatePacing = (field, value) => setFormValues((current) => ({
    ...current,
    pacing: { ...DEFAULT_PACING, ...(current.pacing || {}), [field]: value }
  }));
  const updateModelInterval = (index, field, value) => setFormValues((current) => ({
    ...current,
    pacing: {
      ...DEFAULT_PACING,
      ...(current.pacing || {}),
      modelIntervals: (current.pacing?.modelIntervals || []).map((entry, currentIndex) => (
        currentIndex === index ? { ...entry, [field]: value } : entry
      ))
    }
  }));
  const resetForm = useCallback(() => {
    setFormValues({ ...FORM_DEFAULTS, pacing: { ...DEFAULT_PACING, modelIntervals: [] } });
    setCurrentCredentials(null);
    setFormDialog((s) => ({ ...s, isOpen: false }));
  }, []);

  const add = () => {
    resetForm();
    setFormDialog({ isOpen: true, mode: 'add', upstream: null });
  };

  const saveUpstream = async (values, mode, id) => {
    const data = {
      ...values,
      pacing: {
        ...DEFAULT_PACING,
        ...(values.pacing || {}),
        modelIntervals: (values.pacing?.modelIntervals || [])
          .map((entry) => ({ model: String(entry.model || '').trim(), minStartIntervalMs: entry.minStartIntervalMs ?? 0 }))
          .filter((entry) => entry.model)
      }
    };
    if (!data.authJson) delete data.authJson;
    if (!data.accessToken) delete data.accessToken;
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

  const edit = (upstream) => {
    setFormValues({
      ...upstream,
      name: upstream.name || '',
      authJson: '',
      accessToken: '',
      projectKey: '',
      quotaSource: upstream.quotaSource || 'compass',
      pacing: { ...DEFAULT_PACING, ...(upstream.pacing || {}), modelIntervals: [...(upstream.pacing?.modelIntervals || [])] }
    });
    setCurrentCredentials(null);
    setFormDialog({ isOpen: true, mode: 'edit', upstream });
  };

  const revealCurrentCredentials = async () => {
    const upstream = formDialog.upstream;
    if (!upstream) return;
    setCurrentCredentialsLoading(true);
    try {
      const data = await api(`/api/upstreams/${upstream.id}/credentials`);
      setCurrentCredentials(JSON.stringify(data.credentials, null, 2));
    } catch (error) {
      show(error.message, true);
    } finally {
      setCurrentCredentialsLoading(false);
    }
  };

  const replaceCredentials = (upstream) => {
    setCredentialTarget(upstream);
    setCredentialValue('');
    setCredentialError('');
  };

  const saveCredentials = async (event) => {
    event.preventDefault();
    if (!credentialTarget) return;
    setCredentialSaving(true);
    setCredentialError('');
    try {
      await api(`/api/upstreams/${credentialTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify(credentialTarget.type === 'codex'
          ? { authJson: credentialValue }
          : credentialTarget.type === 'claude'
            ? (credentialValue.trim().startsWith('{') ? { authJson: credentialValue } : { accessToken: credentialValue.trim() })
          : { projectKey: credentialValue })
      });
      setCredentialTarget(null);
      setCredentialValue('');
      show('Credentials replaced');
      await load();
    } catch (error) {
      setCredentialError(error.message);
    } finally {
      setCredentialSaving(false);
    }
  };

  const refresh = (upstream) => {
    setRefreshTarget(upstream);
  };

  const confirmRefresh = async () => {
    if (!refreshTarget) return;
    setIsRefreshing(true);
    try {
      await api(refreshTarget.all ? '/api/upstreams/refresh-quota' : `/api/upstreams/${refreshTarget.id}/refresh-quota`, { method: 'POST' });
      await load();
      show(refreshTarget.all ? 'All quotas refreshed' : 'Quota refreshed');
      setRefreshTarget(null);
    } catch (error) {
      setRefreshTarget(null);
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
    const { id } = refreshTokenTarget;
    setRefreshTokenTarget(null);
    setIsRefreshingToken(true);
    try {
      await api(`/api/upstreams/${id}/refresh-token`, { method: 'POST' });
      show('Token refreshed');
    } catch (error) {
      show(error.message, true);
    } finally {
      await load();
      setIsRefreshingToken(false);
    }
  };

  const clearCooldown = (upstream) => {
    setCooldownTarget(upstream);
  };

  const testConnection = async (upstream) => {
    setTestingUpstreamId(upstream.id);
    try {
      const data = await api(`/api/upstreams/${upstream.id}/test-connection`, { method: 'POST', body: '{}' });
      const connection = data.connection;
      show(connectionSuccessMessage(connection));
      await load();
    } catch (error) {
      show(error.message, true);
    } finally {
      setTestingUpstreamId(null);
    }
  };

  const confirmClearCooldown = async () => {
    if (!cooldownTarget) return;
    setIsClearingCooldown(true);
    try {
      await api(`/api/upstreams/${cooldownTarget.id}/clear-cooldown`, { method: 'POST' });
      setCooldownTarget(null);
      show('Cooldown cleared');
      await load();
    } catch (error) {
      show(error.message, true);
    } finally {
      setIsClearingCooldown(false);
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

  const savePriority = (ids) => run(async () => {
    await api('/api/upstreams/priority', { method: 'PUT', body: JSON.stringify({ ids }) });
    setPriorityOpen(false);
    await load();
  }, 'Priority list updated', show);

  const saveRouting = (strategy) => run(async () => {
    const data = await api('/api/routing', { method: 'PUT', body: JSON.stringify({ strategy }) });
    setRoutingPolicy(data.policy);
    setRoutingOpen(false);
  }, 'Routing strategy updated', show);

  const openDiagnostics = async () => {
    setDiagnosticsOpen(true);
    setDiagnosticsLoading(true);
    setDiagnosticsError('');
    try {
      setDiagnostics(await api('/api/diagnostics'));
    } catch (error) {
      setDiagnosticsError(error.message);
    } finally {
      setDiagnosticsLoading(false);
    }
  };

  const openCompatibility = async () => {
    setCompatibilityOpen(true);
    setCompatibilityLoading(true);
    setCompatibilityError('');
    try {
      const data = await api('/api/compatibility');
      setCompatibility(data.compatibility);
    } catch (error) {
      setCompatibilityError(error.message);
    } finally {
      setCompatibilityLoading(false);
    }
  };

  const resetCompatibility = async () => {
    if (!compatibilityResetTarget) return;
    setCompatibilityActionLoading(true);
    try {
      const path = compatibilityResetTarget.all
        ? '/api/compatibility/facts'
        : `/api/compatibility/facts/${compatibilityResetTarget.id}`;
      await api(path, { method: 'DELETE' });
      show(compatibilityResetTarget.all ? 'Compatibility facts reset' : 'Compatibility fact reset');
      setCompatibilityResetTarget(null);
      await openCompatibility();
    } catch (error) {
      show(error.message, true);
    } finally {
      setCompatibilityActionLoading(false);
    }
  };

  const openSystemStatus = async () => {
    setSystemStatusOpen(true);
    setSystemStatusLoading(true);
    setSystemStatusError('');
    try {
      await loadSystemStatus();
    } catch (error) {
      setSystemStatusError(error.message);
    } finally {
      setSystemStatusLoading(false);
    }
  };

  const openBulkCaps = () => {
    setBulkMode('rules');
    setBulkCapValue(100);
    setBulkRules(DEFAULT_BULK_RULES);
    setBulkUnknownValue(5);
    setBulkOpen(true);
  };

  const saveBulkCaps = async (event) => {
    event.preventDefault();
    const payload = bulkMode === 'rules'
      ? { rules: bulkRules.map(({ minQuotaLeft, capDollars }) => ({ minQuotaLeft, capDollars })), unknownQuotaDollars: bulkUnknownValue }
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

  const pacingByUpstream = useMemo(
    () => new Map(pacing.map((entry) => [entry.upstreamId, entry])),
    [pacing]
  );
  const systemSummary = summarizeSystemStatus(systemStatus, upstreams, systemStatusError);

  return (
    <AppShell variant="elevated" height="auto" contentPadding={3} mobileNav={false}>
      <VStack gap={4} width="max(1280px, 100%)">
          <HStack justify="between" vAlign="start" gap={2} wrap="wrap">
            <VStack gap={1}>
              <Heading level={1}>Relaydeck</Heading>
              <Text type="supporting" color="secondary">Small local upstream and quota dashboard. Credentials never leave this server.</Text>
            </VStack>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Button
                label={themeMode === 'dark' ? 'Light mode' : 'Dark mode'}
                variant="secondary"
                onClick={() => setThemeMode(themeMode === 'dark' ? 'light' : 'dark')}
              />
              <Button label="Reload" variant="secondary" isLoading={isManualReloading} onClick={() => void load(true, true)} />
            </HStack>
          </HStack>

          <VStack gap={1}>
            <Heading level={2} id="filters-title">Search & filter upstreams</Heading>
            <HStack gap={1} wrap="wrap" vAlign="start">
              <StackItem size="static">
                <SegmentedControl label="Type" value={filterType || 'all'} onChange={(value) => setFilterType(value === 'all' ? '' : value)}>
                  <SegmentedControlItem value="all" label="All" />
                  <SegmentedControlItem value="codex" label="Codex" />
                  <SegmentedControlItem value="compass" label="Compass" />
                  <SegmentedControlItem value="claude" label="Claude" />
                </SegmentedControl>
              </StackItem>
              <StackItem size="fill">
                <TextInput label="Search" isLabelHidden value={filterQuery} onChange={setFilterQuery} placeholder="Search by name, id, or email..." hasClear />
              </StackItem>
              <StackItem size="fill">
                <Selector label="Status" isLabelHidden options={FILTER_OPTIONS.status} value={filterStatus} onChange={setFilterStatus} />
              </StackItem>
              <StackItem size="fill">
                <Selector label="Quota" isLabelHidden options={FILTER_OPTIONS.quota} value={filterQuota} onChange={setFilterQuota} />
              </StackItem>
              <StackItem size="fill">
                <Selector label="Sort" isLabelHidden options={FILTER_OPTIONS.sort} value={filterSort} onChange={setFilterSort} />
              </StackItem>
            </HStack>
          </VStack>

          <VStack gap={1}>
            <Heading level={2} id="metrics-title">Pool overview & metrics</Heading>
            {!hasLoaded ? (
              <MetricSkeletons />
            ) : (
              <Grid columns={METRIC_GRID_COLUMNS} gap={2}>
                {filterType !== 'compass' && filterType !== 'claude' && <Metric label="Codex active / total" value={`${stats.activeCodex}/${stats.totalCodex}`} />}
                {filterType !== 'codex' && filterType !== 'claude' && <Metric label="Compass active / total" value={`${stats.activeCompass}/${stats.totalCompass}`} />}
                {filterType !== 'codex' && filterType !== 'compass' && <Metric label="Claude active / total" value={`${stats.activeClaude}/${stats.totalClaude}`} />}
                <Metric label="Cooling down" value={stats.coolingDown} />
                <Metric label="Reauth required" value={stats.reauth} />
                <Metric label="Low quota (<30%)" value={stats.lowQuota} />
                <Metric label="Uncapped" value={stats.uncapped} />
                <Metric label="Exhausted" value={stats.exhausted} />
                <Metric label="Spending cap left" value={`$${formatNumber(stats.capLeft)}`} />
                <Metric label="Spending cap spent" value={`$${formatNumber(stats.capSpent)}`} />
              </Grid>
            )}
          </VStack>

          <VStack gap={1}>
            <HStack align="center" justify="between" gap={1} wrap="wrap">
              <Heading level={2} id="upstreams-title">Configured upstreams</Heading>
              <HStack gap={1} wrap="wrap">
                <Button
                  label="System status"
                  size="sm"
                  variant="secondary"
                  endContent={systemSummary.warningCount > 0 ? <Badge label={String(systemSummary.warningCount)} variant="warning" /> : undefined}
                  onClick={() => void openSystemStatus()}
                />
                <Button label="Routing" size="sm" variant="secondary" onClick={() => setRoutingOpen(true)} />
                <MoreMenu
                  label="Management actions"
                  size="sm"
                  variant="secondary"
                  items={[
                    { label: 'Compatibility', onClick: () => void openCompatibility() },
                    { label: 'Diagnostics', onClick: () => void openDiagnostics() },
                    { type: 'divider' },
                    { label: 'Refresh all quotas', onClick: () => setRefreshTarget({ all: true }) },
                    { label: 'Set priority', onClick: () => setPriorityOpen(true) },
                    { label: 'Bulk set caps', onClick: openBulkCaps }
                  ]}
                />
                <Button label="Add upstream" size="sm" variant="primary" onClick={add} />
              </HStack>
            </HStack>
            {loadError && hasLoaded && <Banner title="Could not load upstreams" description={loadError} status="error" />}
            {!hasLoaded ? (
              <UpstreamSkeletons />
            ) : loadError && upstreams.length === 0 ? (
              <EmptyState title="Upstreams unavailable" description="Reload the dashboard after the management API is available." />
            ) : filteredUpstreams.length ? (
              <VirtualGrid
                items={filteredUpstreams}
                onVisibleItemsChange={updateVisibleUpstreamIds}
                renderItem={(upstream) => (
                  <UpstreamCard
                    key={upstream.id}
                    upstream={upstream}
                    pacing={pacingByUpstream.get(upstream.id)}
                    onRefresh={refresh}
                    onTestConnection={testConnection}
                    isTestingConnection={testingUpstreamId === upstream.id}
                    onRefreshToken={promptRefreshToken}
                    isRefreshingToken={isRefreshingToken && refreshTokenTarget?.id === upstream.id}
                    onClearCooldown={clearCooldown}
                    onEdit={edit}
                    onReplaceCredentials={replaceCredentials}
                    onCap={openCap}
                    onPriority={() => setPriorityOpen(true)}
                    onDelete={remove}
                  />
                )}
              />
            ) : (
              <EmptyState title={upstreams.length ? 'No matching upstreams' : 'No upstreams yet'} description={upstreams.length ? 'Try changing the current filters.' : 'Add a Codex, Compass, or Claude upstream to start routing requests.'} />
            )}
          </VStack>

          <CapDialog
            upstream={capUpstream}
            value={capValue}
            onValueChange={setCapValue}
            onClose={() => setCapUpstream(null)}
            onSubmit={saveCap}
          />

          <PriorityDialog isOpen={priorityOpen} upstreams={upstreams} onClose={() => setPriorityOpen(false)} onSave={savePriority} />
          <RoutingDialog isOpen={routingOpen} policy={routingPolicy} api={api} onClose={() => setRoutingOpen(false)} onSave={saveRouting} />
          <DiagnosticsDialog
            isOpen={diagnosticsOpen}
            diagnostics={diagnostics}
            isLoading={diagnosticsLoading}
            error={diagnosticsError}
            onRefresh={openDiagnostics}
            onClose={() => setDiagnosticsOpen(false)}
          />
          <CompatibilityDialog
            isOpen={compatibilityOpen}
            compatibility={compatibility}
            isLoading={compatibilityLoading}
            error={compatibilityError}
            onResetFact={(fact) => setCompatibilityResetTarget(fact)}
            onResetAll={() => setCompatibilityResetTarget({ all: true })}
            onRefresh={openCompatibility}
            onClose={() => setCompatibilityOpen(false)}
          />
          <BulkCapDialog
            open={bulkOpen}
            mode={bulkMode}
            capValue={bulkCapValue}
            rules={bulkRules}
            unknownValue={bulkUnknownValue}
            onModeChange={setBulkMode}
            onCapValueChange={setBulkCapValue}
            onRulesChange={setBulkRules}
            onUnknownValueChange={setBulkUnknownValue}
            onClose={() => setBulkOpen(false)}
            onSubmit={saveBulkCaps}
          />
          <SystemStatusDialog
            isOpen={systemStatusOpen}
            status={systemStatus}
            summary={systemSummary}
            isLoading={systemStatusLoading}
            error={systemStatusError}
            onRefresh={openSystemStatus}
            onOpenDiagnostics={() => {
              setSystemStatusOpen(false);
              void openDiagnostics();
            }}
            onOpenCompatibility={() => {
              setSystemStatusOpen(false);
              void openCompatibility();
            }}
            onClose={() => setSystemStatusOpen(false)}
          />
          <CredentialDialog
            upstream={credentialTarget}
            value={credentialValue}
            isSaving={credentialSaving}
            error={credentialError}
            onValueChange={setCredentialValue}
            onClose={() => {
              if (credentialSaving) return;
              setCredentialTarget(null);
              setCredentialValue('');
              setCredentialError('');
            }}
            onSubmit={saveCredentials}
          />
          <AlertDialog
            isOpen={Boolean(compatibilityResetTarget)}
            onOpenChange={(isOpen) => { if (!isOpen && !compatibilityActionLoading) setCompatibilityResetTarget(null); }}
            title={compatibilityResetTarget?.all ? 'Reset all compatibility facts?' : 'Reset compatibility fact?'}
            description={compatibilityResetTarget?.all
              ? 'Remove every learned compatibility fact. Requests will relearn allowlisted behavior from new evidence.'
              : `Remove the learned ${compatibilityResetTarget?.features?.join(', ') || 'compatibility'} behavior for future requests?`}
            actionLabel="Reset"
            actionVariant="destructive"
            isActionLoading={compatibilityActionLoading}
            onAction={resetCompatibility}
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
            title={refreshTarget?.all ? 'Refresh all upstream quotas?' : refreshTarget?.type === 'claude' ? 'Refresh Claude quota and profile?' : 'Refresh upstream quota?'}
            description={refreshTarget?.all ? 'Fetch live quota information from every provider in batches of 10. Each batch completes before the next starts.' : refreshTarget ? `Fetch live quota information from provider for "${refreshTarget.name}"?` : ''}
            actionLabel="Refresh"
            actionVariant="primary"
            isActionLoading={isRefreshing}
            onAction={confirmRefresh}
          />
          <AlertDialog
            isOpen={Boolean(refreshTokenTarget)}
            onOpenChange={(isOpen) => { if (!isOpen && !isRefreshingToken) setRefreshTokenTarget(null); }}
            title="Refresh OAuth token?"
            description={refreshTokenTarget ? `Obtain new access token for "${refreshTokenTarget.name}" using refresh token?${refreshTokenTarget.email ? `\nEmail: ${refreshTokenTarget.email}` : ''}${refreshTokenTarget.accessTokenExpiresAt ? `\nExpires: ${formatTokenExpiry(refreshTokenTarget.accessTokenExpiresAt)}` : ''}` : ''}
            actionLabel="Refresh Token"
            actionVariant="primary"
            isActionLoading={isRefreshingToken}
            onAction={confirmRefreshToken}
          />
          <AlertDialog
            isOpen={Boolean(cooldownTarget)}
            onOpenChange={(isOpen) => { if (!isOpen && !isClearingCooldown) setCooldownTarget(null); }}
            title="Clear upstream cooldown?"
            description={cooldownTarget ? `Allow "${cooldownTarget.name}" to receive traffic before its current cooldown ends?` : ''}
            actionLabel="Clear cooldown"
            actionVariant="primary"
            isActionLoading={isClearingCooldown}
            onAction={confirmClearCooldown}
          />
          <Dialog isOpen={formDialog.isOpen} onOpenChange={() => {
            setCurrentCredentials(null);
            setFormDialog((s) => ({ ...s, isOpen: false }));
          }} width={640} purpose="form">
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
                      <TextInput
                        label="Name"
                        value={formValues.name || ''}
                        onChange={(value) => updateForm('name', value)}
                        placeholder="Optional custom name"
                      />
                      <Selector
                        label="Type"
                        options={[{ value: 'codex', label: 'Codex' }, { value: 'compass', label: 'Compass' }, { value: 'claude', label: 'Claude Enterprise OAuth' }]}
                        value={formValues.type}
                        onChange={(value) => updateForm('type', value)}
                        isDisabled={formDialog.mode === 'edit'}
                        width="100%"
                      />
                      {formDialog.mode === 'add' && formValues.type === 'codex' ? (
                        <TextArea
                          label="Codex auth.json"
                          description="The account name is derived from the JWT email."
                          value={formValues.authJson || ''}
                          onChange={(value) => updateForm('authJson', value)}
                          placeholder="Paste auth.json here (tokens.access_token, refresh_token, id_token)"
                          rows={6}
                          htmlName="authJson"
                        />
                      ) : formValues.type === 'claude' ? (
                        <VStack gap={2}>
                          {formDialog.mode === 'add' ? (
                            <TextInput
                              label="Claude OAuth Token"
                              description="Enter OAuth token (e.g. sk-ant-oat...)"
                              value={formValues.accessToken || ''}
                              onChange={(value) => updateForm('accessToken', value)}
                              placeholder="sk-ant-oat..."
                              htmlName="accessToken"
                            />
                          ) : null}
                          <Text type="supporting" color="secondary">Claude Enterprise OAuth uses Claude Code-compatible shaping, profile lookup, and quota refresh.</Text>
                        </VStack>
                      ) : formValues.type === 'compass' ? (
                        <Grid columns={{ minWidth: 280, max: 2, repeat: 'fit' }} gap={3}>
                          <TextInput label="Project ID" value={formValues.projectId || ''} onChange={(value) => updateForm('projectId', value)} placeholder="e.g. prj_12345" />
                          {formDialog.mode === 'add' && <TextInput label="Project key" value={formValues.projectKey || ''} onChange={(value) => updateForm('projectKey', value)} placeholder="e.g. key_67890" />}
                          <Selector label="Quota source" options={[{ value: 'compass', label: 'Compass' }, { value: 'ais', label: 'AIS' }]} value={formValues.quotaSource || 'compass'} onChange={(value) => updateForm('quotaSource', value)} />
                          <GridSpan columns="full">
                            <Text type="supporting" color="secondary">The account name is derived from the project ID. AIS quota is managed outside this gateway.</Text>
                          </GridSpan>
                        </Grid>
                      ) : null}
                      <Switch
                        label="Request pacing"
                        description="Space outbound starts for this account."
                        value={Boolean(formValues.pacing?.enabled)}
                        onChange={(value) => updatePacing('enabled', value)}
                      />
                      {formValues.pacing?.enabled && (
                        <VStack gap={3}>
                          <Grid columns={{ minWidth: 180, max: 3, repeat: 'fit' }} gap={3}>
                            <NumberInput
                              label="Account interval"
                              description="Minimum milliseconds between starts."
                              value={formValues.pacing?.minStartIntervalMs ?? 0}
                              onChange={(value) => updatePacing('minStartIntervalMs', value ?? 0)}
                              min={0}
                              max={300000}
                              step={100}
                              isIntegerOnly
                            />
                            <NumberInput
                              label="Queue depth"
                              description="Maximum waiting requests."
                              value={formValues.pacing?.maxQueueDepth ?? 20}
                              onChange={(value) => updatePacing('maxQueueDepth', value ?? 20)}
                              min={1}
                              max={100}
                              step={1}
                              isIntegerOnly
                            />
                            <NumberInput
                              label="Queue age"
                              description="Maximum wait in milliseconds."
                              value={formValues.pacing?.maxQueueAgeMs ?? 30000}
                              onChange={(value) => updatePacing('maxQueueAgeMs', value ?? 30000)}
                              min={100}
                              max={600000}
                              step={100}
                              isIntegerOnly
                            />
                          </Grid>
                          <VStack gap={2}>
                            <HStack justify="between" vAlign="center">
                              <Text type="label" weight="bold">Model intervals</Text>
                              <Button
                                label="Add model interval"
                                variant="secondary"
                                size="sm"
                                onClick={() => updatePacing('modelIntervals', [
                                  ...(formValues.pacing?.modelIntervals || []),
                                  { model: '', minStartIntervalMs: 0 }
                                ])}
                              />
                            </HStack>
                            <ScrollList count={formValues.pacing?.modelIntervals?.length || 0}>
                              {(formValues.pacing?.modelIntervals || []).map((entry, index) => (
                                <Grid key={index} columns={{ minWidth: 220, max: 2, repeat: 'fit' }} gap={3} align="end">
                                  <TextInput
                                    label="Model"
                                    value={entry.model || ''}
                                    onChange={(value) => updateModelInterval(index, 'model', value)}
                                    placeholder="gpt-5.6-sol"
                                  />
                                  <HStack gap={2} align="end">
                                    <NumberInput
                                      width="100%"
                                      label="Minimum interval"
                                      value={entry.minStartIntervalMs ?? 0}
                                      onChange={(value) => updateModelInterval(index, 'minStartIntervalMs', value ?? 0)}
                                      min={0}
                                      max={300000}
                                      step={100}
                                      isIntegerOnly
                                    />
                                    <Field label={<VisuallyHidden>Remove</VisuallyHidden>}>
                                      <Button
                                        label="Remove model interval"
                                        tooltip="Remove model interval"
                                        variant="ghost"
                                        isIconOnly
                                        icon="×"
                                        onClick={() => updatePacing('modelIntervals', (formValues.pacing?.modelIntervals || []).filter((_, current) => current !== index))}
                                      />
                                    </Field>
                                  </HStack>
                                </Grid>
                              ))}
                            </ScrollList>
                          </VStack>
                        </VStack>
                      )}
                      {formDialog.mode === 'edit' && (
                        <VStack gap={2}>
                          <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
                            <Text type="label" weight="bold">Current credentials</Text>
                            <Button
                              label={currentCredentials ? 'Refresh credentials' : 'View credentials'}
                              size="sm"
                              variant="secondary"
                              isLoading={currentCredentialsLoading}
                              onClick={() => void revealCurrentCredentials()}
                            />
                          </HStack>
                          {currentCredentials && (
                            <TextArea
                              label="Current credential data"
                              value={currentCredentials}
                              rows={16}
                              isReadOnly
                              hasSpellCheck={false}
                            />
                          )}
                        </VStack>
                      )}
                    </VStack>
                  </form>
                </LayoutContent>
              )}
              footer={(
                <LayoutFooter hasDivider>
                  <HStack justify="end" gap={2}>
                    <Button label="Cancel" variant="secondary" onClick={() => {
                      setCurrentCredentials(null);
                      setFormDialog((s) => ({ ...s, isOpen: false }));
                    }} />
                    <Button label="Save" variant="primary" type="submit" form="upstream-form" />
                  </HStack>
                </LayoutFooter>
              )}
            />
          </Dialog>
        </VStack>
      </AppShell>
  );
}

function Metric({ label, value }) {
  return (
    <Card variant="muted" padding={2}>
      <VStack gap={1}>
        <Text type="supporting" color="secondary" maxLines={1}>{label}</Text>
        <Heading level={3} maxLines={1}>{value}</Heading>
      </VStack>
    </Card>
  );
}

function MetricSkeletons() {
  return (
    <Grid columns={METRIC_GRID_COLUMNS} gap={2}>
      {Array.from({ length: 8 }, (_, index) => (
        <Card key={index} variant="muted" padding={2}>
          <VStack gap={2}>
            <Skeleton width="70%" height={14} index={index} />
            <Skeleton width="45%" height={28} index={index + 1} />
          </VStack>
        </Card>
      ))}
    </Grid>
  );
}

function UpstreamSkeletons() {
  return (
    <Grid columns={UPSTREAM_GRID_COLUMNS} gap={2}>
      {Array.from({ length: 4 }, (_, index) => (
        <Card key={index} padding={3}>
          <VStack gap={2}>
            <Skeleton width="65%" height={24} index={index} />
            <Skeleton height={56} index={index + 1} />
            <Skeleton height={56} index={index + 2} />
            <HStack gap={2}>
              <Skeleton width={28} height={28} radius={1} index={index + 3} />
              <Skeleton width={28} height={28} radius={1} index={index + 4} />
              <Skeleton width={28} height={28} radius={1} index={index + 5} />
            </HStack>
          </VStack>
        </Card>
      ))}
    </Grid>
  );
}

function UpstreamCard({
  upstream,
  pacing,
  onRefresh,
  onTestConnection,
  isTestingConnection,
  onRefreshToken,
  isRefreshingToken,
  onClearCooldown,
  onEdit,
  onReplaceCredentials,
  onCap,
  onPriority,
  onDelete
}) {
  const quota = upstream.quota;
  const spending = upstream.spending || {};
  const quotaRemaining = quota ? Math.min(100, Math.max(0, quota.remainingPercent)) : 0;
  const spendingRemaining = spending.capCredits > 0 ? Math.min(100, Math.max(0, 100 - spending.percentUsed)) : 0;
  const compassWorkspaceId = upstream.type === 'compass' ? (upstream.metadata?.workspace_id ?? upstream.metadata?.workspaceId) : null;
  const compassUrl = compassWorkspaceId ? `https://smart.shopee.io/workspace-management?tab=quota&workspace_id=${compassWorkspaceId}` : null;
  const tokenExpiry = upstream.type === 'compass'
    ? (compassUrl ? <a href={compassUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-text-link, inherit)', textDecoration: 'underline' }}>More Info</a> : 'No expiry')
    : upstream.accessTokenExpiresAt ? formatTokenExpiry(upstream.accessTokenExpiresAt) : 'Expiry unknown';
  const expiresSoon = ['codex', 'claude'].includes(upstream.type) && upstream.accessTokenExpiresAt && new Date(upstream.accessTokenExpiresAt).getTime() - Date.now() < 12 * 60 * 60 * 1000;
  const capHeading = spending.capCredits > 0 ? `${formatPercent(spendingRemaining)} left` : 'No spending cap';
  const capUsage = spending.capCredits > 0
    ? `$${formatNumber(Math.max(0, (spending.capDollars || 0) - (spending.spentDollars || 0)))} left of $${formatNumber(spending.capDollars)} · ${spending.status}`
    : 'Set a cap to make this upstream routable';
  const recentActiveText = formatTimeAgo(getRecentActiveTs(upstream));
  const tokenRefresh = upstream.tokenRefresh;
  const coolingDown = hasActiveCooldown(upstream);
  const pacingEnabled = Boolean(upstream.pacing?.enabled);
  const queuedRequests = pacing?.queueDepth || 0;
  const quotaVariant = !quota || upstream.quotaSource === 'ais' ? 'neutral' : quotaRemaining <= 15 ? 'error' : quotaRemaining <= 30 ? 'warning' : 'success';
  const spendingVariant = spending.capCredits <= 0 ? 'neutral' : spendingRemaining <= 15 ? 'error' : spendingRemaining <= 30 ? 'warning' : 'success';
  const progressStyleMap = {
    success: { '--color-success': 'light-dark(#9fe59b, #0c5700)' },
    error: { '--color-background-muted': 'var(--color-background-red)' },
    warning: { '--color-background-muted': 'var(--color-background-yellow)' },
  };
  return (
    <Card height="100%" padding={3}>
      <VStack gap={2} height="100%" vAlign="between">
        <HStack justify="between" vAlign="center" gap={2} height={56}>
          <StackItem size="fill">
            <VStack gap={1}>
              <Heading level={3} maxLines={1}>{upstream.name}</Heading>
              <HStack gap={1} vAlign="center" minHeight={28} wrap="wrap">
                {expiresSoon ? <Badge label={tokenExpiry} variant="warning" /> : <Text type="supporting" color="secondary" maxLines={1}>{tokenExpiry}</Text>}
                {coolingDown && <Badge label={`Cooling down until ${formatShortTime(upstream.health.nextEligibleAt)}`} variant="warning" />}
                {pacingEnabled && <Badge label={queuedRequests ? `${queuedRequests} queued` : 'Pacing enabled'} variant={queuedRequests ? 'warning' : 'neutral'} />}
                {tokenRefresh?.status === 'failed' && <Badge label="Token refresh failed" variant="error" />}
                {isReauthRequired(upstream) && <Badge label="Reauth required" variant="error" />}
              </HStack>
            </VStack>
          </StackItem>
          <HStack gap={1} vAlign="center">
            {Number.isInteger(upstream.priority) && <Badge label={`${ordinal(upstream.priority + 1)} priority`} variant="blue" />}
            <Badge label={upstream.quotaSource === 'ais' ? 'ais' : upstream.type} variant={upstream.type === 'compass' ? 'teal' : upstream.type === 'claude' ? 'orange' : 'purple'} />
          </HStack>
        </HStack>
        <VStack gap={1} height={56}>
          <HStack justify="between" vAlign="center" gap={2} height={20}><Text type="label" weight="bold" maxLines={1}>{quota ? `${formatPercent(quota.remainingPercent)} left` : upstream.quotaSource === 'ais' ? 'ais' : upstream.type === 'claude' ? 'Quota unavailable' : 'Not refreshed'}</Text><Text type="supporting" color="secondary" maxLines={1}>{quota ? `reset ${formatDate(quota.resetAt)}` : upstream.quotaSource === 'ais' ? 'Quota managed by AIS' : upstream.type === 'claude' ? 'Click refresh to read Claude usage' : 'Click refresh to read provider quota'}</Text></HStack>
          <ProgressBar
            label="Quota remaining"
            value={!quota ? 0 : quotaRemaining}
            max={100}
            isLabelHidden
            variant={quotaVariant}
            style={progressStyleMap[quotaVariant]}
          />
          <Text type="supporting" color="secondary" minHeight={20} maxLines={1}>{quotaCount(quota, upstream.type)}</Text>
        </VStack>
        <VStack gap={1}>
          <Text type="label" weight="bold" maxLines={1}>{capHeading}</Text>
          <ProgressBar
            label="Spending cap remaining"
            value={spending.capCredits <= 0 ? 0 : spendingRemaining}
            max={100}
            isLabelHidden
            variant={spendingVariant}
            style={progressStyleMap[spendingVariant]}
          />
          <HStack justify="between" vAlign="center" gap={2}>
            <Text type="supporting" color="secondary" maxLines={1}>{capUsage}</Text>
            {recentActiveText && <Text type="supporting" color="secondary" maxLines={1}>{recentActiveText}</Text>}
          </HStack>
        </VStack>
        <HStack gap={1} vAlign="center" wrap="wrap">
          {(upstream.type !== 'claude' || upstream.metadata?.auth_kind !== 'claude_api_key') && (
            <Button
              label="Refresh quota"
              tooltip="Refresh quota"
              icon={<Icon icon="clock" size="sm" />}
              isIconOnly
              size="sm"
              variant="secondary"
              onClick={() => onRefresh(upstream)}
            />
          )}
          <Button
            label="Test connection"
            tooltip="Test connection"
            icon={<PlugZap size={16} />}
            isIconOnly
            size="sm"
            variant="secondary"
            isLoading={isTestingConnection}
            isDisabled={isTestingConnection}
            onClick={() => onTestConnection(upstream)}
          />
          {['codex', 'claude'].includes(upstream.type) && (
            <Button
              label="Refresh token"
              tooltip="Refresh token"
              icon={<Icon icon="arrowsUpDown" size="sm" />}
              isIconOnly
              size="sm"
              variant="secondary"
              isLoading={isRefreshingToken}
              isDisabled={isRefreshingToken || tokenRefresh?.status === 'refreshing'}
              onClick={() => onRefreshToken(upstream)}
            />
          )}
          {coolingDown && (
            <Button
              label="Clear cooldown"
              size="sm"
              variant="secondary"
              icon={<Icon icon="warning" size="sm" />}
              onClick={() => onClearCooldown(upstream)}
            />
          )}
          <MoreMenu
            label={`Actions for ${upstream.name}`}
            size="sm"
            variant="secondary"
            items={[
              {
                type: 'section',
                title: 'Manage',
                items: [
                  { label: 'Edit upstream', onClick: () => onEdit(upstream) },
                  { label: 'Replace credentials', onClick: () => onReplaceCredentials(upstream) },
                  { label: 'Set spending cap', onClick: () => onCap(upstream) },
                  { label: 'Set priority', onClick: onPriority }
                ]
              },
              { type: 'divider' },
              {
                type: 'section',
                title: 'Danger zone',
                items: [{ label: 'Delete upstream', onClick: () => onDelete(upstream) }]
              }
            ]}
          />
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

function CredentialDialog({ upstream, value, isSaving, error, onValueChange, onClose, onSubmit }) {
  return (
    <Dialog isOpen={Boolean(upstream)} onOpenChange={onClose} purpose="form" width={640}>
      <Layout
        header={<DialogHeader title="Replace credentials" subtitle={upstream ? `For ${upstream.name}` : undefined} onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            <form id="credential-form" onSubmit={onSubmit}>
              <VStack gap={3}>
                <Banner
                  title="Credential replacement"
                  description="Saving replaces the stored authentication material for this upstream."
                  status="warning"
                />
                {error && <Banner title="Could not replace credentials" description={error} status="error" />}
                {upstream?.type === 'codex' ? (
                  <TextArea
                    label="Codex auth.json"
                    value={value}
                    onChange={onValueChange}
                    placeholder="Paste auth.json here"
                    rows={6}
                    htmlName="authJson"
                  />
                ) : upstream?.type === 'claude' ? (
                  <TextInput
                    label="Claude OAuth Token"
                    value={value}
                    onChange={onValueChange}
                    placeholder="Enter replacement OAuth token (sk-ant-oat...)"
                    htmlName="accessToken"
                  />
                ) : (
                  <TextInput
                    label="Project key"
                    value={value}
                    onChange={onValueChange}
                    placeholder="Enter the replacement project key"
                  />
                )}
              </VStack>
            </form>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter hasDivider>
            <HStack justify="end" gap={2}>
              <Button label="Cancel" variant="secondary" isDisabled={isSaving} onClick={onClose} />
              <Button
                label="Replace credentials"
                variant="primary"
                type="submit"
                form="credential-form"
                isLoading={isSaving}
                isDisabled={!value.trim()}
              />
            </HStack>
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function BulkCapDialog({ open, mode, capValue, rules, unknownValue, onModeChange, onCapValueChange, onRulesChange, onUnknownValueChange, onClose, onSubmit }) {
  const updateRule = (index, field, value) => onRulesChange(rules.map((rule, current) => current === index ? { ...rule, [field]: value } : rule));
  return (
    <Dialog isOpen={open} onOpenChange={onClose} purpose="form" width={560}>
      <Layout
        header={<DialogHeader title="Set spending caps" subtitle="Apply a cap strategy to multiple upstreams." onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            <form id="bulk-cap-form" onSubmit={onSubmit}>
              <VStack gap={4}>
                <Text type="supporting" color="secondary">Quota rules use monthly quota left in USD. The original server preset is pre-filled. AIS upstreams are excluded.</Text>
                <Selector
                  label="Strategy"
                  options={[{ value: 'rules', label: 'Original quota presets' }, { value: 'all', label: 'Set one cap for all upstreams' }, { value: 'cap_reached', label: 'Replace caps already reached' }, { value: 'uncapped', label: 'Set caps on uncapped upstreams' }]}
                  value={mode}
                  onChange={onModeChange}
                />
                {mode === 'rules' ? (
                  <VStack gap={2}>
                    <ScrollList count={rules.length}>
                      {rules.map((rule, index) => (
                        <Grid key={index} gap={4} columns={{ minWidth: 180, max: 2, repeat: 'fit' }} align="end">
                          <NumberInput label="Monthly quota left" value={rule.minQuotaLeft} onChange={(value) => updateRule(index, 'minQuotaLeft', value)} min={0} step={0.01} hasClear />
                          <HStack align="end" gap={4}>
                            <NumberInput width="100%" label="Spend cap" value={rule.capDollars} onChange={(value) => updateRule(index, 'capDollars', value)} min={0} step={0.01} hasClear />
                            <Field label={<VisuallyHidden>Remove</VisuallyHidden>}>
                              <Button label="Remove rule" tooltip="Remove rule" size="md" variant="ghost" isIconOnly icon="×" onClick={() => onRulesChange(rules.filter((_, current) => current !== index))} />
                            </Field>
                          </HStack>
                        </Grid>
                      ))}
                    </ScrollList>
                    <Button label="Add rule" variant="secondary" onClick={() => onRulesChange([...rules, { minQuotaLeft: null, capDollars: null }])} />
                    <NumberInput
                      label="Unknown quota cap (USD)"
                      description="Applied to upstreams whose remaining quota is unknown, such as Claude accounts without extra-usage data. Leave empty to skip them."
                      value={unknownValue}
                      onChange={onUnknownValueChange}
                      min={0}
                      step={0.01}
                      hasClear
                    />
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

function matchesSearch(values, query) {
  return values.some((value) => {
    const text = String(value || '').toLowerCase();
    if (text.includes(query)) return true;
    let index = 0;
    for (const character of text) if (character === query[index]) index += 1;
    return index === query.length;
  });
}

function getQuotaBand(upstream) {
  const remaining = upstream.quota ? upstream.quota.remainingPercent : null;
  if (remaining == null || !Number.isFinite(remaining)) return 'unknown';
  if (remaining <= 0) return 'exhausted';
  if (remaining < 30) return 'low';
  if (remaining < 70) return 'moderate';
  return 'plenty';
}

function hasActiveCooldown(upstream) {
  const health = upstream?.health;
  if (health?.status !== 'cooldown') return false;
  const nextEligibleAt = Date.parse(health.nextEligibleAt);
  return !Number.isFinite(nextEligibleAt) || nextEligibleAt > Date.now();
}

function isReauthRequired(upstream) {
  return upstream?.tokenRefresh?.status === 'reauth_required' || upstream?.health?.status === 'reauth_required';
}

function isUpstreamActive(upstream) {
  return upstream?.eligibility === 'normal'
    && !['failed', 'reauth_required'].includes(upstream.tokenRefresh?.status)
    && !isReauthRequired(upstream)
    && !hasActiveCooldown(upstream);
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
function capSummary(spending) {
  const cap = Number(spending?.capDollars) || 0;
  return cap > 0 && `$${formatNumber(Math.max(0, cap - (Number(spending?.spentDollars) || 0)))} left of $${formatNumber(cap)} cap`;
}
function ordinal(value) {
  const n = Math.trunc(Number(value) || 0);
  return `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}
function formatPercent(value) { return `${Math.round(Number(value) || 0)}%`; }
function connectionSuccessMessage(connection) {
  const answer = typeof connection?.answer === 'string' && connection.answer.trim() ? ` with answer '${connection.answer.trim()}'` : '';
  return `Connected through ${connection.endpoint} with ${connection.model} in ${connection.latencyMs} ms${answer}`;
}
function quotaCount(quota, upstreamType = '') {
  const windows = Array.isArray(quota?.windows) && quota.windows.length
    ? quota.windows
      .slice(0, 4)
      .map((window) => `${window.key === 'session' ? '5h' : window.key === '7d' ? '7d' : window.key.replace(/^7d_/, '')} ${formatPercent(window.remainingPercent)} left`)
      .join(' · ')
    : '';
  const dollars = quota && Number.isFinite(quota.remainingDollars) && Number.isFinite(quota.limitDollars)
    ? `$${formatNumber(Math.max(0, quota.remainingDollars))} left of $${formatNumber(quota.limitDollars)}`
    : '';
  const dollarStatus = upstreamType === 'claude' && !dollars ? 'USD unavailable from provider' : '';
  return [dollars, windows, dollarStatus].filter(Boolean).join(' · ');
}
function formatDate(value) { return value ? new Date(value).toLocaleString() : 'unknown'; }
function formatShortTime(value) {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? 'later' : timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
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

function SortableRow({ upstream, index, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: upstream.id });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1, cursor: 'grab', touchAction: 'none' }}>
      <Card>
        <HStack gap={2} vAlign="center" justify="between">
          <HStack gap={2} vAlign="center">
            <Text type="label" color="secondary" maxLines={1}>⠿</Text>
            <Badge label={ordinal(index + 1)} variant="purple" />
            <VStack>
              <Text type="label" weight="bold" maxLines={1}>{upstream.name}</Text>
              <Text type="supporting" color="secondary" maxLines={1}>{upstream.type} · {capSummary(upstream.spending) || 'no cap'}</Text>
            </VStack>
          </HStack>
          <Button label="Remove" size="sm" variant="ghost" onClick={() => onRemove(upstream.id)} />
        </HStack>
      </Card>
    </div>
  );
}

function PriorityDialog({ isOpen, upstreams, onClose, onSave }) {
  const [ids, setIds] = useState([]);
  const [pending, setPending] = useState('');
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  useEffect(() => {
    if (!isOpen) return;
    setIds(upstreams.filter((upstream) => Number.isInteger(upstream.priority)).sort((a, b) => a.priority - b.priority).map((upstream) => upstream.id));
    setPending('');
  }, [isOpen]);

  const listed = ids.map((id) => upstreams.find((upstream) => upstream.id === id)).filter(Boolean);
  const available = upstreams.filter((upstream) => !ids.includes(upstream.id));

  const onDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    setIds((current) => arrayMove(current, current.indexOf(active.id), current.indexOf(over.id)));
  };

  const submit = (event) => {
    event.preventDefault();
    onSave(ids);
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onClose} purpose="form" width={560}>
      <Layout
        header={<DialogHeader title="Upstream priority list" subtitle="Listed upstreams are used first, in order. Others are used only once every listed upstream reaches its spending cap." onOpenChange={onClose} hasDivider />}
        footer={(
          <LayoutFooter hasDivider>
            <HStack justify="between" gap={2} wrap="wrap">
              <Button label="Clear list" variant="secondary" isDisabled={!ids.length} onClick={() => setIds([])} />
              <HStack gap={2}>
                <Button label="Cancel" variant="secondary" onClick={onClose} />
                <Button label="Save priority" variant="primary" type="submit" form="priority-form" />
              </HStack>
            </HStack>
          </LayoutFooter>
        )}
      >
        <LayoutContent>
          <form id="priority-form" onSubmit={submit}>
            <VStack gap={3}>
              <HStack gap={2} vAlign="end" wrap="wrap" width="100%">
                <StackItem size="fill">
                  <Selector
                    label="Add upstream to the priority list"
                    width="100%"
                    hasSearch
                    searchPlaceholder="Search name or email..."
                    value={pending}
                    options={[{ value: '', label: available.length ? 'Select an upstream' : 'All upstreams are listed' }, ...available.map((upstream) => ({ value: upstream.id, label: `${upstream.name} (${upstream.email || upstream.type})` }))]}
                    onChange={setPending}
                  />
                </StackItem>
                <Button label="Add" variant="secondary" isDisabled={!pending} onClick={() => { setIds((current) => [...current, pending]); setPending(''); }} />
              </HStack>
              {listed.length ? (
                <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToParentElement]} onDragEnd={onDragEnd}>
                  <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                    <ScrollList count={listed.length}>
                      {listed.map((upstream, index) => (
                        <SortableRow key={upstream.id} upstream={upstream} index={index} onRemove={(id) => setIds((current) => current.filter((item) => item !== id))} />
                      ))}
                    </ScrollList>
                  </SortableContext>
                </DndContext>
              ) : (
                <EmptyState title="Priority list is empty" description="Every upstream is balanced by least recent success. Add an upstream above to make it preferred." />
              )}
            </VStack>
          </form>
        </LayoutContent>
      </Layout>
    </Dialog>
  );
}

function RoutingDialog({ isOpen, policy, api, onClose, onSave }) {
  const [strategy, setStrategy] = useState('least-recent-success');
  const [preferredType, setPreferredType] = useState('codex');
  const [model, setModel] = useState('');
  const [diagnostics, setDiagnostics] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setStrategy(policy.strategy);
    setDiagnostics(null);
    setError('');
  }, [isOpen, policy.strategy]);

  const dryRun = async () => {
    setIsRunning(true);
    setError('');
    try {
      const data = await api('/api/routing/dry-run', {
        method: 'POST',
        body: JSON.stringify({ strategy, preferredType, model: model.trim() })
      });
      setDiagnostics(data.routing);
    } catch (runError) {
      setError(runError.message);
    } finally {
      setIsRunning(false);
    }
  };

  const submit = (event) => {
    event.preventDefault();
    onSave(strategy);
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onClose} purpose="form" width={640}>
      <Layout
        header={<DialogHeader title="Routing strategy" subtitle="Policy and dry-run diagnostics" onOpenChange={onClose} hasDivider />}
        footer={(
          <LayoutFooter hasDivider>
            <HStack justify="end" gap={2}>
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button label="Save routing" variant="primary" type="submit" form="routing-form" />
            </HStack>
          </LayoutFooter>
        )}
      >
        <LayoutContent>
          <form id="routing-form" onSubmit={submit}>
            <VStack gap={4}>
              <StackItem size="static" crossAlignSelf="start">
                <SegmentedControl label="Strategy" value={strategy} layout="hug" onChange={setStrategy}>
                  <SegmentedControlItem value="least-recent-success" label="Least recent success" />
                  <SegmentedControlItem value="most-remaining-quota" label="Most remaining quota" />
                </SegmentedControl>
              </StackItem>
              <HStack gap={2} vAlign="end" wrap="wrap">
                <StackItem size="fill">
                  <Selector
                    label="Preferred provider"
                    value={preferredType}
                    options={[
                      { value: 'codex', label: 'Codex' },
                      { value: 'compass', label: 'Compass' },
                      { value: 'claude', label: 'Claude Enterprise OAuth' }
                    ]}
                    onChange={setPreferredType}
                  />
                </StackItem>
                <StackItem size="fill">
                  <TextInput label="Model" value={model} onChange={setModel} placeholder="Optional model ID" />
                </StackItem>
                <Button label="Dry run" variant="secondary" isLoading={isRunning} onClick={dryRun} />
              </HStack>
              {error && <Banner title="Dry run failed" description={error} status="error" />}
              {diagnostics && (
                <VStack gap={3}>
                  <HStack justify="between" vAlign="center">
                    <Heading level={3}>Candidate order</Heading>
                    <Badge label={`${diagnostics.candidateCount} eligible`} variant="blue" />
                  </HStack>
                  {diagnostics.candidates.length ? (
                    <ScrollList count={diagnostics.candidates.length}>
                      {diagnostics.candidates.map((candidate) => (
                        <Card key={candidate.id}>
                          <HStack justify="between" gap={2} vAlign="center">
                            <VStack gap={1}>
                              <Text type="label" weight="bold" maxLines={1}>{candidate.order}. {candidate.name}</Text>
                              <Text type="supporting" color="secondary" maxLines={1}>{candidate.type} · {candidate.priorityTier === 'unlisted' ? 'unlisted' : `priority ${candidate.priorityTier + 1}`}</Text>
                            </VStack>
                            <Badge
                              label={candidate.quota.status === 'known' ? `${formatNumber(candidate.quota.remainingPercent)}%` : candidate.quota.status}
                              variant={candidate.quota.status === 'known' ? 'green' : 'neutral'}
                            />
                          </HStack>
                        </Card>
                      ))}
                    </ScrollList>
                  ) : <EmptyState title="No eligible upstreams" description="The current routing context excludes every upstream." />}
                  {diagnostics.exclusions.length > 0 && (
                    <VStack gap={2}>
                      <Heading level={3}>Excluded</Heading>
                      <ScrollList count={diagnostics.exclusions.length} height={240}>
                        {diagnostics.exclusions.map((candidate) => (
                          <HStack key={candidate.id} justify="between" gap={2}>
                            <Text type="supporting">{candidate.name}</Text>
                            <Badge label={candidate.code} variant="neutral" />
                          </HStack>
                        ))}
                      </ScrollList>
                    </VStack>
                  )}
                </VStack>
              )}
            </VStack>
          </form>
        </LayoutContent>
      </Layout>
    </Dialog>
  );
}

function SystemStatusDialog({
  isOpen,
  status,
  summary,
  isLoading,
  error,
  onRefresh,
  onOpenDiagnostics,
  onOpenCompatibility,
  onClose
}) {
  const readiness = status?.diagnostics?.readiness;
  const gateway = status?.diagnostics?.gateway;
  const catalog = status?.catalog;
  const hostHealth = status?.hostHealth;
  const pacingRows = status?.pacing || [];
  const compatibility = status?.compatibility;
  const queueDepth = pacingRows.reduce((total, entry) => total + (entry.queueDepth || 0), 0);
  const checks = readiness?.checks ? Object.entries(readiness.checks) : [];
  const readinessState = readinessDisplayState(readiness);
  return (
    <Dialog isOpen={isOpen} onOpenChange={onClose} width={820}>
      <Layout
        header={<DialogHeader title="System status" subtitle="Gateway readiness, compatibility, discovery, and local pacing" onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            <VStack gap={4}>
              {error && <Banner title="System status unavailable" description={error} status="error" />}
              {isLoading && !status ? (
                <VStack gap={3}>
                  <Skeleton height={72} />
                  <Grid columns={{ minWidth: 180, max: 3, repeat: 'fit' }} gap={2}>
                    <Skeleton height={88} />
                    <Skeleton height={88} />
                    <Skeleton height={88} />
                  </Grid>
                </VStack>
              ) : (
                <>
                  <Banner
                    title={summary.warningCount ? `${summary.warningCount} item${summary.warningCount === 1 ? ' needs' : 's need'} attention` : 'All monitored systems are ready'}
                    description={summary.message}
                    status={summary.warningCount ? 'warning' : 'success'}
                  />
                  <Grid columns={{ minWidth: 160, max: 3, repeat: 'fill' }} gap={2}>
                    <StatusMetric label="Readiness" value={readinessStatusLabel(readinessState)} variant={diagnosticVariant(readinessState)} />
                    <StatusMetric label="Model catalog" value={catalog ? `${catalog.modelCount} models` : 'unknown'} variant={catalogVariant(catalog)} />
                    <StatusMetric label="Codex host circuit" value={hostHealth?.openOriginCount ? `${hostHealth.openOriginCount} open` : 'closed'} variant={hostHealth?.openOriginCount ? 'warning' : 'success'} />
                    <StatusMetric label="Pacing queue" value={queueDepth ? `${queueDepth} queued` : 'clear'} variant={queueDepth ? 'warning' : 'success'} />
                  </Grid>

                  <Card variant="muted">
                    <Collapsible trigger="Readiness checks" defaultIsOpen>
                      <Grid columns={{ minWidth: 170, max: 3, repeat: 'fit' }} gap={2}>
                        {checks.map(([name, checkStatus]) => (
                          <ReadinessCheck key={name} name={name} status={checkStatus} />
                        ))}
                      </Grid>
                    </Collapsible>
                  </Card>

                  <Card variant="muted">
                    <Collapsible trigger="Operational details" defaultIsOpen={false}>
                      <Grid columns={{ minWidth: 190, max: 3, repeat: 'fit' }} gap={3}>
                        <VStack gap={1}>
                          <Text type="label" weight="bold" maxLines={1}>Gateway</Text>
                          <Text type="supporting" color="secondary" maxLines={1}>{gateway?.runtime?.activeAttemptCount ?? 0} active attempts</Text>
                          <Text type="supporting" color="secondary" maxLines={1}>{gateway?.retainedFailureCount ?? 0} retained failures</Text>
                        </VStack>
                        <VStack gap={1}>
                          <Text type="label" weight="bold" maxLines={1}>Model discovery</Text>
                          <Text type="supporting" color="secondary" maxLines={1}>{catalog?.source || 'unknown'} source, {catalog?.freshness || 'unknown'} freshness</Text>
                          <Text type="supporting" color="secondary" maxLines={1}>{catalog?.freshAccountCount ?? 0}/{catalog?.accountCount ?? 0} account catalogs fresh</Text>
                        </VStack>
                        <VStack gap={1}>
                          <Text type="label" weight="bold" maxLines={1}>Compatibility</Text>
                          <Text type="supporting" color="secondary" maxLines={1}>{compatibility?.counts?.active ?? 0} learned rules</Text>
                          <Text type="supporting" color="secondary" maxLines={1}>{compatibility?.counts?.observations ?? 0} pending evidence records</Text>
                        </VStack>
                      </Grid>
                    </Collapsible>
                  </Card>
                </>
              )}
            </VStack>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter hasDivider>
            <HStack justify="between" gap={2} wrap="wrap">
              <HStack gap={2} wrap="wrap">
                <Button label="Diagnostics" variant="secondary" onClick={onOpenDiagnostics} />
                <Button label="Compatibility" variant="secondary" onClick={onOpenCompatibility} />
              </HStack>
              <HStack gap={2}>
                <Button label="Close" variant="secondary" onClick={onClose} />
                <Button label="Refresh" variant="primary" isLoading={isLoading} onClick={() => void onRefresh()} />
              </HStack>
            </HStack>
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function StatusMetric({ label, value, variant }) {
  return (
    <Card variant="muted" padding={2}>
      <VStack gap={2}>
        <Text type="supporting" color="secondary" maxLines={1}>{label}</Text>
        <HStack justify="between" vAlign="center" gap={2}>
          <Text type="label" weight="bold" maxLines={1}>{value}</Text>
          <Badge label={variant === 'success' ? 'OK' : variant === 'warning' ? 'Check' : 'Unknown'} variant={variant} />
        </HStack>
      </VStack>
    </Card>
  );
}

function DiagnosticsDialog({ isOpen, diagnostics, isLoading, error, onRefresh, onClose }) {
  const readiness = diagnostics?.readiness;
  const gateway = diagnostics?.gateway;
  const checks = readiness?.checks ? Object.entries(readiness.checks) : [];
  return (
    <Dialog isOpen={isOpen} onOpenChange={onClose} width={760}>
      <Layout
        header={<DialogHeader title="Diagnostics" subtitle="Sanitized readiness and gateway failure history" onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            <VStack gap={4}>
              {error && <Banner title="Diagnostics unavailable" description={error} status="error" />}
              <VStack gap={2}>
                <HStack justify="between" vAlign="center">
                  <Heading level={3}>Readiness</Heading>
                  <Badge label={readinessStatusLabel(readiness?.status || 'pending')} variant={diagnosticVariant(readiness?.status)} />
                </HStack>
                <Grid columns={{ minWidth: 180, max: 3, repeat: 'fill' }} gap={2}>
                  {checks.map(([name, status]) => (
                    <Card key={name} variant="muted" padding={2}>
                      <ReadinessCheck name={name} status={status} />
                    </Card>
                  ))}
                </Grid>
              </VStack>

              <VStack gap={2}>
                <Heading level={3}>Gateway</Heading>
                <Grid columns={{ minWidth: 180, max: 3, repeat: 'fill' }} gap={2}>
                  <Metric label="Active attempts" value={gateway?.runtime?.activeAttemptCount ?? 0} />
                  <Metric label="Retained failures" value={`${gateway?.retainedFailureCount ?? 0}/${gateway?.retentionLimit ?? 100}`} />
                  <Metric label="Recent successes" value={gateway?.runtime?.recentSuccesses?.length ?? 0} />
                </Grid>
              </VStack>

              <VStack gap={2}>
                <Heading level={3}>Terminal failures</Heading>
                {gateway?.failures?.length ? (
                  <ScrollList count={gateway.failures.length}>
                    {gateway.failures.map((failure, index) => (
                      <Card key={`${failure.completedAt}-${index}`} padding={3}>
                        <VStack gap={2}>
                          <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
                            <Text weight="bold" maxLines={1}>{failure.endpoint || 'Gateway request'}</Text>
                            <HStack gap={1} vAlign="center">
                              {failure.responseStatusCode && <Badge label={`Upstream ${failure.responseStatusCode}`} variant="error" />}
                              <Badge label={failure.errorCode || 'failed'} variant="error" />
                            </HStack>
                          </HStack>
                          <Text type="supporting" color="secondary" maxLines={1}>
                            {failure.transport || 'unknown transport'} · {formatDiagnosticTime(failure.completedAt)} · {formatFailovers(failure)}
                          </Text>
                          {failure.exclusionReasons?.length > 0 && (
                            <Text type="supporting" maxLines={1}>Reasons: {failure.exclusionReasons.join(', ')}</Text>
                          )}
                          {failure.attempts?.map((attempt) => (
                            <Text key={attempt.attemptNumber} type="supporting" color="secondary" maxLines={1}>
                              Attempt {attempt.attemptNumber}: {attempt.errorCode || attempt.status} · {formatTimings(attempt.timings)}
                            </Text>
                          ))}
                          {failure.omittedAttemptCount > 0 && (
                            <Text type="supporting" color="secondary" maxLines={1}>
                              Showing the latest {failure.attempts.length} of {failure.attemptCount} attempts
                            </Text>
                          )}
                        </VStack>
                      </Card>
                    ))}
                  </ScrollList>
                ) : (
                  <EmptyState title="No terminal failures" description="The retained diagnostic window is clear." />
                )}
              </VStack>
            </VStack>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter hasDivider>
            <HStack justify="end" gap={2}>
              <Button label="Close" variant="secondary" onClick={onClose} />
              <Button label="Refresh" variant="primary" isLoading={isLoading} onClick={() => void onRefresh()} />
            </HStack>
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function CompatibilityDialog({ isOpen, compatibility, isLoading, error, onResetFact, onResetAll, onRefresh, onClose }) {
  const facts = compatibility?.facts || [];
  return (
    <Dialog isOpen={isOpen} onOpenChange={onClose} width={820}>
      <Layout
        header={<DialogHeader title="Compatibility" subtitle="Protocol fingerprints and bounded learned behavior" onOpenChange={onClose} hasDivider />}
        content={(
          <LayoutContent>
            <VStack gap={4}>
              {error && <Banner title="Compatibility status unavailable" description={error} status="error" />}
              <Grid columns={{ minWidth: 180, max: 3, repeat: 'fill' }} gap={2}>
                <Metric label="Learned compatibility rules" value={compatibility?.counts?.active ?? 0} />
                <Metric label="Stale" value={compatibility?.counts?.stale ?? 0} />
                <Metric label="Pending evidence" value={compatibility?.counts?.observations ?? 0} />
              </Grid>

              <VStack gap={2}>
                <HStack justify="between" vAlign="center">
                  <Heading level={3}>Passive learning</Heading>
                  <Badge
                    label={compatibility?.passiveEnabled ? 'enabled' : 'disabled'}
                    variant={compatibility?.passiveEnabled ? 'success' : 'neutral'}
                  />
                </HStack>
              </VStack>

              <Card variant="muted">
                <Collapsible trigger="Protocol fingerprint details" defaultIsOpen={false}>
                  <Grid columns={{ minWidth: 260, max: 2, repeat: 'fit' }} gap={2}>
                    {Object.entries(compatibility?.fingerprints || {}).map(([provider, fingerprint]) => (
                      <VStack key={provider} gap={1}>
                        <HStack justify="between" vAlign="center">
                          <Text type="label" weight="bold" maxLines={1}>{provider}</Text>
                          <Badge label={`v${fingerprint.version}`} variant="neutral" />
                        </HStack>
                        <Text type="supporting" color="secondary" maxLines={1}>{fingerprint.hash}</Text>
                      </VStack>
                    ))}
                  </Grid>
                </Collapsible>
              </Card>

              <CompatibilityFactList title="Learned compatibility rules" facts={facts} onResetFact={onResetFact} />
            </VStack>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter hasDivider>
            <HStack justify="between" gap={2} wrap="wrap">
              <Button label="Reset all" variant="destructive" isDisabled={!facts.length} onClick={onResetAll} />
              <HStack justify="end" gap={2}>
                <Button label="Close" variant="secondary" onClick={onClose} />
                <Button label="Refresh" variant="primary" isLoading={isLoading} onClick={() => void onRefresh()} />
              </HStack>
            </HStack>
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function CompatibilityFactList({ title, facts, onResetFact }) {
  return (
    <VStack gap={2}>
      <HStack justify="between" vAlign="center">
        <Heading level={3}>{title}</Heading>
        <Badge label={String(facts.length)} variant="neutral" />
      </HStack>
      {facts.length ? (
        <ScrollList count={facts.length}>
          {facts.map((fact) => (
            <Card key={fact.id} padding={3}>
              <HStack justify="between" vAlign="center" gap={3} wrap="wrap">
                <VStack gap={1}>
                  <HStack gap={1} vAlign="center" wrap="wrap">
                    <Text weight="bold" maxLines={1}>{fact.features.join(', ')}</Text>
                    <Badge label={fact.provider} variant={fact.provider === 'codex' ? 'purple' : 'teal'} />
                    <Badge label={fact.route} variant="neutral" />
                  </HStack>
                  <Text type="supporting" color="secondary" maxLines={1}>
                    {fact.evidenceCount} observations · expires {formatDiagnosticTime(fact.expiresAt)}
                  </Text>
                </VStack>
                <Button label="Reset fact" variant="destructive" size="sm" onClick={() => onResetFact(fact)} />
              </HStack>
            </Card>
          ))}
        </ScrollList>
      ) : <EmptyState title={`No ${title.toLowerCase()}`} description="No learned records are present in this category." />}
    </VStack>
  );
}

function ScrollList({ children, count, height = 320 }) {
  const bounded = count > 5;
  return (
    <VStack gap={2} height={bounded ? height : undefined} isScrollable={bounded} paddingInline={bounded ? 1 : undefined}>
      {children}
    </VStack>
  );
}

function ReadinessCheck({ name, status }) {
  const description = readinessDescription(name, status);
  return (
    <VStack gap={1}>
      <HStack justify="between" vAlign="center" gap={2}>
        <Text type="supporting" maxLines={1}>{readinessLabel(name)}</Text>
        <Badge label={readinessStatusLabel(status)} variant={diagnosticVariant(status)} />
      </HStack>
      {description && <Text type="supporting" color="secondary" maxLines={1}>{description}</Text>}
    </VStack>
  );
}

function diagnosticVariant(status) {
  if (status === 'ready') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'pending' || status === 'degraded') return 'warning';
  return 'neutral';
}

function catalogVariant(catalog) {
  if (!catalog) return 'neutral';
  if (catalog.freshness === 'stale' || catalog.lastFailureAt && !catalog.lastSuccessAt) return 'warning';
  return 'success';
}

function readinessDisplayState(readiness) {
  const states = Object.values(readiness?.checks || {});
  if (states.includes('failed')) return 'failed';
  if (states.includes('pending')) return 'pending';
  if (states.includes('degraded')) return 'degraded';
  return readiness?.status || 'unknown';
}

function summarizeSystemStatus(status, upstreams, error = '') {
  if (!status) {
    return error
      ? { warningCount: 1, message: 'System status could not be loaded.' }
      : { warningCount: 0, message: 'Open system status for current gateway health.' };
  }
  const warnings = [];
  if (error) warnings.push('status refresh');
  if (readinessDisplayState(status.diagnostics?.readiness) !== 'ready') warnings.push('gateway readiness');
  if (status.hostHealth?.openOriginCount > 0) warnings.push('Codex host circuit');
  if (status.catalog?.freshness === 'stale') warnings.push('model catalog');
  if ((status.pacing || []).some((entry) => entry.queueDepth > 0)) warnings.push('pacing queue');
  if (upstreams.some(hasActiveCooldown)) warnings.push('upstream cooldowns');
  const retainedFailures = status.diagnostics?.gateway?.retainedFailureCount || 0;
  if (retainedFailures > 0) warnings.push('recent gateway failures');
  return {
    warningCount: warnings.length,
    message: warnings.length ? `Review ${warnings.join(', ')}.` : 'Readiness, discovery, host health, compatibility, and pacing are clear.'
  };
}

function readinessLabel(name) {
  return {
    storage: 'Storage',
    apiKey: 'API key',
    tokenRecovery: 'Token recovery',
    quotaRefresh: 'Quota refresh',
    modelCatalog: 'Model catalog'
  }[name] || name;
}

function readinessStatusLabel(status) {
  return {
    ready: 'Ready',
    degraded: 'Fallback active',
    pending: 'Starting',
    failed: 'Failed'
  }[status] || 'Unknown';
}

function readinessDescription(name, status) {
  if (status !== 'degraded') return '';
  return {
    tokenRecovery: 'Some credentials could not be refreshed. Other upstreams remain available.',
    quotaRefresh: 'One or more quota reads failed. Scheduled refreshes will keep retrying.',
    modelCatalog: 'Live discovery is unavailable or incomplete. Static or last-known models remain available.'
  }[name] || 'The gateway is available with reduced supporting data.';
}

function formatDiagnosticTime(value) {
  if (!value) return 'unknown time';
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? 'unknown time' : timestamp.toLocaleString();
}

function formatTimings(timings = {}) {
  const labels = {
    queueWaitMs: 'queue',
    credentialPreparationMs: 'credentials',
    connectionMs: 'connect',
    firstResponseHeaderMs: 'headers',
    firstSseEventMs: 'first event',
    terminalCompletionMs: 'terminal'
  };
  const values = Object.entries(labels).flatMap(([name, label]) => (
    Number.isFinite(timings[name]) ? [`${label} ${timings[name]}ms`] : []
  ));
  return values.length ? values.join(', ') : 'timing unavailable';
}

function formatFailovers(failure = {}) {
  const count = Number(failure.retryCount) || 0;
  return `${count} candidate failover${count === 1 ? '' : 's'}`;
}

function App() {
  const [themeMode, setThemeMode] = useStoredValue('codex_theme_mode', 'dark');
  return (
    <Theme theme={relayTheme} mode={themeMode}>
      <ToastViewport position="bottomEnd" maxVisible={3} isTopLayer>
        <Dashboard themeMode={themeMode} setThemeMode={setThemeMode} />
      </ToastViewport>
    </Theme>
  );
}

function raiseToastViewport() {
  const promote = () => {
    const viewport = document.querySelector('[popover="manual"][role="region"]');
    if (!viewport || typeof viewport.showPopover !== 'function') return;
    try { viewport.hidePopover?.(); } catch {}
    try { viewport.showPopover(); } catch {}
  };
  requestAnimationFrame(() => requestAnimationFrame(promote));
}

createRoot(document.getElementById('root')).render(<App />);

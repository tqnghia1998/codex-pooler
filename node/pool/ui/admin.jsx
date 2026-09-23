import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Grid } from '@astryxdesign/core/Grid';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Overlay } from '@astryxdesign/core/Overlay';
import { Spinner } from '@astryxdesign/core/Spinner';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { Heading, Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { ArrowLeft, ChartNoAxesCombined, Download, RefreshCw, Search, Upload } from 'lucide-react';
import { useLanguage } from './i18n.jsx';

export function AdminAnalytics({ languageToggle }) {
  const { t, language } = useLanguage();
  const [analytics, setAnalytics] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [events, setEvents] = useState({ items: [], nextCursor: null });
  const [eventSearch, setEventSearch] = useState('');
  const [eventQuery, setEventQuery] = useState('');
  const [eventDays, setEventDays] = useState('0');
  const [usageDays, setUsageDays] = useState('7');
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 640px)').matches);
  const requestVersion = useRef(0);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)');
    const update = () => setCompact(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const load = useCallback(async ({ eventCursor = null, appendEvents = false } = {}) => {
    const version = ++requestVersion.current;
    setRefreshing(true);
    try {
      const params = new URLSearchParams();
      if (eventCursor) params.set('eventCursor', eventCursor);
      if (eventQuery) params.set('q', eventQuery);
      if (eventDays !== '0') params.set('days', eventDays);
      const suffix = params.size ? `?${params}` : '';
      const response = await fetch(appUrl(`/api/pool/admin/analytics${suffix}`));
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error?.message || t('adminUnavailableDesc'));
      if (version !== requestVersion.current) return;
      if (!appendEvents) setAnalytics(body.analytics);
      setEvents((current) => ({
        items: appendEvents ? [...current.items, ...body.analytics.recentEvents] : body.analytics.recentEvents,
        nextCursor: body.analytics.nextEventCursor
      }));
      setError('');
    } catch (nextError) {
      if (version !== requestVersion.current) return;
      setError(nextError.message);
    } finally {
      if (version !== requestVersion.current) return;
      setRefreshing(false);
      setLoading(false);
    }
  }, [eventDays, eventQuery, t]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <Overlay isOpen position="fill" align="center" content={<Spinner size="lg" shade="onMedia" aria-label={t('adminLoadingAnalytics')} />} />;
  }
  if (!analytics) {
    return (
      <VStack gap={3} hAlign="center" padding={6}>
        <EmptyState title={t('adminUnavailableTitle')} description={error || t('adminUnavailableDesc')} />
        <Button label={t('retry')} variant="primary" onClick={() => void load()} />
      </VStack>
    );
  }

  const { overview, usage, tickets, providers, topProviders, topConsumers } = analytics;
  const successRate = percentage(usage.successes, usage.requests);
  const approvalRate = percentage(tickets.approved, tickets.approved + tickets.rejected);
  const dailyUsage = (analytics.dailyUsage || []).filter((day) => (
    day.day >= new Date(Date.now() - (Number(usageDays) - 1) * 86_400_000).toISOString().slice(0, 10)
  )).reverse();
  const leaderColumns = [
    { key: 'email', header: t('accountCol'), width: proportional(2), renderCell: (leader) => <Text maxLines={1}>{leader.email}</Text> },
    { key: 'sessions', header: t('sessionsCol'), width: pixel(100), renderCell: (leader) => <Text>{leader.sessionCount}</Text> },
    { key: 'spend', header: t('adminSettledUsage'), width: pixel(140), renderCell: (leader) => <Text>${money(leader.consumedMicros)} </Text> }
  ];
  const eventColumns = [
    { key: 'time', header: t('whenCol'), width: pixel(180), renderCell: (event) => <Text type="supporting" color="secondary" maxLines={1}>{dateTime(event.createdAt, language, t)}</Text> },
    { key: 'actor', header: t('actorCol'), width: proportional(1.5), renderCell: (event) => <Text maxLines={1}>{event.actorEmail}</Text> },
    { key: 'event', header: t('eventCol'), width: proportional(1.5), renderCell: (event) => <Text maxLines={1}>{event.action.replaceAll('_', ' ')} · {event.entityType.replaceAll('_', ' ')}</Text> },
    { key: 'entity', header: t('adminEntity'), width: proportional(1), renderCell: (event) => <Text type="supporting" maxLines={1}>{event.entityId}</Text> }
  ];
  const providerColumns = [
    { key: 'account', header: t('accountCol'), width: proportional(2), renderCell: (provider) => <Text maxLines={1}>{provider.email}</Text> },
    { key: 'type', header: t('adminProviderType'), width: pixel(100), renderCell: (provider) => <Text>{provider.quotaSource === 'ais' ? 'AIS' : provider.type}</Text> },
    { key: 'status', header: t('adminStatus'), width: proportional(1.5), renderCell: (provider) => <Text>{providerStatus(provider, t)}</Text> },
    { key: 'shares', header: t('adminShares'), width: pixel(85), renderCell: (provider) => <Text>{provider.shares}</Text> },
    { key: 'sessions', header: t('sessionsCol'), width: pixel(85), renderCell: (provider) => <Text>{provider.sessions}</Text> },
    { key: 'observed', header: t('adminObserved'), width: pixel(180), renderCell: (provider) => <Text type="supporting">{provider.observedAt ? dateTime(provider.observedAt, language, t) : t('adminNotObserved')}</Text> }
  ];
  const sessionColumns = [
    { key: 'provider', header: t('adminSharingFrom'), width: proportional(2), renderCell: (session) => <Text maxLines={1}>{session.providerEmail}</Text> },
    { key: 'consumer', header: t('adminSharingTo'), width: proportional(2), renderCell: (session) => <Text maxLines={1}>{session.consumerEmail}</Text> },
    { key: 'quota', header: t('adminQuotaLeftTotal'), width: pixel(180), renderCell: (session) => <Text>${money(session.remainingMicros)} / ${money(session.grantedMicros)}</Text> }
  ];
  const dailyColumns = [
    { key: 'day', header: t('whenCol'), width: proportional(1.5), renderCell: (day) => <Text>{day.day}</Text> },
    { key: 'requests', header: t('adminRequests'), width: proportional(1), renderCell: (day) => <Text>{number(day.requests)}</Text> },
    { key: 'successes', header: t('adminSuccesses'), width: proportional(1), renderCell: (day) => <Text>{number(day.successes)}</Text> },
    { key: 'failures', header: t('adminFailures'), width: proportional(1), renderCell: (day) => <Text>{number(day.failures)}</Text> },
    { key: 'spend', header: t('adminSettledUsage'), width: proportional(1), renderCell: (day) => <Text>${money(day.settledMicros)}</Text> }
  ];

  return (
    <VStack gap={4}>
      <HStack justify="between" vAlign="start" gap={2} wrap="wrap">
        <VStack gap={1}>
          <HStack gap={2} vAlign="center">
            <Icon icon={ChartNoAxesCombined} size="lg" color="accent" />
            <Heading level={1}>{t('adminAnalytics')}</Heading>
          </HStack>
          <Text type="supporting" color="secondary">{t('adminSubtitle')}</Text>
          <Text type="supporting" color="secondary">{t('adminAsOf', { time: dateTime(analytics.sampledAt, language, t) })}</Text>
        </VStack>
        <HStack gap={2} vAlign="center">
          {compact
            ? <IconButton label={t('backToDashboard')} tooltip={t('backToDashboard')} icon={<ArrowLeft size={16} />} size="sm" variant="secondary" href="./" />
            : <Button label={t('backToDashboard')} icon={<Icon icon={ArrowLeft} size="sm" />} variant="secondary" href="./" />}
          {compact
            ? <IconButton label={t('refresh')} tooltip={t('refresh')} icon={<RefreshCw size={16} />} size="sm" variant="primary" isLoading={refreshing} isDisabled={refreshing} onClick={() => void load()} />
            : <Button label={t('refresh')} icon={<Icon icon={RefreshCw} size="sm" />} variant="primary" isLoading={refreshing} isDisabled={refreshing} onClick={() => void load()} />}
          {languageToggle}
        </HStack>
      </HStack>
      {error && <Banner title={t('adminRefreshFailed')} description={error} status="warning" />}

      <Heading level={2}>{t('adminOverview')}</Heading>
      <MetricGrid items={[
        [t('adminMembers'), overview.accounts],
        [t('adminLinkedProviders'), overview.linkedProviders],
        [t('adminActiveOffers'), overview.activeOffers],
        [t('adminActiveSessions'), overview.activeSessions],
        [t('adminPendingApprovals'), overview.pendingTickets],
        [t('adminOpenRequests'), overview.activeQuotaRequests]
      ]} />
      <Grid columns={{ minWidth: 280, max: 3, repeat: 'fill' }} gap={2}>
        <InsightCard title={t('adminUsage')} rows={[
          [t('adminSettledUsage'), `$${money(usage.settledMicros)}`],
          [t('adminTodayUtc'), `$${money(usage.todayMicros)}`],
          [t('adminRequests'), number(usage.requests)],
          [t('adminSuccessRate'), successRate]
        ]} />
        <InsightCard title={t('adminRequestFunnel')} rows={[
          [t('adminTotalRequests'), number(tickets.total)],
          [t('adminApproved'), number(tickets.approved)],
          [t('adminRejected'), number(tickets.rejected)],
          [t('adminPendingApprovals'), number(tickets.pending)],
          [t('adminApprovalRate'), approvalRate]
        ]} />
        <InsightCard title={t('adminProviderHealth')} rows={[
          [t('adminSharingActive'), number(providers.sharingActive)],
          [t('adminSharingPaused'), number(providers.sharingPaused)],
          [t('adminUnavailableProviders'), number(providers.unavailable)],
          [t('adminEmailPending'), number(analytics.email.pending)]
        ]} />
      </Grid>
      <Text type="supporting" color="secondary">{t('adminMetricScope')}</Text>

      <Heading level={2}>{t('adminOperations')}</Heading>
      <MetricGrid items={[
        [t('adminUnavailableProviders'), providers.unavailable],
        [t('adminSharingPaused'), providers.sharingPaused],
        [t('adminEmailPending'), analytics.email.pending],
        [t('adminEmailFailed'), analytics.email.failed]
      ]} />
      <InsightCard title={t('adminEmailDelivery')} rows={[
        [t('adminEmailState'), t(analytics.email.enabled ? 'adminEnabled' : 'adminDisabled')],
        [t('adminOldestPending'), analytics.email.oldestPendingAt ? dateTime(analytics.email.oldestPendingAt, language, t) : t('adminNone')],
        [t('adminNextAttempt'), analytics.email.nextAttemptAt ? dateTime(analytics.email.nextAttemptAt, language, t) : t('adminNone')]
      ]} />
      <AnalyticsTable title={t('adminProviderHealth')} items={providers.details} columns={providerColumns} emptyTitle={t('adminNoDataYet')} emptyDescription={t('adminNoProviders')} />
      {compact && analytics.sessions.length
        ? (
          <VStack gap={2}>
            <Heading level={3}>{t('adminSharingSessions')}</Heading>
            {analytics.sessions.map((session) => (
              <Card key={session.id} padding={3}>
                <VStack gap={2}>
                  <VStack gap={1}>
                    <Text type="supporting" color="secondary">{t('adminSharingFrom')}</Text>
                    <Text>{session.providerEmail}</Text>
                  </VStack>
                  <VStack gap={1}>
                    <Text type="supporting" color="secondary">{t('adminSharingTo')}</Text>
                    <Text>{session.consumerEmail}</Text>
                  </VStack>
                  <HStack justify="between" gap={2}>
                    <Text type="supporting" color="secondary">{t('adminQuotaLeftTotal')}</Text>
                    <Text weight="bold">${money(session.remainingMicros)} / ${money(session.grantedMicros)}</Text>
                  </HStack>
                </VStack>
              </Card>
            ))}
          </VStack>
        )
        : <AnalyticsTable title={t('adminSharingSessions')} items={analytics.sessions} columns={sessionColumns} emptyTitle={t('adminNoDataYet')} emptyDescription={t('adminNoSessions')} />}

      <VStack gap={2}>
        <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
          <Heading level={2}>{t('adminUsage')}</Heading>
          <SegmentedControl label={t('adminUsageWindow')} value={usageDays} onChange={setUsageDays} size="sm">
            <SegmentedControlItem value="7" label={t('adminSevenDays')} />
            <SegmentedControlItem value="30" label={t('adminThirtyDays')} />
          </SegmentedControl>
        </HStack>
        <Text type="supporting" color="secondary">{t('adminUsageTrackingNote')}</Text>
      </VStack>
      <AnalyticsTable title={t('adminDailyUsage')} items={dailyUsage} columns={dailyColumns} idKey="day" emptyTitle={t('adminNoDataYet')} emptyDescription={t('adminUsageEmpty')} />
      <Grid columns={{ minWidth: 360, max: 2, repeat: 'fill' }} gap={2}>
        <AnalyticsTable title={t('adminTopProviders')} items={topProviders} columns={leaderColumns} emptyTitle={t('adminNoDataYet')} emptyDescription={t('adminTopProvidersEmpty')} />
        <AnalyticsTable title={t('adminTopConsumers')} items={topConsumers} columns={leaderColumns} emptyTitle={t('adminNoDataYet')} emptyDescription={t('adminTopConsumersEmpty')} />
      </Grid>

      <Heading level={2}>{t('adminActivity')}</Heading>
      <HStack gap={2} wrap="wrap" vAlign="end">
        <TextInput label={t('adminSearchEvents')} value={eventSearch} onChange={setEventSearch} width={300}
          onKeyDown={(event) => { if (event.key === 'Enter') setEventQuery(eventSearch.trim()); }} />
        <Button label={t('adminSearch')} icon={<Icon icon={Search} size="sm" />} variant="secondary"
          onClick={() => eventQuery === eventSearch.trim() ? void load() : setEventQuery(eventSearch.trim())} />
        <SegmentedControl label={t('adminActivityWindow')} value={eventDays} onChange={setEventDays} size="sm">
          <SegmentedControlItem value="0" label={t('adminAll')} />
          <SegmentedControlItem value="7" label={t('adminSevenDays')} />
          <SegmentedControlItem value="30" label={t('adminThirtyDays')} />
        </SegmentedControl>
      </HStack>
      <AnalyticsTable
        title={t('adminRecentActivity')}
        items={events.items}
        columns={eventColumns}
        emptyTitle={t('adminNoDataYet')}
        emptyDescription={t('adminRecentActivityEmpty')}
        footer={events.nextCursor && (
          <HStack justify="center">
            <Button label={t('adminLoadMore')} variant="secondary" isLoading={refreshing} isDisabled={refreshing} onClick={() => void load({ eventCursor: events.nextCursor, appendEvents: true })} />
          </HStack>
        )}
      />

      <HStack gap={2} vAlign="center">
        <Icon icon={Download} size="lg" color="accent" />
        <Heading level={2}>{t('adminDataTitle')}</Heading>
      </HStack>
      <DataPortabilityCard backup={analytics.backup} onImported={() => void load()} />
    </VStack>
  );
}

function exportRecordCount(data) {
  return (data.gateway?.records?.length || 0)
    + Object.values(data.product || {}).reduce((total, rows) => total + (Array.isArray(rows) ? rows.length : 0), 0);
}

function DataPortabilityCard({ backup, onImported }) {
  const { t, language } = useLanguage();
  const fileRef = useRef(null);
  const [pending, setPending] = useState(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState('');

  const exportData = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(appUrl('/api/pool/admin/export'));
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error?.message || t('adminExportFailed'));
      const filename = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || 'quotahub-export.json';
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([JSON.stringify(body)], { type: 'application/json' }));
      link.download = filename;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    setNotice('');
    try {
      const data = JSON.parse(await file.text());
      if (data?.format !== 'quotahub-export' || data.version !== 1) throw new Error('format');
      setPending({ data, records: exportRecordCount(data) });
      setConfirmation('');
    } catch {
      setError(t('adminImportFileError'));
    }
  };

  const confirmImport = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(appUrl('/api/pool/admin/import'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() },
        body: JSON.stringify(pending.data)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error?.message || t('adminImportFailed'));
      const records = exportRecordCount(pending.data);
      setPending(null);
      setConfirmation('');
      setNotice(t('adminImportSuccess', { records }));
      onImported();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding={3}>
      <VStack gap={2}>
        <Text type="supporting" color="secondary">{t('adminDataDesc')}</Text>
        <Text type="supporting" color="secondary">{backupStatusText(backup, language, t)}</Text>
        {backup?.lastFailureAt && <Banner title={t('adminBackupFailed', { time: dateTime(backup.lastFailureAt, language, t) })} status="warning" />}
        <Text type="supporting" color="secondary">{t('adminExportSensitive')}</Text>
        {notice && <Banner title={notice} status="success" />}
        {error && <Banner title={error} status="warning" />}
        {pending
          ? (
            <VStack gap={2}>
              <Text weight="bold">{t('adminImportConfirmDesc', { records: pending.records })}</Text>
              <Text type="supporting">{t('adminImportExportedAt', { time: dateTime(pending.data.exportedAt, language, t) })}</Text>
              <Text type="supporting">{t('adminImportGatewayCount', { count: number(pending.data.gateway?.records?.length) })}</Text>
              {Object.entries(pending.data.product || {}).filter(([, rows]) => Array.isArray(rows)).map(([table, rows]) => (
                <HStack key={table} justify="between" gap={2}>
                  <Text>{table}</Text>
                  <Text>{number(rows.length)}</Text>
                </HStack>
              ))}
              <TextInput label={t('adminImportType')} value={confirmation} onChange={setConfirmation} width={220} />
              <HStack gap={2}>
                <Button label={t('adminImportConfirm')} variant="primary" isLoading={busy} isDisabled={busy || confirmation !== 'IMPORT'} onClick={() => void confirmImport()} />
                <Button label={t('adminImportCancel')} variant="secondary" isDisabled={busy} onClick={() => setPending(null)} />
              </HStack>
            </VStack>
          )
          : (
            <HStack gap={2} wrap="wrap">
              <Button label={t('adminExport')} icon={<Icon icon={Download} size="sm" />} variant="secondary" isLoading={busy} isDisabled={busy} onClick={() => void exportData()} />
              <Button label={t('adminImport')} icon={<Icon icon={Upload} size="sm" />} variant="secondary" isDisabled={busy} onClick={() => fileRef.current?.click()} />
              <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(event) => void onFile(event)} />
            </HStack>
          )}
      </VStack>
    </Card>
  );
}

function MetricGrid({ items }) {
  return (
    <Grid columns={{ minWidth: 160, max: 6, repeat: 'fill' }} gap={2}>
      {items.map(([label, value]) => (
        <Card key={label} padding={3}>
          <VStack gap={1}>
            <Text type="supporting" color="secondary">{label}</Text>
            <Heading level={2}>{number(value)}</Heading>
          </VStack>
        </Card>
      ))}
    </Grid>
  );
}

function InsightCard({ title, rows }) {
  return (
    <Card padding={3}>
      <VStack gap={2}>
        <Heading level={3}>{title}</Heading>
        {rows.map(([label, value]) => (
          <HStack key={label} justify="between" gap={2}>
            <Text type="supporting" color="secondary">{label}</Text>
            <Text weight="bold">{value}</Text>
          </HStack>
        ))}
      </VStack>
    </Card>
  );
}

function AnalyticsTable({ title, items, columns, emptyTitle, emptyDescription, footer = null, idKey = 'id' }) {
  return (
    <Card padding={0}>
      <VStack gap={2} padding={3}>
        <Heading level={3}>{title}</Heading>
        {items.length
          ? <Table data={items} columns={columns} idKey={idKey} textOverflow="truncate" />
          : <EmptyState title={emptyTitle} description={emptyDescription} />}
        {footer}
      </VStack>
    </Card>
  );
}

function appUrl(path) {
  return new URL(String(path).replace(/^\//, ''), document.baseURI).toString();
}

function csrfToken() {
  for (const item of document.cookie.split(';')) {
    const [name, ...parts] = item.trim().split('=');
    if (name !== 'codex_pool_csrf') continue;
    try { return decodeURIComponent(parts.join('=')); } catch { return ''; }
  }
  return '';
}

function money(micros) {
  return (Number(micros || 0) / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function number(value) {
  return Number(value || 0).toLocaleString();
}

function percentage(value, total) {
  if (!total) return '—';
  return `${Math.round(value / total * 100)}%`;
}

function providerStatus(provider, t) {
  const issues = {
    provider_unavailable: 'adminProviderUnavailable',
    provider_reauth_required: 'adminProviderReauth',
    provider_key_rejected: 'adminProjectKeyRejected',
    provider_token_refresh_failed: 'adminProviderRefreshFailed',
    provider_quota_exhausted: 'adminProviderExhausted'
  };
  if (provider.issueCode) return t(issues[provider.issueCode] || 'adminProviderUnavailable');
  if (provider.sharingStatus === 'paused') return t('adminPaused');
  return provider.observedAt ? t('adminHealthy') : t('adminNotObserved');
}

function dateTime(value, language, t) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return t ? t('adminUnknownTime') : 'at an unknown time';
  const locale = language === 'zh' ? 'zh-CN' : undefined;
  return date.toLocaleString(locale, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

function backupStatusText(backup, language, t) {
  if (!backup?.enabled) return t('adminBackupDisabled');
  if (!backup.lastBackupAt) return t('adminBackupPending');
  return t('adminBackupLast', { time: dateTime(backup.lastBackupAt, language, t) });
}

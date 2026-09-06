import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Grid } from '@astryxdesign/core/Grid';
import { Icon } from '@astryxdesign/core/Icon';
import { Overlay } from '@astryxdesign/core/Overlay';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { Heading, Text } from '@astryxdesign/core/Text';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { ArrowLeft, ChartNoAxesCombined, RefreshCw } from 'lucide-react';
import { useLanguage } from './i18n.jsx';

export function AdminAnalytics() {
  const { t, language } = useLanguage();
  const [analytics, setAnalytics] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [events, setEvents] = useState({ items: [], nextCursor: null });
  const requestVersion = useRef(0);

  const load = useCallback(async ({ eventCursor = null, appendEvents = false } = {}) => {
    const version = ++requestVersion.current;
    setRefreshing(true);
    try {
      const suffix = eventCursor ? `?eventCursor=${encodeURIComponent(eventCursor)}` : '';
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
  }, []);

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
  const approvalRate = percentage(tickets.approved, tickets.total);
  const leaderColumns = [
    { key: 'email', header: t('accountCol'), width: proportional(2), renderCell: (leader) => <Text maxLines={1}>{leader.email}</Text> },
    { key: 'sessions', header: t('sessionsCol'), width: pixel(100), renderCell: (leader) => <Text>{leader.sessionCount}</Text> },
    { key: 'spend', header: t('adminSettledUsage'), width: pixel(140), renderCell: (leader) => <Text>${money(leader.consumedMicros)} </Text> }
  ];
  const eventColumns = [
    { key: 'time', header: t('whenCol'), width: pixel(180), renderCell: (event) => <Text type="supporting" color="secondary" maxLines={1}>{dateTime(event.createdAt, language, t)}</Text> },
    { key: 'actor', header: t('actorCol'), width: proportional(1.5), renderCell: (event) => <Text maxLines={1}>{event.actorEmail}</Text> },
    { key: 'event', header: t('eventCol'), width: proportional(1.5), renderCell: (event) => <Text maxLines={1}>{event.action.replaceAll('_', ' ')} · {event.entityType.replaceAll('_', ' ')}</Text> }
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
        </VStack>
        <HStack gap={2} wrap="wrap">
          <Button label={t('backToDashboard')} icon={<Icon icon={ArrowLeft} size="sm" />} variant="secondary" href="./" />
          <Button label={t('refresh')} icon={<Icon icon={RefreshCw} size="sm" />} variant="primary" isLoading={refreshing} isDisabled={refreshing} onClick={() => void load()} />
        </HStack>
      </HStack>
      {error && <Banner title={t('adminRefreshFailed')} description={error} status="warning" />}

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
          [t('adminToday'), `$${money(usage.todayMicros)}`],
          [t('adminRequests'), number(usage.requests)],
          [t('adminSuccessRate'), successRate]
        ]} />
        <InsightCard title={t('adminRequestFunnel')} rows={[
          [t('adminTotalRequests'), number(tickets.total)],
          [t('adminApproved'), number(tickets.approved)],
          [t('adminRejected'), number(tickets.rejected)],
          [t('adminApprovalRate'), approvalRate]
        ]} />
        <InsightCard title={t('adminProviderHealth')} rows={[
          [t('adminSharingActive'), number(providers.sharingActive)],
          [t('adminSharingPaused'), number(providers.sharingPaused)],
          [t('adminUnavailableProviders'), number(providers.unavailable)]
        ]} />
      </Grid>

      <Grid columns={{ minWidth: 360, max: 2, repeat: 'fill' }} gap={2}>
        <AnalyticsTable title={t('adminTopProviders')} items={topProviders} columns={leaderColumns} emptyTitle={t('adminNoDataYet')} emptyDescription={t('adminTopProvidersEmpty')} />
        <AnalyticsTable title={t('adminTopConsumers')} items={topConsumers} columns={leaderColumns} emptyTitle={t('adminNoDataYet')} emptyDescription={t('adminTopConsumersEmpty')} />
      </Grid>
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
    </VStack>
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

function AnalyticsTable({ title, items, columns, emptyTitle, emptyDescription, footer = null }) {
  return (
    <Card padding={0}>
      <VStack gap={2} padding={3}>
        <Heading level={3}>{title}</Heading>
        {items.length
          ? <Table data={items} columns={columns} idKey="id" textOverflow="truncate" />
          : <EmptyState title={emptyTitle} description={emptyDescription} />}
        {footer}
      </VStack>
    </Card>
  );
}

function appUrl(path) {
  return new URL(String(path).replace(/^\//, ''), document.baseURI).toString();
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

function dateTime(value, language, t) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return t ? t('adminUnknownTime') : 'at an unknown time';
  const locale = language === 'zh' ? 'zh-CN' : undefined;
  return date.toLocaleString(locale, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

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

export function AdminAnalytics() {
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
      if (!response.ok) throw new Error(body.error?.message || 'Unable to load analytics');
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
    return <Overlay isOpen position="fill" align="center" content={<Spinner size="lg" shade="onMedia" aria-label="Loading analytics" />} />;
  }
  if (!analytics) {
    return (
      <VStack gap={3} hAlign="center" padding={6}>
        <EmptyState title="Analytics unavailable" description={error || 'Unable to load administrator analytics.'} />
        <Button label="Try again" variant="primary" onClick={() => void load()} />
      </VStack>
    );
  }

  const { overview, usage, tickets, providers, topProviders, topConsumers } = analytics;
  const successRate = percentage(usage.successes, usage.requests);
  const approvalRate = percentage(tickets.approved, tickets.total);
  const leaderColumns = [
    { key: 'email', header: 'Account', width: proportional(2), renderCell: (leader) => <Text maxLines={1}>{leader.email}</Text> },
    { key: 'sessions', header: 'Sessions', width: pixel(100), renderCell: (leader) => <Text>{leader.sessionCount}</Text> },
    { key: 'spend', header: 'Settled usage', width: pixel(140), renderCell: (leader) => <Text>${money(leader.consumedMicros)} </Text> }
  ];
  const eventColumns = [
    { key: 'time', header: 'When', width: pixel(180), renderCell: (event) => <Text type="supporting" color="secondary" maxLines={1}>{dateTime(event.createdAt)}</Text> },
    { key: 'actor', header: 'Actor', width: proportional(1.5), renderCell: (event) => <Text maxLines={1}>{event.actorEmail}</Text> },
    { key: 'event', header: 'Event', width: proportional(1.5), renderCell: (event) => <Text maxLines={1}>{event.action.replaceAll('_', ' ')} · {event.entityType.replaceAll('_', ' ')}</Text> }
  ];

  return (
    <VStack gap={4}>
      <HStack justify="between" vAlign="start" gap={2} wrap="wrap">
        <VStack gap={1}>
          <HStack gap={2} vAlign="center">
            <Icon icon={ChartNoAxesCombined} size="lg" color="accent" />
            <Heading level={1}>Admin analytics</Heading>
          </HStack>
          <Text type="supporting" color="secondary">A privacy-safe view of sharing health, adoption, and settled usage.</Text>
        </VStack>
        <HStack gap={2} wrap="wrap">
          <Button label="Back to dashboard" icon={<Icon icon={ArrowLeft} size="sm" />} variant="secondary" href="./" />
          <Button label="Refresh" icon={<Icon icon={RefreshCw} size="sm" />} variant="primary" isLoading={refreshing} isDisabled={refreshing} onClick={() => void load()} />
        </HStack>
      </HStack>
      {error && <Banner title="Latest refresh failed" description={error} status="warning" />}

      <MetricGrid items={[
        ['Members', overview.accounts],
        ['Linked providers', overview.linkedProviders],
        ['Active offers', overview.activeOffers],
        ['Active sessions', overview.activeSessions],
        ['Pending approvals', overview.pendingTickets],
        ['Open quota requests', overview.activeQuotaRequests]
      ]} />

      <Grid columns={{ minWidth: 280, max: 3, repeat: 'fill' }} gap={2}>
        <InsightCard title="Usage" rows={[
          ['Settled usage', `$${money(usage.settledMicros)}`],
          ['Today', `$${money(usage.todayMicros)}`],
          ['Requests', number(usage.requests)],
          ['Success rate', successRate]
        ]} />
        <InsightCard title="Request funnel" rows={[
          ['Total requests', number(tickets.total)],
          ['Approved', number(tickets.approved)],
          ['Rejected', number(tickets.rejected)],
          ['Approval rate', approvalRate]
        ]} />
        <InsightCard title="Provider health" rows={[
          ['Sharing active', number(providers.sharingActive)],
          ['Sharing paused', number(providers.sharingPaused)],
          ['Unavailable providers', number(providers.unavailable)]
        ]} />
      </Grid>

      <Grid columns={{ minWidth: 360, max: 2, repeat: 'fill' }} gap={2}>
        <AnalyticsTable title="Top providers by settled usage" items={topProviders} columns={leaderColumns} emptyDescription="Settled provider usage will appear here." />
        <AnalyticsTable title="Top consumers by settled usage" items={topConsumers} columns={leaderColumns} emptyDescription="Settled consumer usage will appear here." />
      </Grid>
      <AnalyticsTable
        title="Recent sharing activity"
        items={events.items}
        columns={eventColumns}
        emptyDescription="Sharing lifecycle events will appear here."
        footer={events.nextCursor && (
          <HStack justify="center">
            <Button label="Load more events" variant="secondary" isLoading={refreshing} isDisabled={refreshing} onClick={() => void load({ eventCursor: events.nextCursor, appendEvents: true })} />
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

function AnalyticsTable({ title, items, columns, emptyDescription, footer = null }) {
  return (
    <Card padding={0}>
      <VStack gap={2} padding={3}>
        <Heading level={3}>{title}</Heading>
        {items.length
          ? <Table data={items} columns={columns} idKey="id" textOverflow="truncate" />
          : <EmptyState title="No data yet" description={emptyDescription} />}
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

function dateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'at an unknown time' : date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

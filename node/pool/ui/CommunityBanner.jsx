import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Grid } from '@astryxdesign/core/Grid';
import { Icon } from '@astryxdesign/core/Icon';
import { HStack, StackItem } from '@astryxdesign/core/Layout';
import { Link } from '@astryxdesign/core/Link';
import { Section } from '@astryxdesign/core/Section';
import { Text } from '@astryxdesign/core/Text';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { Gift, HandHeart } from 'lucide-react';
import { useLanguage } from './i18n.jsx';

const STATIC_MEDIA = '(prefers-reduced-motion: reduce)';
const COMPACT_MEDIA = '(max-width: 640px)';
const KINDS = ['requesting', 'sharing'];

export function CommunityBanner({ activity, onNavigate }) {
  const { t } = useLanguage();
  const [staticMode, setStaticMode] = useState(() => window.matchMedia(STATIC_MEDIA).matches);
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_MEDIA).matches);
  const available = KINDS.filter((kind) => activity?.[kind]?.people.length > 0);

  useEffect(() => {
    const motion = window.matchMedia(STATIC_MEDIA);
    const width = window.matchMedia(COMPACT_MEDIA);
    const updateMotion = () => setStaticMode(motion.matches);
    const updateWidth = () => setCompact(width.matches);
    motion.addEventListener('change', updateMotion);
    width.addEventListener('change', updateWidth);
    return () => {
      motion.removeEventListener('change', updateMotion);
      width.removeEventListener('change', updateWidth);
    };
  }, []);

  if (!available.length) return null;
  return (
    <Section
      variant="muted"
      padding={0}
      dividers={['top', 'bottom']}
      role="region"
      aria-label={t('communityActivity')}
    >
      <Grid columns={available.length} gap={0}>
        {available.map((kind, index) => (
          <StackItem key={kind} size="fill">
            <ActivityBanner
              kind={kind}
              group={activity[kind]}
              staticMode={staticMode}
              compact={compact}
              hasDivider={index > 0}
              onNavigate={onNavigate}
            />
          </StackItem>
        ))}
      </Grid>
    </Section>
  );
}

function ActivityBanner({ kind, group, staticMode, compact, hasDivider, onNavigate }) {
  const { t } = useLanguage();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const category = t(kind === 'requesting' ? 'communityRequests' : 'communityOffers');
  return (
    <Section
      variant="transparent"
      padding={compact ? 2 : 3}
      height="100%"
      dividers={hasDivider ? ['start'] : []}
      role="group"
      aria-label={category}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <HStack gap={compact ? 1 : 3} vAlign="center" minHeight={32}>
        <StackItem>
          <ActivityLabel kind={kind} total={group.totalPeople} compact={compact} />
        </StackItem>
        <StackItem size="fill">
          {staticMode ? (
            <Text as="div" maxLines={1} hasTruncateTooltip={false}>
              <PeopleMessage kind={kind} group={group} onNavigate={onNavigate} actionFirst />
            </Text>
          ) : (
            <Marquee
              kind={kind}
              group={group}
              paused={hovered || focused}
              onNavigate={onNavigate}
            />
          )}
        </StackItem>
      </HStack>
    </Section>
  );
}

function ActivityLabel({ kind, total, compact }) {
  const { t } = useLanguage();
  const category = t(kind === 'requesting' ? 'communityRequests' : 'communityOffers');
  return (
    <HStack gap={1.5} vAlign="center">
      <Tooltip content={category}>
        <Icon icon={kind === 'requesting' ? HandHeart : Gift} color={kind === 'requesting' ? 'warning' : 'success'} />
      </Tooltip>
      {!compact && (
        <>
          <Text type="label">{category}</Text>
          <Badge label={String(total)} variant={kind === 'requesting' ? 'yellow' : 'green'} />
        </>
      )}
    </HStack>
  );
}

function ActivityAction({ kind, onNavigate, duplicate }) {
  const { t } = useLanguage();
  return (
    <Link
      href="#community-sharing"
      hasUnderline
      color="accent"
      tabIndex={duplicate ? -1 : undefined}
      onClick={(event) => {
        event.preventDefault();
        onNavigate(kind);
      }}
    >
      <Text weight="bold">{t(kind === 'requesting' ? 'communityHelp' : 'communityExplore')}</Text>
    </Link>
  );
}

function PeopleMessage({ kind, group, onNavigate, duplicate = false, actionFirst = false }) {
  const { t } = useLanguage();
  const remaining = group.totalPeople - group.people.length;
  return (
    <>
      {actionFirst && <><ActivityAction kind={kind} onNavigate={onNavigate} />{': '}</>}
      {group.people.map((person, index) => {
        const name = person.displayName || person.email;
        const characters = Array.from(name);
        const label = characters.length > 28 ? `${characters.slice(0, 27).join('')}\u2026` : name;
        return (
          <React.Fragment key={person.id}>
            {index > 0 ? ', ' : ''}
            <Link
              href="#community-sharing"
              title={person.email}
              aria-label={person.email}
              tabIndex={duplicate ? -1 : undefined}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(kind, person.email);
              }}
            ><Text weight="bold" wordBreak="break-all">{label}</Text></Link>
          </React.Fragment>
        );
      })}
      {remaining > 0 ? t('communityOthers', { count: remaining }) : ''}
      {' '}
      {t(kind === 'requesting'
        ? (group.totalPeople === 1 ? 'communityRequestSingular' : 'communityRequestPlural')
        : (group.totalPeople === 1 ? 'communityShareSingular' : 'communitySharePlural'))}
      {!actionFirst && <>{' '}<ActivityAction kind={kind} onNavigate={onNavigate} duplicate={duplicate} /></>}
    </>
  );
}

function Marquee({ kind, group, paused, onNavigate }) {
  const { language } = useLanguage();
  const viewport = useRef(null);
  const content = useRef(null);
  const playback = useRef({ offset: 0, hold: 2400 });
  const pausedRef = useRef(paused);
  const [lapWidth, setLapWidth] = useState(0);
  const signature = JSON.stringify([kind, group, language]);

  useLayoutEffect(() => {
    pausedRef.current = paused;
  });

  useLayoutEffect(() => {
    const measure = () => {
      setLapWidth(Math.max(viewport.current.clientWidth, content.current.getBoundingClientRect().width + 64));
      viewport.current.scrollLeft = 0;
      playback.current = { offset: 0, hold: 2400 };
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport.current);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [signature]);

  useEffect(() => {
    if (!lapWidth) return undefined;
    let frame;
    let previous;
    let modalOpen = false;
    const checkModal = () => {
      modalOpen = [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]')]
        .some((dialog) => dialog.getClientRects().length > 0);
    };
    const observer = new MutationObserver(checkModal);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'aria-hidden', 'open', 'data-state', 'class', 'style']
    });
    checkModal();
    const tick = (now) => {
      const elapsed = previous === undefined ? 0 : Math.min(now - previous, 64);
      previous = now;
      if (!pausedRef.current && !document.hidden && !modalOpen) {
        const state = playback.current;
        if (state.hold > 0) {
          state.hold -= elapsed;
        } else {
          state.offset += elapsed * 0.045;
          if (state.offset >= lapWidth) {
            state.offset = 0;
            state.hold = 2400;
          }
          viewport.current.scrollLeft = state.offset;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [lapWidth]);

  return (
    <Text as="div" ref={viewport} maxLines={1} hasTruncateTooltip={false} data-community-marquee="">
      <HStack as="span" width="max-content" vAlign="center">
        {[false, true].map((duplicate) => (
          <StackItem as="span" key={String(duplicate)} aria-hidden={duplicate || undefined}>
            <HStack as="span" width={lapWidth || 'max-content'} minHeight={32} vAlign="center">
              <Text ref={duplicate ? undefined : content} textWrap="nowrap">
                <PeopleMessage kind={kind} group={group} onNavigate={onNavigate} duplicate={duplicate} />
              </Text>
            </HStack>
          </StackItem>
        ))}
      </HStack>
    </Text>
  );
}

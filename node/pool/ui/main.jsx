import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import { AppShell } from '@astryxdesign/core/AppShell';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { Overlay } from '@astryxdesign/core/Overlay';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Heading, Text } from '@astryxdesign/core/Text';
import { defineTheme, Theme } from '@astryxdesign/core/theme';
import { ToastViewport, useToast } from '@astryxdesign/core/Toast';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { neutralTheme } from '@astryxdesign/theme-neutral';
import { BookOpen, Share2 } from 'lucide-react';
import { AdminAnalytics } from './admin.jsx';
import { SharingWorkspace } from './sharing.jsx';

const poolTheme = defineTheme({
  name: 'codex-share',
  extends: neutralTheme,
  tokens: {
    '--color-overlay': '#00000080'
  },
  components: {
    toast: {
      base: { userSelect: 'text' }
    },
    card: {
      'variant:red': {
        backgroundColor: 'var(--color-background-card)',
        boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-border-red), transparent 50%)'
      }
    },
    button: {
      'variant:dashed': {
        backgroundColor: 'transparent',
        borderColor: 'var(--color-border-emphasized)',
        borderStyle: 'dashed',
        borderWidth: '1px',
        color: 'var(--color-text-secondary)'
      }
    },
    'segmented-control-item': {
      'size:md+selected': {
        fontWeight: 'var(--font-weight-medium)'
      }
    },
    banner: {
      'status:info': {
        '--color-accent-muted': 'var(--color-background-blue)'
      }
    },
    progressbar: {
      base: {
        '--color-background-muted': 'var(--color-track)'
      },
      'variant:success': {
        '--color-success': 'light-dark(#9fe59b, #0c5700)'
      },
      'variant:warning': {
        '--color-background-muted': 'var(--color-background-yellow)'
      },
      'variant:error': {
        '--color-background-muted': 'var(--color-background-red)'
      }
    }
  }
});

function GuideButton() {
  const buttonRef = useRef(null);

  useEffect(() => {
    const element = buttonRef.current;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!element || reducedMotion || typeof element.animate !== 'function') return undefined;
    const animation = element.animate(
      [
        {
          backgroundColor: 'var(--color-neutral)'
        },
        {
          backgroundColor: 'color-mix(in srgb, var(--color-accent), var(--color-neutral) 78%)'
        },
        {
          backgroundColor: 'var(--color-neutral)'
        }
      ],
      { duration: 2600, easing: 'ease-in-out', iterations: Infinity }
    );
    return () => animation.cancel();
  }, []);

  return (
    <Button
      ref={buttonRef}
      label="User Guide"
      icon={<Icon icon={BookOpen} size="sm" />}
      variant="secondary"
      href="https://confluence.shopee.io/x/y6Vyx"
      target="_blank"
      rel="noopener noreferrer"
    />
  );
}

function Product() {
  return (
    <Theme theme={poolTheme} mode="dark">
      <ToastViewport position="bottomEnd" maxVisible={3} isTopLayer>
        {window.location.pathname.endsWith('/admin') ? <AdminShell /> : <ProductShell />}
      </ToastViewport>
    </Theme>
  );
}

function AdminShell() {
  return (
    <AppShell variant="surface" height="auto" contentPadding={3} mobileNav={false}>
      <VStack width="max(1280px, 100%)">
        <AdminAnalytics />
      </VStack>
    </AppShell>
  );
}

function ProductShell() {
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const toast = useToast();
  const show = useCallback((text, error = false) => {
    toast({ body: text, type: error ? 'error' : 'info', isAutoHide: true });
    if (error) raiseToastViewport();
  }, [toast]);
  return (
    <Overlay isOpen={workspaceLoading} position="fill" align="center" content={<Spinner size="lg" shade="onMedia" aria-label="Loading sharing workspace" />}>
      <AppShell variant="surface" height="fill" contentPadding={3} mobileNav={false}>
      <VStack gap={4} width="max(1280px, 100%)">
        <HStack justify="between" vAlign="start" gap={2} wrap="wrap">
          <VStack gap={1}>
            <HStack gap={2} vAlign="center">
              <Icon icon={Share2} size="lg" color="accent" />
              <Heading level={1}>Codex Share</Heading>
            </HStack>
            <Text type="supporting" color="secondary">Share delegated Codex quota or an AIS project without sharing provider credentials.</Text>
          </VStack>
          <HStack gap={2} wrap="wrap">
            <GuideButton />
          </HStack>
        </HStack>
        <SharingWorkspace onNotice={show} onLoadingChange={setWorkspaceLoading} />
      </VStack>
      </AppShell>
    </Overlay>
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

createRoot(document.getElementById('root')).render(<Product />);

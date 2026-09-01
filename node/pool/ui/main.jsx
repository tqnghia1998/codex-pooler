import React, { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import { AppShell } from '@astryxdesign/core/AppShell';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { Heading, Text } from '@astryxdesign/core/Text';
import { defineTheme, Theme } from '@astryxdesign/core/theme';
import { ToastViewport, useToast } from '@astryxdesign/core/Toast';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { Share2 } from 'lucide-react';
import { SharingWorkspace } from './sharing.jsx';

const poolTheme = defineTheme({
  name: 'codex-share',
  extends: neutralTheme,
  components: {
    card: {
      'variant:red': {
        backgroundColor: 'var(--color-background-card)',
        boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-border-red), transparent 50%)'
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

function useStoredValue(key, fallback) {
  const [value, setValue] = useState(() => localStorage.getItem(key) || fallback);
  const update = useCallback((next) => {
    setValue(next);
    localStorage.setItem(key, next);
  }, [key]);
  return [value, update];
}

function Product() {
  const [themeMode, setThemeMode] = useStoredValue('codex_pool_theme', 'dark');
  return (
    <Theme theme={poolTheme} mode={themeMode}>
      <ToastViewport position="bottomEnd" maxVisible={3}>
        <ProductShell themeMode={themeMode} setThemeMode={setThemeMode} />
      </ToastViewport>
    </Theme>
  );
}

function ProductShell({ themeMode, setThemeMode }) {
  const toast = useToast();
  const show = useCallback((text, error = false) => {
    toast({ body: text, type: error ? 'error' : 'info', isAutoHide: true });
  }, [toast]);
  return (
    <AppShell variant="surface" height="auto" contentPadding={4} mobileNav={false}>
      <VStack gap={6}>
        <HStack justify="between" vAlign="start" gap={3} wrap="wrap">
          <VStack gap={1}>
            <HStack gap={2} vAlign="center">
              <Icon icon={Share2} size="lg" color="accent" />
              <Heading level={1}>Codex Share</Heading>
            </HStack>
            <Text type="supporting" color="secondary">Share delegated Codex quota without sharing provider credentials.</Text>
          </VStack>
          <Button
            label={themeMode === 'dark' ? 'Light mode' : 'Dark mode'}
            variant="secondary"
            onClick={() => setThemeMode(themeMode === 'dark' ? 'light' : 'dark')}
          />
        </HStack>
        <SharingWorkspace onNotice={show} />
      </VStack>
    </AppShell>
  );
}

createRoot(document.getElementById('root')).render(<Product />);

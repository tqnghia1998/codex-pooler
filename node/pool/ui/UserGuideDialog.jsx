import React from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Button } from '@astryxdesign/core/Button';
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from '@astryxdesign/core/Layout';
import { useLanguage } from './i18n.jsx';

export function UserGuideDialog({ isOpen, onClose, title, subtitle, children }) {
  const { t } = useLanguage();
  return (
    <Dialog isOpen={isOpen} onOpenChange={onClose} width={680}>
      <Layout
        header={<DialogHeader title={title} subtitle={subtitle} onOpenChange={onClose} hasDivider />}
        content={<LayoutContent><VStack gap={4}>{children}</VStack></LayoutContent>}
        footer={(
          <LayoutFooter hasDivider>
            <HStack justify="end">
              <Button label={t('done')} variant="primary" onClick={onClose} />
            </HStack>
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

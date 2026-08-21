/// <reference types="vite/client" />

import type { TemplateCreatePayload, TemplateDefinition, TemplateUpdatePatch } from '@nobowo/core';

declare global {
  interface Window {
    electronAPI: Record<string, never>;
    templateAPI: {
      list: () => Promise<TemplateDefinition[]>;
      create: (payload: TemplateCreatePayload) => Promise<TemplateDefinition>;
      update: (id: string, patch: TemplateUpdatePatch) => Promise<TemplateDefinition | null>;
      remove: (id: string) => Promise<void>;
      getImage: (id: string, kind?: 'template' | 'source') => Promise<string | null>;
    };
  }
}

export {};

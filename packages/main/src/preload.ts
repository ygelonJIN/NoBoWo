import { contextBridge, ipcRenderer } from 'electron';
import type { TemplateCreatePayload, TemplateUpdatePatch } from '@nobowo/core';

contextBridge.exposeInMainWorld('electronAPI', {
  // 后续扩展：执行引擎通信、文件操作等
});

contextBridge.exposeInMainWorld('templateAPI', {
  list: () => ipcRenderer.invoke('templates:list'),
  create: (payload: TemplateCreatePayload) => ipcRenderer.invoke('templates:create', payload),
  update: (id: string, patch: TemplateUpdatePatch) => ipcRenderer.invoke('templates:update', id, patch),
  remove: (id: string) => ipcRenderer.invoke('templates:delete', id),
  getImage: (id: string, kind: 'template' | 'source' = 'template') =>
    ipcRenderer.invoke('templates:image', id, kind),
});

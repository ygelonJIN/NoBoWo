import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type {
  TemplateCreatePayload,
  TemplateDefinition,
  TemplateUpdatePatch,
} from '@nobowo/core';

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 800,
    title: 'NoBoWo',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
};

// ===== 模板库存储 =====

const templatesDir = () => join(app.getPath('userData'), 'templates');
const indexFile = () => join(templatesDir(), 'index.json');

async function ensureTemplatesDir() {
  await mkdir(templatesDir(), { recursive: true });
}

async function loadIndex(): Promise<TemplateDefinition[]> {
  try {
    const raw = await readFile(indexFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveIndex(index: TemplateDefinition[]) {
  await ensureTemplatesDir();
  await writeFile(indexFile(), JSON.stringify(index, null, 2), 'utf8');
}

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mime: string } {
  const [header, base64] = dataUrl.split(',');
  const mime = header.match(/^data:([^;]+)/)?.[1] ?? 'image/png';
  return { buffer: Buffer.from(base64 ?? '', 'base64'), mime };
}

function dataUrlToFileData(dataUrl: string): { buffer: Buffer; ext: string } {
  const { buffer, mime } = dataUrlToBuffer(dataUrl);
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  return { buffer, ext };
}

async function readImageAsDataUrl(fileName: string): Promise<string> {
  const buffer = await readFile(join(templatesDir(), fileName));
  const ext = fileName.split('.').pop() ?? 'png';
  const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function registerTemplateIpc() {
  ipcMain.handle('templates:list', async (): Promise<TemplateDefinition[]> => {
    const index = await loadIndex();
    return index.sort((a, b) => b.updatedAt - a.updatedAt);
  });

  ipcMain.handle(
    'templates:create',
    async (_event, payload: TemplateCreatePayload): Promise<TemplateDefinition> => {
      const id = randomUUID();
      const image = dataUrlToFileData(payload.imageDataUrl);
      const imageFile = `${id}.${image.ext}`;
      await ensureTemplatesDir();

      let sourceFile: string | undefined;
      if (payload.sourceDataUrl) {
        const source = dataUrlToFileData(payload.sourceDataUrl);
        sourceFile = `${id}.src.${source.ext}`;
        await writeFile(join(templatesDir(), sourceFile), source.buffer);
      }

      await writeFile(join(templatesDir(), imageFile), image.buffer);

      const definition: TemplateDefinition = {
        id,
        name: payload.name.trim(),
        notes: payload.notes,
        app: payload.app,
        appZoom: payload.appZoom,
        resolution: payload.resolution,
        scaleFactor: payload.scaleFactor,
        clickOffset: payload.clickOffset,
        sourceRect: payload.sourceRect,
        imageFile,
        sourceFile,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const index = await loadIndex();
      index.push(definition);
      await saveIndex(index);
      return definition;
    },
  );

  ipcMain.handle(
    'templates:update',
    async (_event, id: string, patch: TemplateUpdatePatch): Promise<TemplateDefinition | null> => {
      const index = await loadIndex();
      const existing = index.find((t) => t.id === id);
      if (!existing) return null;

      if (patch.imageDataUrl) {
        const image = dataUrlToFileData(patch.imageDataUrl);
        await ensureTemplatesDir();
        await writeFile(join(templatesDir(), existing.imageFile), image.buffer);
      }
      if (patch.sourceDataUrl) {
        const source = dataUrlToFileData(patch.sourceDataUrl);
        const sourceFile = `${id}.src.${source.ext}`;
        await ensureTemplatesDir();
        if (existing.sourceFile && existing.sourceFile !== sourceFile) {
          await unlink(join(templatesDir(), existing.sourceFile)).catch(() => {});
        }
        await writeFile(join(templatesDir(), sourceFile), source.buffer);
        existing.sourceFile = sourceFile;
      }

      const { imageDataUrl: _ignored, sourceDataUrl: _ignored2, ...rest } = patch;
      Object.assign(existing, rest);
      if (rest.name !== undefined) existing.name = rest.name.trim();
      existing.updatedAt = Date.now();

      await saveIndex(index);
      return existing;
    },
  );

  ipcMain.handle('templates:delete', async (_event, id: string): Promise<void> => {
    const index = await loadIndex();
    const found = index.find((t) => t.id === id);
    if (!found) return;
    await unlink(join(templatesDir(), found.imageFile)).catch(() => {});
    if (found.sourceFile) {
      await unlink(join(templatesDir(), found.sourceFile)).catch(() => {});
    }
    await saveIndex(index.filter((t) => t.id !== id));
  });

  ipcMain.handle(
    'templates:image',
    async (_event, id: string, kind: 'template' | 'source' = 'template'): Promise<string | null> => {
      const index = await loadIndex();
      const found = index.find((t) => t.id === id);
      if (!found) return null;
      const fileName = kind === 'source' ? found.sourceFile : found.imageFile;
      if (!fileName) return null;
      try {
        return await readImageAsDataUrl(fileName);
      } catch {
        return null;
      }
    },
  );
}

app.whenReady().then(() => {
  registerTemplateIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
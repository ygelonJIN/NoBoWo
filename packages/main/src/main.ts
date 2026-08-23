import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { copyFile, link, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { connect as tcpConnect } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  CloudApiProfile,
  OcrEngine,
  StreamConnectionTestResult,
  StreamMotionResult,
  StreamProbeResult,
  StreamScreenshotResult,
  StreamSourceProfile,
  TemplateCreatePayload,
  TemplateDefinition,
  TemplateFolder,
  TemplateUpdatePatch,
  YoloAnnotation,
  YoloClassDefinition,
  YoloDataset,
  OcrResult,
  YoloEnvInfo,
  YoloImage,
  YoloModel,
  YoloModelArtifacts,
  YoloTrainConfig,
  YoloTrainingEvent,
  YoloTrainingState,
} from '@nobowo/core';
import { YOLO_CLASS_COLORS } from '@nobowo/core';

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

type TemplateIndex = {
  folders: TemplateFolder[];
  templates: TemplateDefinition[];
};

const normalizeTemplate = (tpl: TemplateDefinition): TemplateDefinition => ({
  ...tpl,
  folderId: tpl.folderId ?? null,
  tags: tpl.tags ?? [],
  matchHotspot: tpl.matchHotspot ?? tpl.sourceRect,
});

const templatesDir = () => join(app.getPath('userData'), 'templates');
const indexFile = () => join(templatesDir(), 'index.json');
const templateImagesDir = () => join(templatesDir(), 'images');
const templateSourcesDir = () => join(templatesDir(), 'sources');
const cloudApiProfilesFile = () => join(app.getPath('userData'), 'api-profiles.json');

async function ensureTemplatesDir() {
  await mkdir(templatesDir(), { recursive: true });
  await mkdir(templateImagesDir(), { recursive: true });
  await mkdir(templateSourcesDir(), { recursive: true });
}

async function loadIndex(): Promise<TemplateIndex> {
  try {
    const raw = await readFile(indexFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<TemplateIndex> | TemplateDefinition[];
    if (Array.isArray(parsed)) {
      return { folders: [], templates: parsed.map(normalizeTemplate) };
    }
    if (parsed && Array.isArray(parsed.templates) && Array.isArray(parsed.folders)) {
      return { folders: parsed.folders, templates: parsed.templates.map(normalizeTemplate) };
    }
  } catch {
    return { folders: [], templates: [] };
  }
  return { folders: [], templates: [] };
}

async function saveIndex(index: TemplateIndex) {
  await ensureTemplatesDir();
  await writeFile(indexFile(), JSON.stringify(index, null, 2), 'utf8');
}

type CloudApiIndex = {
  profiles: CloudApiProfile[];
};

function normalizeProfile(profile: CloudApiProfile): CloudApiProfile {
  return {
    ...profile,
    baseUrl: profile.baseUrl.trim(),
    name: profile.name.trim(),
    apiKey: profile.apiKey ?? '',
    defaultPrompt: profile.defaultPrompt ?? '',
    lastTestAt: profile.lastTestAt ?? null,
    lastTestStatus: profile.lastTestStatus ?? null,
    lastTestMessage: profile.lastTestMessage ?? null,
  };
}

async function loadCloudApiIndex(): Promise<CloudApiIndex> {
  try {
    const raw = await readFile(cloudApiProfilesFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CloudApiIndex> | CloudApiProfile[];
    if (Array.isArray(parsed)) {
      return { profiles: parsed.map(normalizeProfile) };
    }
    if (parsed && Array.isArray(parsed.profiles)) {
      return { profiles: parsed.profiles.map(normalizeProfile) };
    }
  } catch {
    return { profiles: [] };
  }
  return { profiles: [] };
}

async function saveCloudApiIndex(index: CloudApiIndex) {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(cloudApiProfilesFile(), JSON.stringify(index, null, 2), 'utf8');
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

async function readImageAsDataUrl(fileName: string, kind: 'template' | 'source' = 'template'): Promise<string> {
  const buffer = await readFile(kind === 'source' ? join(templateSourcesDir(), fileName) : join(templateImagesDir(), fileName));
  const ext = fileName.split('.').pop() ?? 'png';
  const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function normalizeTags(tags?: string[]) {
  return [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
}

function ensureParentId(folderId?: string | null) {
  return folderId ?? null;
}

function normalizeFolderName(name: string) {
  return name.trim().replace(/\s+/g, ' ');
}

function registerCloudApiIpc() {
  ipcMain.handle('cloudApi:list', async (): Promise<CloudApiProfile[]> => {
    const index = await loadCloudApiIndex();
    return index.profiles.sort((a, b) => b.updatedAt - a.updatedAt);
  });

  ipcMain.handle(
    'cloudApi:create',
    async (_event, payload: { name: string; baseUrl: string; apiKey: string; defaultPrompt?: string }): Promise<CloudApiProfile> => {
      const now = Date.now();
      const profile: CloudApiProfile = normalizeProfile({
        id: randomUUID(),
        name: payload.name,
        baseUrl: payload.baseUrl,
        apiKey: payload.apiKey,
        defaultPrompt: payload.defaultPrompt ?? '',
        createdAt: now,
        updatedAt: now,
        lastTestAt: null,
        lastTestStatus: null,
        lastTestMessage: null,
      });
      const index = await loadCloudApiIndex();
      index.profiles.push(profile);
      await saveCloudApiIndex(index);
      return profile;
    },
  );

  ipcMain.handle(
    'cloudApi:update',
    async (
      _event,
      id: string,
      patch: { name?: string; baseUrl?: string; apiKey?: string; defaultPrompt?: string },
    ): Promise<CloudApiProfile | null> => {
      const index = await loadCloudApiIndex();
      const profile = index.profiles.find((item) => item.id === id);
      if (!profile) return null;
      if (typeof patch.name === 'string') profile.name = patch.name.trim();
      if (typeof patch.baseUrl === 'string') profile.baseUrl = patch.baseUrl.trim();
      if (typeof patch.apiKey === 'string') profile.apiKey = patch.apiKey;
      if (typeof patch.defaultPrompt === 'string') profile.defaultPrompt = patch.defaultPrompt;
      profile.updatedAt = Date.now();
      await saveCloudApiIndex(index);
      return profile;
    },
  );

  ipcMain.handle('cloudApi:remove', async (_event, id: string): Promise<void> => {
    const index = await loadCloudApiIndex();
    index.profiles = index.profiles.filter((profile) => profile.id !== id);
    await saveCloudApiIndex(index);
  });

  ipcMain.handle(
    'cloudApi:test',
    async (_event, payload: { baseUrl: string; apiKey: string; name?: string }): Promise<{ ok: boolean; message?: string; lastTestAt: number }> => {
      const baseUrl = payload.baseUrl.trim();
      if (!baseUrl) return { ok: false, message: 'Base URL 不能为空', lastTestAt: Date.now() };
      const normalized = baseUrl.replace(/\/+$/, '');
      const now = Date.now();
      try {
        const response = await fetch(`${normalized}`,
          {
            method: 'GET',
            headers: payload.apiKey ? { Authorization: `Bearer ${payload.apiKey}` } : undefined,
          },
        );
        if (response.ok || response.status < 500) {
          return { ok: true, message: `${payload.name ?? '配置'} 连接成功（HTTP ${response.status}）`, lastTestAt: now };
        }
        return { ok: false, message: `服务端返回 HTTP ${response.status}`, lastTestAt: now };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err), lastTestAt: now };
      }
    },
  );
}

// ===== 串流设备管理 =====

const streamSourcesFile = () => join(app.getPath('userData'), 'stream-sources.json');

type StreamSourceIndex = {
  sources: StreamSourceProfile[];
};

function normalizeStreamSource(source: StreamSourceProfile): StreamSourceProfile {
  return {
    ...source,
    name: source.name.trim(),
    type: source.type ?? 'otherDevice',
    host: source.host?.trim() || undefined,
    port: source.port ? Number(source.port) : undefined,
    url: source.url?.trim() || undefined,
    windowHint: source.windowHint?.trim() || undefined,
    notes: source.notes?.trim() || undefined,
    lastTestAt: source.lastTestAt ?? null,
    lastTestStatus: source.lastTestStatus ?? null,
    lastTestMessage: source.lastTestMessage ?? null,
  };
}

async function loadStreamSources(): Promise<StreamSourceIndex> {
  try {
    const raw = await readFile(streamSourcesFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<StreamSourceIndex> | StreamSourceProfile[];
    if (Array.isArray(parsed)) {
      return { sources: parsed.map(normalizeStreamSource) };
    }
    if (parsed && Array.isArray(parsed.sources)) {
      return { sources: parsed.sources.map(normalizeStreamSource) };
    }
  } catch {
    return { sources: [] };
  }
  return { sources: [] };
}

async function saveStreamSources(index: StreamSourceIndex) {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(streamSourcesFile(), JSON.stringify(index, null, 2), 'utf8');
}

function testTcpConnection(host: string, port: number, timeoutMs = 4000): Promise<{ ok: boolean; latencyMs: number | null; message: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tcpConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, latencyMs: null, message: `连接超时（${timeoutMs}ms）` });
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      const latency = Date.now() - started;
      socket.destroy();
      resolve({ ok: true, latencyMs: latency, message: `TCP 连接成功 · ${latency}ms` });
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, latencyMs: null, message: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function captureWindowFrames(sourceId: string, thumbnailSize: { width: number; height: number }): Promise<{ frame: string; width: number; height: number } | null> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize,
      fetchWindowIcons: false,
    });
    const source = sources.find((item) => item.id === sourceId);
    if (!source || source.thumbnail.isEmpty()) return null;
    const size = source.thumbnail.getSize();
    return { frame: source.thumbnail.toDataURL(), width: size.width, height: size.height };
  } catch {
    return null;
  }
}

function registerStreamIpc() {
  ipcMain.handle('stream:list', async (): Promise<StreamSourceProfile[]> => {
    const index = await loadStreamSources();
    return index.sources.sort((a, b) => b.updatedAt - a.updatedAt);
  });

  ipcMain.handle(
    'stream:create',
    async (_event, payload: Omit<StreamSourceProfile, 'id' | 'createdAt' | 'updatedAt'>): Promise<StreamSourceProfile> => {
      const now = Date.now();
      const profile: StreamSourceProfile = normalizeStreamSource({
        id: randomUUID(),
        name: payload.name,
        type: payload.type,
        host: payload.host,
        port: payload.port,
        url: payload.url,
        windowHint: payload.windowHint,
        notes: payload.notes,
        createdAt: now,
        updatedAt: now,
        lastTestAt: null,
        lastTestStatus: null,
        lastTestMessage: null,
      });
      const index = await loadStreamSources();
      index.sources.push(profile);
      await saveStreamSources(index);
      return profile;
    },
  );

  ipcMain.handle(
    'stream:update',
    async (_event, id: string, patch: Partial<Omit<StreamSourceProfile, 'id' | 'createdAt' | 'updatedAt'>>): Promise<StreamSourceProfile | null> => {
      const index = await loadStreamSources();
      const profile = index.sources.find((item) => item.id === id);
      if (!profile) return null;
      if (typeof patch.name === 'string') profile.name = patch.name.trim();
      if (patch.type !== undefined) profile.type = patch.type;
      if (typeof patch.host === 'string') profile.host = patch.host.trim() || undefined;
      if (patch.port !== undefined) profile.port = patch.port ? Number(patch.port) : undefined;
      if (typeof patch.url === 'string') profile.url = patch.url.trim() || undefined;
      if (typeof patch.windowHint === 'string') profile.windowHint = patch.windowHint.trim() || undefined;
      if (typeof patch.notes === 'string') profile.notes = patch.notes.trim() || undefined;
      profile.updatedAt = Date.now();
      await saveStreamSources(index);
      return normalizeStreamSource(profile);
    },
  );

  ipcMain.handle('stream:remove', async (_event, id: string): Promise<void> => {
    const index = await loadStreamSources();
    index.sources = index.sources.filter((source) => source.id !== id);
    await saveStreamSources(index);
  });

  ipcMain.handle(
    'stream:testConnection',
    async (_event, payload: { host?: string; port?: number; url?: string; name?: string }): Promise<StreamConnectionTestResult> => {
      const now = Date.now();
      const host = payload.host?.trim();
      const url = payload.url?.trim();
      if (url) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5000);
          const started = Date.now();
          const response = await fetch(url, { method: 'GET', signal: controller.signal });
          clearTimeout(timer);
          const latency = Date.now() - started;
          if (response.ok || response.status < 500) {
            return { ok: true, message: `${payload.name ?? '串流源'} 可达（HTTP ${response.status}）· ${latency}ms`, latencyMs: latency, lastTestAt: now };
          }
          return { ok: false, message: `服务端返回 HTTP ${response.status}`, latencyMs: latency, lastTestAt: now };
        } catch (err) {
          const message = err instanceof Error ? (err.name === 'AbortError' ? '请求超时（5s）' : err.message) : String(err);
          return { ok: false, message, latencyMs: null, lastTestAt: now };
        }
      }
      const port = payload.port ? Number(payload.port) : undefined;
      if (!host || !port || !Number.isInteger(port) || port <= 0 || port > 65535) {
        return { ok: false, message: '请填写有效的主机地址和端口（1-65535）', latencyMs: null, lastTestAt: now };
      }
      const result = await testTcpConnection(host, port);
      return { ok: result.ok, message: result.message, latencyMs: result.latencyMs, lastTestAt: now };
    },
  );

  ipcMain.handle('stream:probeWindows', async (): Promise<StreamProbeResult> => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false,
      });
      const windows = sources
        .filter((source) => !source.name.startsWith('NoBoWo'))
        .map((source) => {
          const size = source.thumbnail.getSize();
          return {
            id: source.id,
            name: source.name,
            thumbnail: source.thumbnail.toDataURL(),
            width: size.width,
            height: size.height,
          };
        })
        .filter((item) => item.thumbnail.length > 0);
      return {
        ok: true,
        message: `扫描到 ${windows.length} 个窗口`,
        windows,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        windows: [],
      };
    }
  });

  const captureResult = (captured: { frame: string; width: number; height: number } | null): StreamMotionResult => {
    if (!captured) {
      return { ok: false, changed: false, diffRatio: 0, message: '未能抓取该窗口画面（窗口可能已关闭、最小化或没有屏幕录制权限）' };
    }
    return { ok: true, changed: false, diffRatio: 0, frame: captured.frame, width: captured.width, height: captured.height, message: '抓帧成功' };
  };

  ipcMain.handle('stream:captureWindow', async (_event, sourceId: string): Promise<StreamMotionResult> => {
    return captureResult(await captureWindowFrames(sourceId, { width: 960, height: 540 }));
  });

  ipcMain.handle('stream:captureSource', async (_event, sourceId: string): Promise<StreamMotionResult> => {
    const index = await loadStreamSources();
    const profile = index.sources.find((source) => source.id === sourceId);
    if (!profile) return { ok: false, changed: false, diffRatio: 0, message: '找不到串流设备配置' };
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 960, height: 540 },
      fetchWindowIcons: false,
    });
    const hint = profile.windowHint?.trim().toLowerCase();
    const source = (hint ? sources.find((item) => item.name.toLowerCase().includes(hint)) : undefined)
      ?? sources.find((item) => !item.name.startsWith('NoBoWo'));
    return captureResult(source ? await captureWindowFrames(source.id, { width: 960, height: 540 }) : null);
  });

  ipcMain.handle(
    'stream:captureScreenshot',
    async (
      _event,
      payload: { source: 'screen' | 'stream'; streamSourceId?: string },
    ): Promise<StreamScreenshotResult> => {
      const thumbnailSize = { width: 1920, height: 1080 };
      try {
        if (payload.source === 'stream') {
          const index = await loadStreamSources();
          const profile = index.sources.find((source) => source.id === payload.streamSourceId);
          if (!profile) {
            return { ok: false, message: '找不到串流设备配置，请在「串流设备」中先创建并保存设备' };
          }
          const sources = await desktopCapturer.getSources({
            types: ['window'],
            thumbnailSize,
            fetchWindowIcons: false,
          });
          const hint = profile.windowHint?.trim().toLowerCase();
          const windowSource = (hint ? sources.find((item) => item.name.toLowerCase().includes(hint)) : undefined)
            ?? sources.find((item) => !item.name.startsWith('NoBoWo'));
          if (!windowSource || windowSource.thumbnail.isEmpty()) {
            return { ok: false, message: '未找到串流窗口，请确认串流窗口已打开、macOS 屏幕录制权限已授权' };
          }
          const size = windowSource.thumbnail.getSize();
          return { ok: true, frame: windowSource.thumbnail.toDataURL(), width: size.width, height: size.height };
        }
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize,
          fetchWindowIcons: false,
        });
        const screenSource = sources[0];
        if (!screenSource || screenSource.thumbnail.isEmpty()) {
          return { ok: false, message: '无法截取屏幕画面，请确认屏幕录制权限已授权' };
        }
        const size = screenSource.thumbnail.getSize();
        return { ok: true, frame: screenSource.thumbnail.toDataURL(), width: size.width, height: size.height };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}

function registerOcrIpc() {
  ipcMain.handle('ocr:listEngines', async (): Promise<{ available: OcrEngine[]; default: OcrEngine }> => ({
    available: ['auto', 'macosVision', 'windowsOcr', 'tesseract', 'paddleOcr'],
    default: 'auto',
  }));

  const ocrDataDir = () => join(app.getPath('userData'), 'ocr');

  async function ensureOcrLangData(): Promise<{ langPath: string; gzip: boolean }> {
    const dir = ocrDataDir();
    await mkdir(dir, { recursive: true });
    const gzPath = join(dir, 'eng.traineddata.gz');
    const rawPath = join(dir, 'eng.traineddata');
    try {
      await stat(gzPath);
      return { langPath: dir, gzip: true };
    } catch {
      // continue
    }
    try {
      await stat(rawPath);
      return { langPath: dir, gzip: false };
    } catch {
      // continue
    }
    const response = await fetch('https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz');
    if (!response.ok) {
      throw new Error(`首次使用需要下载 OCR 语言包（HTTP ${response.status}），请检查网络后重试`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(gzPath, buffer);
    return { langPath: dir, gzip: true };
  }

  ipcMain.handle(
    'ocr:run',
    async (
      _event,
      payload: { engine: OcrEngine; imageDataUrl: string; targetText?: string; width?: number; height?: number },
    ): Promise<OcrResult> => {
      const { createWorker } = await import('tesseract.js');
      const { langPath, gzip } = await ensureOcrLangData();
      const worker = await createWorker('eng', undefined, { langPath, gzip, cachePath: ocrDataDir() });
      try {
        const recognition = await worker.recognize(payload.imageDataUrl, undefined, { blocks: true });
        const data = recognition.data as {
          text?: string;
          blocks?: Array<{
            paragraphs?: Array<{
              lines?: Array<{
                words?: Array<{
                  text?: string;
                  confidence?: number;
                  bbox?: { x0?: number; y0?: number; x1?: number; y1?: number };
                }>;
              }>;
            }>;
          }>;
        };
        const words = (data.blocks ?? [])
          .flatMap((block) => block.paragraphs ?? [])
          .flatMap((paragraph) => paragraph.lines ?? [])
          .flatMap((line) => line.words ?? []);
        const matches = words
          .filter((word) => word.text?.trim())
          .map((word, index) => ({
            id: `ocr-${index}-${word.bbox?.x0 ?? 0}-${word.bbox?.y0 ?? 0}`,
            text: word.text?.trim() ?? '',
            box: {
              x: word.bbox?.x0 ?? 0,
              y: word.bbox?.y0 ?? 0,
              width: Math.max(0, (word.bbox?.x1 ?? 0) - (word.bbox?.x0 ?? 0)),
              height: Math.max(0, (word.bbox?.y1 ?? 0) - (word.bbox?.y0 ?? 0)),
            },
            confidence: typeof word.confidence === 'number' ? word.confidence / 100 : undefined,
          }))
          .filter((match) => match.text.length > 0);
        return {
          engine: payload.engine,
          width: payload.width ?? 0,
          height: payload.height ?? 0,
          text: data.text?.trim() ?? '',
          matches,
          message: payload.targetText?.trim() ? `已搜索：${payload.targetText.trim()}` : undefined,
        };
      } finally {
        await worker.terminate();
      }
    },
  );
}

function registerTemplateIpc() {
  ipcMain.handle('templates:list', async (): Promise<{ folders: TemplateFolder[]; templates: TemplateDefinition[] }> => {
    const index = await loadIndex();
    return {
      folders: index.folders.sort((a, b) => a.name.localeCompare(b.name)),
      templates: index.templates.sort((a, b) => b.updatedAt - a.updatedAt),
    };
  });

  ipcMain.handle('templates:createFolder', async (_event, payload: { name: string; parentId?: string | null }): Promise<TemplateFolder> => {
    const index = await loadIndex();
    const folder: TemplateFolder = {
      id: randomUUID(),
      name: normalizeFolderName(payload.name),
      parentId: ensureParentId(payload.parentId),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    index.folders.push(folder);
    await saveIndex(index);
    return folder;
  });

  ipcMain.handle('templates:updateFolder', async (_event, id: string, patch: Partial<Pick<TemplateFolder, 'name' | 'parentId'>>): Promise<TemplateFolder | null> => {
    const index = await loadIndex();
    const folder = index.folders.find((f) => f.id === id);
    if (!folder) return null;
    if (patch.name !== undefined) folder.name = normalizeFolderName(patch.name);
    if (patch.parentId !== undefined) folder.parentId = ensureParentId(patch.parentId);
    folder.updatedAt = Date.now();
    await saveIndex(index);
    return folder;
  });

  ipcMain.handle('templates:removeFolder', async (_event, id: string, opts?: { moveTemplatesTo?: string | null }): Promise<void> => {
    const index = await loadIndex();
    index.folders = index.folders.filter((f) => f.id !== id);
    const target = ensureParentId(opts?.moveTemplatesTo);
    for (const tpl of index.templates) {
      if (tpl.folderId === id) tpl.folderId = target;
    }
    await saveIndex(index);
  });

  ipcMain.handle(
    'templates:create',
    async (_event, payload: TemplateCreatePayload): Promise<TemplateDefinition> => {
      const id = randomUUID();
      const image = dataUrlToFileData(payload.imageDataUrl);
      const imageFile = `${id}.${image.ext}`;
      await ensureTemplatesDir();
      await writeFile(join(templateImagesDir(), imageFile), image.buffer);

      let sourceFile: string | undefined;
      if (payload.sourceDataUrl) {
        const source = dataUrlToFileData(payload.sourceDataUrl);
        sourceFile = `${id}.src.${source.ext}`;
        await writeFile(join(templateSourcesDir(), sourceFile), source.buffer);
      }

      const definition: TemplateDefinition = {
        id,
        name: payload.name.trim(),
        notes: payload.notes,
        app: payload.app,
        appZoom: payload.appZoom,
        folderId: ensureParentId(payload.folderId),
        tags: normalizeTags(payload.tags),
        windowTitle: payload.windowTitle?.trim(),
        matchHotspot: payload.matchHotspot,
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
      index.templates.push(definition);
      await saveIndex(index);
      return definition;
    },
  );

  ipcMain.handle(
    'templates:update',
    async (_event, id: string, patch: TemplateUpdatePatch): Promise<TemplateDefinition | null> => {
      const index = await loadIndex();
      const existing = index.templates.find((t) => t.id === id);
      if (!existing) return null;

      if (patch.imageDataUrl) {
        const image = dataUrlToFileData(patch.imageDataUrl);
        await ensureTemplatesDir();
        await writeFile(join(templateImagesDir(), existing.imageFile), image.buffer);
      }
      if (patch.sourceDataUrl) {
        const source = dataUrlToFileData(patch.sourceDataUrl);
        const sourceFile = `${id}.src.${source.ext}`;
        await ensureTemplatesDir();
        if (existing.sourceFile && existing.sourceFile !== sourceFile) {
          await unlink(join(templateSourcesDir(), existing.sourceFile)).catch(() => {});
        }
        await writeFile(join(templateSourcesDir(), sourceFile), source.buffer);
        existing.sourceFile = sourceFile;
      }

      const { imageDataUrl: _ignored, sourceDataUrl: _ignored2, ...rest } = patch;
      Object.assign(existing, rest);
      if (rest.name !== undefined) existing.name = rest.name.trim();
      if (rest.tags) existing.tags = normalizeTags(rest.tags);
      if (rest.folderId !== undefined) existing.folderId = ensureParentId(rest.folderId);
      if (rest.windowTitle !== undefined) existing.windowTitle = rest.windowTitle?.trim();
      if (rest.matchHotspot !== undefined) existing.matchHotspot = rest.matchHotspot;
      existing.updatedAt = Date.now();

      await saveIndex(index);
      return existing;
    },
  );

  ipcMain.handle('templates:delete', async (_event, id: string): Promise<void> => {
    const index = await loadIndex();
    const found = index.templates.find((t) => t.id === id);
    if (!found) return;
    await unlink(join(templateImagesDir(), found.imageFile)).catch(() => {});
    if (found.sourceFile) {
      await unlink(join(templateSourcesDir(), found.sourceFile)).catch(() => {});
    }
    await saveIndex({ folders: index.folders, templates: index.templates.filter((t) => t.id !== id) });
  });

  ipcMain.handle('templates:batchUpdate', async (_event, ids: string[], patch: TemplateUpdatePatch): Promise<number> => {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    const index = await loadIndex();
    let count = 0;
    for (const tpl of index.templates) {
      if (!ids.includes(tpl.id)) continue;
      if (patch.name !== undefined) tpl.name = patch.name.trim();
      if (patch.notes !== undefined) tpl.notes = patch.notes;
      if (patch.app !== undefined) tpl.app = patch.app;
      if (patch.appZoom !== undefined) tpl.appZoom = patch.appZoom;
      if (patch.folderId !== undefined) tpl.folderId = ensureParentId(patch.folderId);
      if (patch.tags) tpl.tags = normalizeTags(patch.tags);
      if (patch.windowTitle !== undefined) tpl.windowTitle = patch.windowTitle?.trim();
      if (patch.enabled !== undefined) tpl.enabled = patch.enabled;
      tpl.updatedAt = Date.now();
      count++;
    }
    await saveIndex(index);
    return count;
  });

  ipcMain.handle('templates:batchDelete', async (_event, ids: string[]): Promise<number> => {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    const index = await loadIndex();
    const idSet = new Set(ids);
    for (const tpl of index.templates) {
      if (!idSet.has(tpl.id)) continue;
      await unlink(join(templateImagesDir(), tpl.imageFile)).catch(() => {});
      if (tpl.sourceFile) {
        await unlink(join(templateSourcesDir(), tpl.sourceFile)).catch(() => {});
      }
    }
    const before = index.templates.length;
    index.templates = index.templates.filter((t) => !idSet.has(t.id));
    await saveIndex(index);
    return before - index.templates.length;
  });

  ipcMain.handle('templates:export', async (_event, ids: string[]): Promise<{ path: string | null; count: number }> => {
    if (!Array.isArray(ids) || ids.length === 0) return { path: null, count: 0 };
    const index = await loadIndex();
    const idSet = new Set(ids);
    const picked = index.templates.filter((t) => idSet.has(t.id));
    if (picked.length === 0) return { path: null, count: 0 };

    const result = await dialog.showOpenDialog({
      title: '选择导出位置',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return { path: null, count: 0 };
    const baseDir = result.filePaths[0];
    const exportRoot = join(baseDir, `nobowo-templates-${new Date().toISOString().slice(0, 10)}`);
    await mkdir(join(exportRoot, 'images'), { recursive: true });
    await mkdir(join(exportRoot, 'sources'), { recursive: true });

    const manifest: TemplateDefinition[] = [];
    for (const tpl of picked) {
      const entry: TemplateDefinition = { ...tpl };
      try {
        await copyFile(join(templateImagesDir(), tpl.imageFile), join(exportRoot, 'images', tpl.imageFile));
      } catch {
        entry.imageFile = '';
      }
      if (tpl.sourceFile) {
        try {
          await copyFile(join(templateSourcesDir(), tpl.sourceFile), join(exportRoot, 'sources', tpl.sourceFile));
        } catch {
          entry.sourceFile = undefined;
        }
      }
      manifest.push(entry);
    }
    await writeFile(join(exportRoot, 'templates.json'), JSON.stringify({ version: 1, folders: index.folders, templates: manifest }, null, 2), 'utf8');
    await shell.openPath(exportRoot);
    return { path: exportRoot, count: manifest.length };
  });

  ipcMain.handle(
    'templates:image',
    async (_event, id: string, kind: 'template' | 'source' = 'template'): Promise<string | null> => {
      const index = await loadIndex();
      const found = index.templates.find((t) => t.id === id);
      if (!found) return null;
      const fileName = kind === 'source' ? found.sourceFile : found.imageFile;
      if (!fileName) return null;
      try {
        return await readImageAsDataUrl(fileName, kind);
      } catch {
        return null;
      }
    },
  );
}

// ===== YOLO 训练模块 =====

const YOLO_ENGINE_SOURCE = String.raw`#!/usr/bin/env python3
# NoBoWo YOLO 训练引擎 —— 向 stdout 输出结构化 JSON 事件
import json
import os
import sys
import traceback


def emit(**kw):
    payload = {"t": kw.pop("t", "log"), **kw}
    try:
        print(json.dumps(payload, ensure_ascii=False), flush=True)
    except Exception:
        pass


def main():
    if len(sys.argv) < 2:
        emit(t="error", message="缺少配置文件参数")
        return 2
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        cfg = json.load(f)

    try:
        from ultralytics import YOLO
        import ultralytics
    except Exception as exc:
        emit(t="error", message="无法加载 ultralytics：" + str(exc) + "\n请先在「环境」页检查 Python 与依赖是否安装。")
        return 1

    emit(t="log", level="info", message="ultralytics " + str(getattr(ultralytics, "__version__", "?")) + " 已就绪")

    aug = cfg.get("augment", {})
    data_yaml = cfg["dataYaml"]
    project = cfg["projectDir"]
    name = cfg["runName"]

    emit(t="start", jobId=name, totalEpochs=int(cfg["epochs"]), message="训练已启动")

    try:
        model = YOLO(cfg["model"])

        def on_epoch_end(trainer):
            try:
                metrics = trainer.metrics or {}
                emit(
                    t="epoch",
                    epoch=int(trainer.epoch) + 1,
                    totalEpochs=int(trainer.epochs),
                    lr=round(float(trainer.lr), 6) if trainer.lr else 0.0,
                    metrics={
                        "boxLoss": round(float(metrics.get("train/box_loss", 0) or 0), 4),
                        "clsLoss": round(float(metrics.get("train/cls_loss", 0) or 0), 4),
                        "dflLoss": round(float(metrics.get("train/dfl_loss", 0) or 0), 4),
                        "precision": round(float(metrics.get("metrics/precision(B)", 0) or 0) * 100, 2),
                        "recall": round(float(metrics.get("metrics/recall(B)", 0) or 0) * 100, 2),
                        "mAP50": round(float(metrics.get("metrics/mAP50(B)", 0) or 0) * 100, 2),
                        "mAP50_95": round(float(metrics.get("metrics/mAP50-95(B)", 0) or 0) * 100, 2),
                    },
                )
            except Exception:
                pass

        def on_batch_end(trainer):
            try:
                epoch = int(trainer.epoch)
                i = int(trainer.i)
                nb = int(getattr(trainer, "nb", 0)) or len(trainer.train_loader)
                total = max(1, int(trainer.epochs))
                done = (epoch + i / max(1, nb)) / total
                emit(
                    t="progress",
                    epoch=epoch + 1,
                    percent=round(min(100.0, max(0.0, done * 100)), 1),
                    message="epoch " + str(epoch + 1) + "/" + str(total) + " · batch " + str(i) + "/" + str(nb),
                )
            except Exception:
                pass

        model.add_callback("on_train_epoch_end", on_epoch_end)
        model.add_callback("on_train_batch_end", on_batch_end)

        device = cfg.get("device", "auto")
        if device == "auto":
            device = None

        kwargs = dict(
            data=data_yaml,
            epochs=int(cfg["epochs"]),
            batch=int(cfg["batch"]),
            imgsz=int(cfg["imageSize"]),
            lr0=float(cfg.get("lr0", 0.01)),
            lrf=float(cfg.get("lrf", 0.01)),
            momentum=float(cfg.get("momentum", 0.937)),
            weight_decay=float(cfg.get("weightDecay", 0.0005)),
            warmup_epochs=float(cfg.get("warmupEpochs", 3.0)),
            patience=int(cfg.get("patience", 20)),
            device=device,
            workers=int(cfg.get("workers", 4)),
            seed=int(cfg.get("seed", 0)),
            deterministic=bool(cfg.get("deterministic", True)),
            project=project,
            name=name,
            exist_ok=True,
            hsv_h=float(aug.get("hsvH", 0.015)),
            hsv_s=float(aug.get("hsvS", 0.7)),
            hsv_v=float(aug.get("hsvV", 0.4)),
            degrees=float(aug.get("degrees", 0.0)),
            translate=float(aug.get("translate", 0.1)),
            scale=float(aug.get("scale", 0.5)),
            shear=float(aug.get("shear", 0.0)),
            perspective=float(aug.get("perspective", 0.0)),
            flipud=float(aug.get("flipud", 0.0)),
            fliplr=float(aug.get("fliplr", 0.5)),
            mosaic=float(aug.get("mosaic", 1.0)),
            mixup=float(aug.get("mixup", 0.0)),
            copy_paste=float(aug.get("copyPaste", 0.0)),
            erasing=float(aug.get("erasing", 0.0)),
            crop_fraction=float(aug.get("cropFraction", 1.0)),
        )

        model.train(**kwargs)
        emit(t="log", level="info", message="训练循环结束，开始验证集评估…")

        best_pt = os.path.join(project, name, "weights", "best.pt")
        if not os.path.exists(best_pt):
            emit(t="error", message="未找到 best.pt，训练可能被中断")
            return 1

        metrics = None
        val_dir = os.path.join(project, name + "-val")
        try:
            val_model = YOLO(best_pt)
            val = val_model.val(
                data=data_yaml,
                imgsz=int(cfg["imageSize"]),
                device=device,
                verbose=False,
                project=project,
                name=name + "-val",
                exist_ok=True,
                plots=True,
            )
            rd = val.results_dict or {}
            metrics = {
                "precision": round(float(rd.get("metrics/precision(B)", 0) or 0) * 100, 2),
                "recall": round(float(rd.get("metrics/recall(B)", 0) or 0) * 100, 2),
                "mAP50": round(float(rd.get("metrics/mAP50(B)", 0) or 0) * 100, 2),
                "mAP50_95": round(float(rd.get("metrics/mAP50-95(B)", 0) or 0) * 100, 2),
            }
        except Exception:
            traceback.print_exc()

        artifacts = {}
        cm = os.path.join(val_dir, "confusion_matrix.png")
        pr = os.path.join(val_dir, "PR_curve.png")
        if os.path.exists(cm):
            artifacts["confusionMatrix"] = cm
        if os.path.exists(pr):
            artifacts["prCurve"] = pr

        emit(
            t="done",
            modelPath=best_pt,
            sizeBytes=os.path.getsize(best_pt),
            metrics=metrics,
            artifacts=artifacts if artifacts else None,
        )
        return 0
    except Exception:
        emit(t="error", message=traceback.format_exc())
        return 1


def run_export(model_path, fmt, imgsz):
    try:
        from ultralytics import YOLO
    except Exception as exc:
        emit(t="error", message="无法加载 ultralytics：" + str(exc))
        return 1
    try:
        emit(t="log", level="info", message="开始导出格式：" + fmt + "（首次导出可能需要下载对应依赖）")
        model = YOLO(model_path)
        exported = model.export(format=fmt, imgsz=int(imgsz), verbose=False)
        emit(t="log", level="info", message="导出完成：" + str(exported))
        emit(t="done", modelPath=str(exported), sizeBytes=os.path.getsize(str(exported)), metrics=None)
        return 0
    except Exception:
        emit(t="error", message=traceback.format_exc())
        return 1


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "export":
        fmt = sys.argv[3] if len(sys.argv) > 3 else "onnx"
        imgsz = sys.argv[4] if len(sys.argv) > 4 else "640"
        sys.exit(run_export(sys.argv[2], fmt, imgsz))
    sys.exit(main())
`;

const yoloRootDir = () => join(app.getPath('userData'), 'yolo');
const yoloDatasetsDir = () => join(yoloRootDir(), 'datasets');
const yoloModelsDir = () => join(yoloRootDir(), 'models');
const yoloRunsDir = () => join(yoloRootDir(), 'runs');
const yoloIndexFile = () => join(yoloRootDir(), 'index.json');

type YoloIndexFile = {
  version: 1;
  datasets: YoloDataset[];
  models: YoloModel[];
};

type YoloDatasetFile = {
  classes: YoloClassDefinition[];
  images: YoloImage[];
  annotations: Record<string, YoloAnnotation[]>;
};

type YoloJobMeta = {
  jobId: string;
  datasetId: string;
  datasetName: string;
  baseModel: string;
  epochs: number;
  imageSize: number;
  batch: number;
};

let trainingChild: ChildProcess | null = null;
let trainingJobId: string | null = null;
let currentJobMeta: YoloJobMeta | null = null;
let packageChild: ChildProcess | null = null;
let exportChild: ChildProcess | null = null;

async function ensureYoloDirs() {
  await mkdir(yoloRootDir(), { recursive: true });
  await mkdir(yoloDatasetsDir(), { recursive: true });
  await mkdir(yoloModelsDir(), { recursive: true });
  await mkdir(yoloRunsDir(), { recursive: true });
}

async function loadYoloIndex(): Promise<YoloIndexFile> {
  try {
    const raw = await readFile(yoloIndexFile(), 'utf8');
    const parsed = JSON.parse(raw) as YoloIndexFile;
    if (parsed?.version === 1 && Array.isArray(parsed.datasets) && Array.isArray(parsed.models)) return parsed;
  } catch {
    // first run or corrupted index
  }
  return { version: 1, datasets: [], models: [] };
}

async function saveYoloIndex(index: YoloIndexFile) {
  await ensureYoloDirs();
  await writeFile(yoloIndexFile(), JSON.stringify(index, null, 2), 'utf8');
}

const datasetFile = (id: string) => join(yoloDatasetsDir(), id, 'dataset.json');
const datasetImagesDir = (id: string) => join(yoloDatasetsDir(), id, 'images');
const datasetExportDir = (id: string) => join(yoloDatasetsDir(), id, 'export');

async function loadDatasetFile(id: string): Promise<YoloDatasetFile> {
  try {
    const raw = await readFile(datasetFile(id), 'utf8');
    const parsed = JSON.parse(raw) as Partial<YoloDatasetFile>;
    if (parsed && Array.isArray(parsed.classes) && Array.isArray(parsed.images)) {
      return {
        classes: parsed.classes,
        images: parsed.images,
        annotations: parsed.annotations ?? {},
      };
    }
  } catch {
    // dataset dir may not exist yet
  }
  return { classes: [], images: [], annotations: {} };
}

async function saveDatasetFile(id: string, data: YoloDatasetFile) {
  await mkdir(join(yoloDatasetsDir(), id), { recursive: true });
  await writeFile(datasetFile(id), JSON.stringify(data, null, 2), 'utf8');
}

async function countDataset(id: string): Promise<{ imageCount: number; annotatedCount: number; classCount: number }> {
  const data = await loadDatasetFile(id);
  return {
    imageCount: data.images.length,
    annotatedCount: data.images.filter((img) => (data.annotations[img.id]?.length ?? 0) > 0).length,
    classCount: data.classes.length,
  };
}

async function readDatasetImage(datasetId: string, imageId: string): Promise<string | null> {
  const data = await loadDatasetFile(datasetId);
  const image = data.images.find((img) => img.id === imageId);
  if (!image) return null;
  try {
    const buffer = await readFile(join(datasetImagesDir(datasetId), image.file));
    const ext = image.file.split('.').pop() ?? 'png';
    const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const copy = [...arr];
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function linkOrCopy(src: string, dest: string) {
  try {
    await link(src, dest);
  } catch {
    await copyFile(src, dest);
  }
}

/** 导出数据集为 YOLO 格式（images + labels + data.yaml + 训练/验证划分），返回 data.yaml 路径 */
async function writeYoloExport(datasetId: string, splitTrain: number, seed: number): Promise<string> {
  const data = await loadDatasetFile(datasetId);
  if (data.classes.length === 0) throw new Error('数据集没有类别，请先在「标注」页添加类别');
  if (data.images.length === 0) throw new Error('数据集没有图片，请先上传截图');

  const exportDir = datasetExportDir(datasetId);
  const imagesAll = join(exportDir, 'images');
  const labelsAll = join(exportDir, 'labels');
  const splitDir = join(exportDir, 'split');
  await rm(exportDir, { recursive: true, force: true });
  await mkdir(imagesAll, { recursive: true });
  await mkdir(labelsAll, { recursive: true });

  const classIndex = new Map(data.classes.map((c, i) => [c.id, i]));

  for (const image of data.images) {
    const src = join(datasetImagesDir(datasetId), image.file);
    await linkOrCopy(src, join(imagesAll, image.file));
    const lines: string[] = [];
    for (const ann of data.annotations[image.id] ?? []) {
      if (!ann.classId) continue;
      const ci = classIndex.get(ann.classId);
      if (ci === undefined) continue;
      const { x, y, width, height } = ann.box;
      const cx = Math.min(1, Math.max(0, x + width / 2));
      const cy = Math.min(1, Math.max(0, y + height / 2));
      const w = Math.min(1, Math.max(0, width));
      const h = Math.min(1, Math.max(0, height));
      lines.push(`${ci} ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`);
    }
    await writeFile(join(labelsAll, `${image.id}.txt`), lines.join('\n'), 'utf8');
  }

  const ordered = [...data.images].sort((a, b) => a.createdAt - b.createdAt);
  const shuffled = seededShuffle(ordered, seed);
  const split = Math.min(0.9, Math.max(0.5, splitTrain));
  const trainCount = Math.max(1, Math.round(shuffled.length * split));
  const trainSet = new Set(shuffled.slice(0, trainCount).map((img) => img.id));

  for (const sub of ['train', 'val']) {
    await mkdir(join(splitDir, 'images', sub), { recursive: true });
    await mkdir(join(splitDir, 'labels', sub), { recursive: true });
  }
  for (const image of data.images) {
    const sub = trainSet.has(image.id) ? 'train' : 'val';
    await linkOrCopy(join(imagesAll, image.file), join(splitDir, 'images', sub, image.file));
    await linkOrCopy(join(labelsAll, `${image.id}.txt`), join(splitDir, 'labels', sub, `${image.id}.txt`));
  }

  const yaml = [
    `# NoBoWo dataset export — ${new Date().toISOString()}`,
    `path: ${exportDir.replace(/\\/g, '/')}`,
    'train: split/images/train',
    'val: split/images/val',
    'names:',
    ...data.classes.map((c, i) => `  ${i}: ${JSON.stringify(c.name)}`),
  ].join('\n');
  const yamlPath = join(exportDir, 'data.yaml');
  await writeFile(yamlPath, yaml, 'utf8');
  return yamlPath;
}

const pythonCommand = () => (process.platform === 'win32' ? 'python' : 'python3');

function runCaptured(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function sanitizeLogLine(line: string): string | null {
  const cleaned = line
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .trim();
  if (!cleaned) return null;
  if (/^\s*[\d.]+\/[\d.]+\s+\[[^\]\n]*\]\s*$/.test(cleaned)) return null;
  if (/^\s*[\d.]+\s+it\/s/.test(cleaned)) return null;
  if (/^\s*\d+%\|\s*[█▉▊▋▌▍▎▏=>.\s-]*\|/.test(cleaned)) return null;
  return cleaned;
}

function registerYoloIpc() {
  const broadcastEvent = (ev: YoloTrainingEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('yolo:trainingEvent', ev);
    }
  };

  const broadcastTrainingState = () => {
    const state: YoloTrainingState = { running: trainingChild !== null, jobId: trainingJobId };
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('yolo:trainingState', state);
    }
  };

  const handleEngineLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;
    if (line.startsWith('{')) {
      try {
        const ev = JSON.parse(line) as YoloTrainingEvent;
        if (ev && typeof ev === 'object' && typeof (ev as { t?: unknown }).t === 'string') {
          broadcastEvent(ev);
          if (ev.t === 'done') void onTrainingDone(ev);
          if (ev.t === 'error') console.warn('[yolo] engine error:', ev.message.slice(0, 300));
          return;
        }
      } catch {
        // 不是结构化事件，按普通日志处理
      }
    }
    const cleaned = sanitizeLogLine(line);
    if (cleaned) {
      broadcastEvent({ t: 'log', level: 'info', message: cleaned });
    }
  };

  async function onTrainingDone(ev: Extract<YoloTrainingEvent, { t: 'done' }>) {
    try {
      const meta = currentJobMeta;
      if (!meta) return;
      const index = await loadYoloIndex();
      const id = randomUUID();
      const dest = join(yoloModelsDir(), `${id}.pt`);
      await mkdir(yoloModelsDir(), { recursive: true });
      await copyFile(ev.modelPath, dest);
      const size = await stat(dest);
      const model: YoloModel = {
        id,
        name: `${meta.datasetName} · ${meta.baseModel.replace(/\.pt$/, '')}`,
        baseModel: meta.baseModel,
        datasetId: meta.datasetId,
        datasetName: meta.datasetName,
        epochs: meta.epochs,
        imageSize: meta.imageSize,
        batch: meta.batch,
        file: `${id}.pt`,
        sizeBytes: size.size,
        metrics: ev.metrics,
        createdAt: Date.now(),
        isActive: false,
      };
      // 复制混淆矩阵 / PR 曲线等训练产物
      if (ev.artifacts) {
        const artifactDir = join(yoloModelsDir(), id);
        await mkdir(artifactDir, { recursive: true });
        const artifacts: YoloModelArtifacts = {};
        if (ev.artifacts.confusionMatrix) {
          await copyFile(ev.artifacts.confusionMatrix, join(artifactDir, 'confusion_matrix.png')).catch(() => {});
          artifacts.confusionMatrix = 'confusion_matrix.png';
        }
        if (ev.artifacts.prCurve) {
          await copyFile(ev.artifacts.prCurve, join(artifactDir, 'pr_curve.png')).catch(() => {});
          artifacts.prCurve = 'pr_curve.png';
        }
        if (Object.keys(artifacts).length > 0) model.artifacts = artifacts;
      }
      index.models.push(model);
      await saveYoloIndex(index);
      broadcastEvent({ t: 'log', level: 'info', message: `模型已保存：${model.name}` });
    } catch (err) {
      console.warn('[yolo] register model failed', err);
      broadcastEvent({ t: 'log', level: 'error', message: `保存训练产物失败：${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // ===== 数据集 =====
  ipcMain.handle('yolo:listDatasets', async (): Promise<YoloDataset[]> => {
    const index = await loadYoloIndex();
    const out: YoloDataset[] = [];
    for (const ds of index.datasets) {
      const counts = await countDataset(ds.id);
      out.push({ ...ds, ...counts });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  });

  ipcMain.handle('yolo:createDataset', async (_event, payload: { name: string; notes?: string }): Promise<YoloDataset> => {
    const id = randomUUID();
    const now = Date.now();
    const ds: YoloDataset = {
      id,
      name: payload.name.trim(),
      notes: payload.notes?.trim() || undefined,
      imageCount: 0,
      annotatedCount: 0,
      classCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await saveDatasetFile(id, { classes: [], images: [], annotations: {} });
    const index = await loadYoloIndex();
    index.datasets.push(ds);
    await saveYoloIndex(index);
    return ds;
  });

  ipcMain.handle('yolo:updateDataset', async (_event, id: string, patch: { name?: string; notes?: string }): Promise<YoloDataset> => {
    const index = await loadYoloIndex();
    const ds = index.datasets.find((d) => d.id === id);
    if (!ds) throw new Error('数据集不存在');
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error('名称不能为空');
      ds.name = name;
    }
    if (patch.notes !== undefined) ds.notes = patch.notes?.trim() || undefined;
    ds.updatedAt = Date.now();
    await saveYoloIndex(index);
    return { ...ds };
  });

  ipcMain.handle('yolo:removeDataset', async (_event, id: string): Promise<void> => {
    const index = await loadYoloIndex();
    index.datasets = index.datasets.filter((d) => d.id !== id);
    for (const model of index.models.filter((m) => m.datasetId === id)) {
      await unlink(join(yoloModelsDir(), model.file)).catch(() => {});
    }
    index.models = index.models.filter((m) => m.datasetId !== id);
    await saveYoloIndex(index);
    await rm(join(yoloDatasetsDir(), id), { recursive: true, force: true });
  });

  ipcMain.handle(
    'yolo:importImages',
    async (
      _event,
      datasetId: string,
      files: { name: string; dataUrl: string; width: number; height: number }[],
    ): Promise<number> => {
      const data = await loadDatasetFile(datasetId);
      await mkdir(datasetImagesDir(datasetId), { recursive: true });
      let added = 0;
      for (const file of files) {
        const id = randomUUID();
        const { buffer, ext } = dataUrlToFileData(file.dataUrl);
        const stored = `${id}.${ext}`;
        await writeFile(join(datasetImagesDir(datasetId), stored), buffer);
        data.images.push({
          id,
          fileName: file.name,
          file: stored,
          width: file.width || 0,
          height: file.height || 0,
          createdAt: Date.now(),
        });
        added++;
      }
      await saveDatasetFile(datasetId, data);
      const index = await loadYoloIndex();
      const ds = index.datasets.find((d) => d.id === datasetId);
      if (ds) ds.updatedAt = Date.now();
      await saveYoloIndex(index);
      return added;
    },
  );

  ipcMain.handle('yolo:listImages', async (_event, datasetId: string): Promise<YoloImage[]> => {
    const data = await loadDatasetFile(datasetId);
    return [...data.images].sort((a, b) => a.createdAt - b.createdAt);
  });

  ipcMain.handle('yolo:removeImage', async (_event, datasetId: string, imageId: string): Promise<void> => {
    const data = await loadDatasetFile(datasetId);
    const image = data.images.find((img) => img.id === imageId);
    if (image) {
      await unlink(join(datasetImagesDir(datasetId), image.file)).catch(() => {});
    }
    data.images = data.images.filter((img) => img.id !== imageId);
    delete data.annotations[imageId];
    await saveDatasetFile(datasetId, data);
  });

  ipcMain.handle('yolo:getImage', async (_event, datasetId: string, imageId: string): Promise<string | null> => {
    return readDatasetImage(datasetId, imageId);
  });

  ipcMain.handle('yolo:getAnnotations', async (_event, datasetId: string): Promise<Record<string, YoloAnnotation[]>> => {
    const data = await loadDatasetFile(datasetId);
    return data.annotations;
  });

  // ===== 类别与标注 =====
  ipcMain.handle('yolo:listClasses', async (_event, datasetId: string): Promise<YoloClassDefinition[]> => {
    const data = await loadDatasetFile(datasetId);
    return data.classes;
  });

  ipcMain.handle('yolo:createClass', async (_event, datasetId: string, payload: { name: string }): Promise<YoloClassDefinition> => {
    const data = await loadDatasetFile(datasetId);
    const cls: YoloClassDefinition = {
      id: randomUUID(),
      name: payload.name.trim(),
      color: YOLO_CLASS_COLORS[data.classes.length % YOLO_CLASS_COLORS.length],
    };
    data.classes.push(cls);
    await saveDatasetFile(datasetId, data);
    return cls;
  });

  ipcMain.handle('yolo:removeClass', async (_event, datasetId: string, classId: string): Promise<void> => {
    const data = await loadDatasetFile(datasetId);
    data.classes = data.classes.filter((c) => c.id !== classId);
    for (const imageId of Object.keys(data.annotations)) {
      data.annotations[imageId] = data.annotations[imageId].filter((a) => a.classId !== classId);
    }
    await saveDatasetFile(datasetId, data);
  });

  ipcMain.handle(
    'yolo:saveAnnotations',
    async (_event, datasetId: string, imageId: string, annotations: YoloAnnotation[]): Promise<void> => {
      const data = await loadDatasetFile(datasetId);
      if (!data.images.some((img) => img.id === imageId)) return;
      data.annotations[imageId] = annotations;
      await saveDatasetFile(datasetId, data);
      const index = await loadYoloIndex();
      const ds = index.datasets.find((d) => d.id === datasetId);
      if (ds) ds.updatedAt = Date.now();
      await saveYoloIndex(index);
    },
  );

  ipcMain.handle('yolo:exportDataset', async (_event, datasetId: string): Promise<{ path: string }> => {
    await writeYoloExport(datasetId, 0.9, 0);
    const dir = datasetExportDir(datasetId);
    await shell.openPath(dir);
    return { path: dir };
  });

  // ===== 模型 =====
  ipcMain.handle('yolo:listModels', async (): Promise<YoloModel[]> => {
    const index = await loadYoloIndex();
    return [...index.models]
      .map((model) => ({
        ...model,
        path: join(yoloModelsDir(), model.file),
        artifactPaths: model.artifacts
          ? {
              confusionMatrix: model.artifacts.confusionMatrix ? join(yoloModelsDir(), model.id, model.artifacts.confusionMatrix) : undefined,
              prCurve: model.artifacts.prCurve ? join(yoloModelsDir(), model.id, model.artifacts.prCurve) : undefined,
            }
          : null,
      }))
      .sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return b.createdAt - a.createdAt;
      });
  });

  ipcMain.handle('yolo:getActiveModel', async (): Promise<YoloModel | null> => {
    const index = await loadYoloIndex();
    const model = index.models.find((m) => m.isActive);
    if (!model) return null;
    return {
      ...model,
      path: join(yoloModelsDir(), model.file),
      artifactPaths: model.artifacts
        ? {
            confusionMatrix: model.artifacts.confusionMatrix ? join(yoloModelsDir(), model.id, model.artifacts.confusionMatrix) : undefined,
            prCurve: model.artifacts.prCurve ? join(yoloModelsDir(), model.id, model.artifacts.prCurve) : undefined,
          }
        : null,
    };
  });

  ipcMain.handle('yolo:getModelArtifact', async (_event, id: string, kind: 'confusionMatrix' | 'prCurve'): Promise<string | null> => {
    const index = await loadYoloIndex();
    const model = index.models.find((m) => m.id === id);
    const relative = model?.artifacts?.[kind];
    if (!relative) return null;
    try {
      const buffer = await readFile(join(yoloModelsDir(), id, relative));
      return `data:image/png;base64,${buffer.toString('base64')}`;
    } catch {
      return null;
    }
  });

  ipcMain.handle('yolo:exportModel', async (_event, id: string, format: 'onnx' | 'tflite' | 'openvino', imageSize: number): Promise<{ started: boolean; message?: string }> => {
    if (exportChild) return { started: false, message: '已有导出任务正在进行中' };
    const index = await loadYoloIndex();
    const model = index.models.find((m) => m.id === id);
    if (!model) return { started: false, message: '模型不存在' };
    const cmd = pythonCommand();
    const runDir = join(yoloRunsDir(), `export-${Date.now()}`);
    await mkdir(runDir, { recursive: true });
    const enginePath = join(runDir, 'engine.py');
    const configPath = join(runDir, 'config.json');
    await writeFile(enginePath, YOLO_ENGINE_SOURCE, 'utf8');
    await writeFile(configPath, JSON.stringify({ modelPath: join(yoloModelsDir(), model.file), format, imageSize }), 'utf8');
    const child = spawn(cmd, [enginePath, 'export', join(yoloModelsDir(), model.file), format, String(imageSize)], { stdio: ['ignore', 'pipe', 'pipe'] });
    exportChild = child;
    const onData = (chunk: unknown) => {
      for (const line of String(chunk).split('\n')) {
        const cleaned = sanitizeLogLine(line);
        if (cleaned) broadcastEvent({ t: 'log', level: 'info', message: cleaned });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      broadcastEvent({ t: 'log', level: 'error', message: `导出启动失败：${err.message}` });
      exportChild = null;
    });
    child.on('close', (code) => {
      broadcastEvent({ t: 'log', level: code === 0 ? 'info' : 'error', message: code === 0 ? `模型已导出为 ${format.toUpperCase()}` : `模型导出失败，退出码 ${code}` });
      exportChild = null;
    });
    return { started: true };
  });

  ipcMain.handle('yolo:removeModel', async (_event, id: string): Promise<void> => {
    const index = await loadYoloIndex();
    const model = index.models.find((m) => m.id === id);
    if (!model) return;
    await unlink(join(yoloModelsDir(), model.file)).catch(() => {});
    await rm(join(yoloModelsDir(), id), { recursive: true, force: true });
    index.models = index.models.filter((m) => m.id !== id);
    await saveYoloIndex(index);
  });

  ipcMain.handle('yolo:setActiveModel', async (_event, id: string): Promise<void> => {
    const index = await loadYoloIndex();
    for (const m of index.models) m.isActive = m.id === id;
    await saveYoloIndex(index);
  });

  // ===== 环境检测与依赖包 =====
  ipcMain.handle('yolo:getEnvInfo', async (): Promise<YoloEnvInfo> => {
    const cmd = pythonCommand();
    const probe = [
      'import sys, json;',
      'out={"python": sys.executable, "pythonVersion": sys.version.split()[0]};',
      'try:',
      '  import ultralytics; out["ultralytics"]=getattr(ultralytics,"__version__","?");',
      'except Exception: out["ultralytics"]=None;',
      'try:',
      '  import torch; out["torch"]=torch.__version__;',
      '  out["cuda"]=bool(torch.cuda.is_available());',
      '  mps=getattr(torch.backends,"mps",None);',
      '  out["mps"]=bool(mps is not None and mps.is_available());',
      'except Exception: out["torch"]=None; out["cuda"]=False; out["mps"]=False;',
      'print(json.dumps(out))',
    ].join(' ');
    const res = await runCaptured(cmd, ['-c', probe], 15000);
    const info: YoloEnvInfo = {
      pythonAvailable: false,
      pythonPath: null,
      pythonVersion: null,
      ultralytics: null,
      torch: null,
      cuda: false,
      mps: false,
      device: 'none',
    };
    if (res.code !== 0 || !res.stdout.trim()) {
      if (res.stderr.trim()) console.warn('[yolo] env probe:', res.stderr.trim().slice(0, 300));
      return info;
    }
    try {
      const parsed = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
      info.pythonAvailable = true;
      info.pythonPath = typeof parsed.python === 'string' ? parsed.python : null;
      info.pythonVersion = typeof parsed.pythonVersion === 'string' ? parsed.pythonVersion : null;
      info.ultralytics = typeof parsed.ultralytics === 'string' ? parsed.ultralytics : null;
      info.torch = typeof parsed.torch === 'string' ? parsed.torch : null;
      info.cuda = Boolean(parsed.cuda);
      info.mps = Boolean(parsed.mps);
      info.device = info.cuda ? 'cuda' : info.mps ? 'mps' : 'cpu';
      return info;
    } catch {
      return info;
    }
  });

  ipcMain.handle('yolo:installPackage', async (_event, packageName: string): Promise<{ started: boolean }> => {
    if (packageChild) return { started: false };
    const broadcastPackage = (ev: YoloTrainingEvent) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('yolo:packageOutput', ev);
      }
    };
    const cmd = pythonCommand();
    const child = spawn(cmd, ['-m', 'pip', 'install', '-U', packageName], { stdio: ['ignore', 'pipe', 'pipe'] });
    packageChild = child;
    const onData = (level: 'info' | 'warn', chunk: unknown) => {
      for (const line of String(chunk).split('\n')) {
        const cleaned = sanitizeLogLine(line);
        if (cleaned) broadcastPackage({ t: 'log', level, message: cleaned });
      }
    };
    child.stdout?.on('data', (chunk) => onData('info', chunk));
    child.stderr?.on('data', (chunk) => onData('warn', chunk));
    child.on('error', (err) => {
      broadcastPackage({ t: 'log', level: 'error', message: `pip 启动失败：${err.message}` });
      packageChild = null;
    });
    child.on('close', (code) => {
      broadcastPackage({
        t: 'log',
        level: code === 0 ? 'info' : 'warn',
        message: code === 0 ? '安装完成 ✓' : `pip 退出，退出码 ${code}`,
      });
      packageChild = null;
    });
    return { started: true };
  });

  // ===== 训练 =====
  ipcMain.handle(
    'yolo:startTraining',
    async (_event, cfg: YoloTrainConfig, datasetId: string): Promise<{ started: boolean; message?: string }> => {
      if (trainingChild) return { started: false, message: '已有训练任务正在进行' };
      const cmd = pythonCommand();
      const probe = await runCaptured(cmd, ['--version'], 8000);
      if (probe.code !== 0) {
        return { started: false, message: `未检测到 Python（${cmd}），请先安装 Python 3.8+，或在「环境」页查看依赖状态` };
      }
      try {
        const index = await loadYoloIndex();
        const ds = index.datasets.find((d) => d.id === datasetId);
        if (!ds) return { started: false, message: '数据集不存在' };

        const jobId = `run-${Date.now()}`;
        const yamlPath = await writeYoloExport(datasetId, cfg.splitTrain, cfg.seed);
        const runDir = join(yoloRunsDir(), jobId);
        await rm(runDir, { recursive: true, force: true });
        await mkdir(runDir, { recursive: true });

        const enginePath = join(runDir, 'engine.py');
        await writeFile(enginePath, YOLO_ENGINE_SOURCE, 'utf8');
        const configPath = join(runDir, 'config.json');
        await writeFile(
          configPath,
          JSON.stringify({ ...cfg, dataYaml: yamlPath, projectDir: yoloRunsDir(), runName: jobId }, null, 2),
          'utf8',
        );

        currentJobMeta = {
          jobId,
          datasetId: ds.id,
          datasetName: ds.name,
          baseModel: cfg.model,
          epochs: cfg.epochs,
          imageSize: cfg.imageSize,
          batch: cfg.batch,
        };
        trainingJobId = jobId;

        const child = spawn(cmd, [enginePath, configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
        trainingChild = child;
        let buffer = '';
        const pump = (chunk: unknown) => {
          buffer += String(chunk);
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) handleEngineLine(line);
        };
        child.stdout?.on('data', pump);
        child.stderr?.on('data', pump);
        child.on('error', (err) => {
          broadcastEvent({ t: 'log', level: 'error', message: `无法启动训练进程：${err.message}` });
          trainingChild = null;
          trainingJobId = null;
          currentJobMeta = null;
          broadcastTrainingState();
        });
        trainingChild.on('close', (code) => {
          if (buffer.trim()) handleEngineLine(buffer);
          buffer = '';
          if (code !== 0) {
            broadcastEvent({ t: 'log', level: 'warn', message: `训练进程退出，退出码 ${code}` });
          }
          trainingChild = null;
          trainingJobId = null;
          currentJobMeta = null;
          broadcastTrainingState();
        });        broadcastTrainingState();
        return { started: true };
      } catch (err) {
        return { started: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('yolo:stopTraining', async (): Promise<void> => {
    if (trainingChild) {
      trainingChild.kill();
      broadcastEvent({ t: 'log', level: 'warn', message: '用户手动停止训练' });
    }
  });
}

app.whenReady().then(() => {
  registerCloudApiIpc();
  registerStreamIpc();
  registerOcrIpc();
  registerTemplateIpc();
  registerYoloIpc();
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
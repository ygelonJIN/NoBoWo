import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { copyFile, link, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { connect as tcpConnect } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  CloudApiProfile,
  CloudApiVisionResult,
  EngineEnvInfo,
  EngineRunResult,
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
import { runVisionEngine, writeImageToTemp } from './engine';

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

  /** 从云 API 响应中提取坐标：优先 JSON 的 x/y 字段，其次 OpenAI 风格 content 文本，最后正则 */
  const extractCoordsFrom = (parsed: unknown, text: string): { x: number; y: number } | null => {
    const pick = (value: unknown): { x: number; y: number } | null => {
      if (!value || typeof value !== 'object') return null;
      const record = value as Record<string, unknown>;
      if (typeof record.x === 'number' && typeof record.y === 'number') {
        return { x: record.x, y: record.y };
      }
      if (record.coordinates && typeof record.coordinates === 'object') {
        const coords = record.coordinates as Record<string, unknown>;
        if (typeof coords.x === 'number' && typeof coords.y === 'number') return { x: coords.x, y: coords.y };
      }
      if (typeof record.content === 'string') {
        const matched = record.content.match(/(?:x|X)\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*[,，;]\s*(?:y|Y)\s*[:=]\s*(-?\d+(?:\.\d+)?)/);
        if (matched) return { x: Number(matched[1]), y: Number(matched[2]) };
        const parenthesized = record.content.match(/\((-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*\)/);
        if (parenthesized) return { x: Number(parenthesized[1]), y: Number(parenthesized[2]) };
      }
      return null;
    };
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const found = pick(item);
        if (found) return found;
      }
      return null;
    }
    const root = parsed as Record<string, unknown> | null;
    const candidates = [root, root?.result, root?.data, root?.output];
    for (const candidate of candidates) {
      const found = pick(candidate);
      if (found) return found;
    }
    const raw = text.match(/(?:x|X)\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*[,，;]\s*(?:y|Y)\s*[:=]\s*(-?\d+(?:\.\d+)?)/);
    return raw ? { x: Number(raw[1]), y: Number(raw[2]) } : null;
  };

  ipcMain.handle(
    'cloudApi:vision',
    async (_event, payload: { imageDataUrl: string; profileId: string; prompt?: string }): Promise<CloudApiVisionResult> => {
      const index = await loadCloudApiIndex();
      const profile = index.profiles.find((item) => item.id === payload.profileId);
      if (!profile) return { ok: false, message: '找不到 API 配置，请先在「云端 API」中创建' };
      const baseUrl = profile.baseUrl.trim().replace(/\/+$/, '');
      if (!baseUrl) return { ok: false, message: 'API 地址为空' };
      const prompt = payload.prompt?.trim() || profile.defaultPrompt || '分析这张截图，返回目标位置的 x、y 坐标（JSON 格式 {"x":..,"y":..}）。';
      try {
        const response = await fetch(baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}),
          },
          body: JSON.stringify({ prompt, image: payload.imageDataUrl }),
        });
        const text = await response.text();
        if (!response.ok) {
          return { ok: false, message: `服务端返回 HTTP ${response.status}`, raw: text.slice(0, 500) };
        }
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // 非 JSON，按纯文本处理
        }
        const coords = extractCoordsFrom(parsed, text);
        if (coords) {
          return { ok: true, x: coords.x, y: coords.y, raw: text.slice(0, 2000), message: '已解析出坐标' };
        }
        return { ok: false, message: '未能从响应中解析出坐标', raw: text.slice(0, 2000) };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
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
      payload: { source: 'screen' | 'window' | 'stream'; streamSourceId?: string; windowHint?: string },
    ): Promise<StreamScreenshotResult> => {
      const thumbnailSize = { width: 1920, height: 1080 };
      const captureWindowByHint = async (hintText?: string, label = '串流窗口') => {
        const sources = await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize,
          fetchWindowIcons: false,
        });
        const hint = hintText?.trim().toLowerCase();
        const windowSource = (hint ? sources.find((item) => item.name.toLowerCase().includes(hint)) : undefined)
          ?? sources.find((item) => !item.name.startsWith('NoBoWo'));
        if (!windowSource || windowSource.thumbnail.isEmpty()) {
          return { ok: false as const, message: `未找到${label}，请确认窗口已打开、macOS 屏幕录制权限已授权` };
        }
        const size = windowSource.thumbnail.getSize();
        return { ok: true as const, frame: windowSource.thumbnail.toDataURL(), width: size.width, height: size.height };
      };
      const captureScreen = async () => {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize,
          fetchWindowIcons: false,
        });
        const screenSource = sources[0];
        if (!screenSource || screenSource.thumbnail.isEmpty()) {
          return { ok: false as const, message: '无法截取本机屏幕，请确认屏幕录制权限已授权' };
        }
        const size = screenSource.thumbnail.getSize();
        return { ok: true as const, frame: screenSource.thumbnail.toDataURL(), width: size.width, height: size.height };
      };
      try {
        if (payload.source === 'window') {
          return await captureWindowByHint(payload.windowHint, '目标窗口');
        }
        if (payload.source === 'stream') {
          const index = await loadStreamSources();
          const profile = index.sources.find((source) => source.id === payload.streamSourceId);
          if (!profile) {
            return { ok: false, message: '找不到串流设备配置，请在「串流设备」中先创建并保存设备' };
          }
          if (profile.type === 'local') {
            return profile.windowHint?.trim()
              ? await captureWindowByHint(profile.windowHint, '本机窗口')
              : await captureScreen();
          }
          return await captureWindowByHint(profile.windowHint, '串流窗口');
        }
        return await captureScreen();
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

// ===== YOLO 训练模块（YOLOX 引擎） =====

const YOLO_ENGINE_SOURCE = String.raw`#!/usr/bin/env python3
# NoBoWo YOLOX 训练引擎 —— 向 stdout 输出结构化 JSON 事件
import json
import os
import sys
import traceback
from types import SimpleNamespace

try:
    import torch
except Exception as exc:
    print(json.dumps({"t": "error", "message": "无法加载 PyTorch：" + str(exc) + "\n请先在「环境」页安装依赖。"}, ensure_ascii=False), flush=True)
    sys.exit(1)


def emit(**kw):
    payload = {"t": kw.pop("t", "log"), **kw}
    try:
        print(json.dumps(payload, ensure_ascii=False), flush=True)
    except Exception:
        pass


def setup_yolox(cfg):
    yolox_path = cfg.get("yoloxPath")
    if yolox_path and os.path.isdir(yolox_path):
        sys.path.insert(0, yolox_path)
    try:
        import yolox  # noqa: F401
        return yolox
    except Exception as exc:
        emit(t="error", message="无法加载 YOLOX：" + str(exc) + "\n请先在「环境」页确认 YOLOX 源码路径与依赖是否安装。")
        return None


def pick_device(cfg):
    device = str(cfg.get("device", "auto"))
    if device == "auto":
        if torch.cuda.is_available():
            return "cuda:0"
        mps = getattr(torch.backends, "mps", None)
        if mps is not None and mps.is_available():
            return "mps"
        return "cpu"
    if device.startswith("cuda"):
        if not torch.cuda.is_available():
            emit(t="log", level="warn", message="未检测到 CUDA，回退到 CPU")
            return "cpu"
        return device
    if device == "mps":
        mps = getattr(torch.backends, "mps", None)
        if mps is None or not mps.is_available():
            emit(t="log", level="warn", message="MPS 不可用，回退到 CPU")
            return "cpu"
        return "mps"
    return device


def build_exp(cfg):
    from yolox.exp import get_exp

    base = str(cfg.get("model", "yolox_s"))
    exp = get_exp(None, base)
    aug = cfg.get("augment", {})
    imgsz = int(cfg["imageSize"])
    epochs = int(cfg["epochs"])

    exp.exp_name = cfg["runName"]
    exp.num_classes = int(cfg["numClasses"])
    exp.input_size = (imgsz, imgsz)
    exp.test_size = (imgsz, imgsz)
    exp.max_epoch = epochs
    exp.basic_lr_per_img = float(cfg.get("lr0", 0.01)) / 64.0
    exp.min_lr_ratio = float(cfg.get("lrf", 0.01))
    exp.momentum = float(cfg.get("momentum", 0.9))
    exp.weight_decay = float(cfg.get("weightDecay", 0.0005))
    exp.warmup_epochs = float(cfg.get("warmupEpochs", 5))
    exp.patience = int(cfg.get("patience", 20))
    exp.data_num_workers = int(cfg.get("workers", 4))
    exp.seed = int(cfg.get("seed", 0))
    exp.print_interval = 10
    exp.eval_interval = 1
    exp.save_history_ckpt = False
    exp.no_aug_epochs = min(15, max(1, int(epochs * 0.1)))
    exp.ema = True

    # 数据增强（ultralytics 参数名 -> YOLOX Exp 字段）
    exp.flip_prob = float(aug.get("fliplr", 0.5))
    exp.degrees = float(aug.get("degrees", 0.0))
    exp.translate = float(aug.get("translate", 0.1))
    exp.shear = float(aug.get("shear", 0.0))
    exp.mosaic_prob = float(aug.get("mosaic", 1.0))
    exp.mixup_prob = float(aug.get("mixup", 0.0))
    exp.enable_mixup = exp.mixup_prob > 0
    exp.hsv_prob = 1.0
    exp.mosaic_scale = (0.1, 2)
    exp.mixup_scale = (0.5, 1.5)
    exp.multiscale_range = 5

    # 数据集（COCO 格式，由导出器生成）
    data_dir = cfg["dataDir"]
    exp.data_dir = data_dir
    exp.train_ann = "instances_train.json"
    exp.val_ann = "instances_val.json"
    exp.test_ann = "instances_val.json"
    exp.train_image_set = "split/images/train"
    exp.val_image_set = "split/images/val"

    from yolox.data import COCODataset, TrainTransform, ValTransform

    def make_dataset(json_file, image_set, img_size, transform, cache=False, cache_type="ram"):
        return COCODataset(
            data_dir=data_dir,
            json_file=json_file,
            name=image_set,
            img_size=img_size,
            preproc=transform,
            cache=cache,
            cache_type=cache_type,
        )

    def get_dataset(self, cache=False, cache_type="ram"):
        return make_dataset(
            self.train_ann, self.train_image_set, self.input_size,
            TrainTransform(max_labels=50, flip_prob=self.flip_prob, hsv_prob=self.hsv_prob),
            cache=cache, cache_type=cache_type,
        )

    def get_eval_dataset(self, **kwargs):
        return make_dataset(
            self.val_ann, self.val_image_set, self.test_size,
            ValTransform(legacy=kwargs.get("legacy", False)),
        )

    def get_evaluator(self, batch_size, is_distributed, testdev=False, legacy=False):
        return PlainEvaluator(
            dataloader=self.get_eval_loader(batch_size, is_distributed, testdev=testdev, legacy=legacy),
            img_size=self.test_size,
            confthre=self.test_conf,
            nmsthre=self.nmsthre,
            num_classes=self.num_classes,
            testdev=testdev,
        )

    exp.get_dataset = get_dataset.__get__(exp, type(exp))
    exp.get_eval_dataset = get_eval_dataset.__get__(exp, type(exp))
    exp.get_evaluator = get_evaluator.__get__(exp, type(exp))
    exp.output_dir = cfg["projectDir"]
    return exp


class PlainPrefetcher:
    """设备无关的预取器（YOLOX 自带 DataPrefetcher 仅支持 CUDA）。"""

    def __init__(self, loader, device):
        self.loader = iter(loader)
        self.device = device
        self.next_batch = None
        self.preload()

    def preload(self):
        try:
            self.next_batch = next(self.loader)
        except StopIteration:
            self.next_batch = None

    def next(self):
        batch = self.next_batch
        self.preload()
        if batch is None:
            return None, None
        inps, targets, _, _ = batch
        return inps.to(self.device), targets.to(self.device)


class PlainEvaluator:
    """设备无关的 COCO 评估器（CPU / MPS / CUDA 通用）。"""

    def __init__(self, dataloader, img_size, confthre, nmsthre, num_classes, testdev=False):
        self.dataloader = dataloader
        self.img_size = img_size
        self.confthre = confthre
        self.nmsthre = nmsthre
        self.num_classes = num_classes
        self.testdev = testdev
        self.coco = dataloader.dataset.coco
        self.class_ids = dataloader.dataset.class_ids
        self._coco_eval = None

    def evaluate(self, model, distributed=False, half=False, trt_file=None, decoder=None, test_size=None, return_outputs=False):
        from yolox.utils import postprocess

        model = model.eval()
        device = next(model.parameters()).device
        if half and str(device).startswith("cuda"):
            model = model.half()

        data_list = []
        with torch.no_grad():
            for imgs, _, info_imgs, img_ids in self.dataloader:
                imgs = imgs.to(device)
                outputs = model(imgs)
                if decoder is not None:
                    outputs = decoder(outputs, dtype=outputs.type())
                outputs = postprocess(outputs, self.num_classes, self.confthre, self.nmsthre)
                for output, img_h, img_w, img_id in zip(outputs, info_imgs[0], info_imgs[1], img_ids):
                    if output is None:
                        continue
                    output = output.cpu()
                    bboxes = output[:, 0:4].clone()
                    scale = min(self.img_size[0] / float(img_h), self.img_size[1] / float(img_w))
                    bboxes /= scale
                    cls = output[:, 6]
                    scores = output[:, 4] * output[:, 5]
                    bboxes[:, 2:] -= bboxes[:, :2]  # xyxy -> xywh
                    for ind in range(bboxes.shape[0]):
                        label = self.class_ids[int(cls[ind])]
                        data_list.append({
                            "image_id": int(img_id),
                            "category_id": label,
                            "bbox": bboxes[ind].tolist(),
                            "score": float(scores[ind]),
                            "segmentation": [],
                        })

        if len(data_list) == 0:
            self._coco_eval = None
            return 0, 0, "验证集无检测结果。"

        import io
        import json
        import tempfile
        import contextlib

        try:
            from yolox.layers import COCOeval_opt as COCOeval
        except Exception:
            from pycocotools.cocoeval import COCOeval

        _, tmp = tempfile.mkstemp()
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data_list, f)
        coco_dt = self.coco.loadRes(tmp)
        coco_eval = COCOeval(self.coco, coco_dt, "bbox")
        coco_eval.evaluate()
        coco_eval.accumulate()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            coco_eval.summarize()
        self._coco_eval = coco_eval
        return coco_eval.stats[0], coco_eval.stats[1], buf.getvalue()


class EarlyStop(Exception):
    pass


def run_training(cfg):
    yolox = setup_yolox(cfg)
    if yolox is None:
        return 1

    from yolox.core.trainer import Trainer
    from yolox.utils import get_model_info, ModelEMA, adjust_status, all_reduce_norm, is_parallel
    from torch.nn.parallel import DistributedDataParallel as DDP

    class NoBoWoTrainer(Trainer):
        def __init__(self, exp, args, device="cpu"):
            super().__init__(exp, args)
            self.device = device
            self._loss_sum = {}
            self._loss_count = 0
            self._best_epoch = 0
            self._best_metrics = None
            self._last_metrics = None

        def before_train(self):
            from loguru import logger
            logger.info("args: {}".format(self.args))
            logger.info("exp value:\n{}".format(self.exp))
            if self.device.startswith("cuda"):
                torch.cuda.set_device(self.local_rank)
            model = self.exp.get_model()
            logger.info("Model Summary: {}".format(get_model_info(model, self.exp.test_size)))
            model.to(self.device)
            self.optimizer = self.exp.get_optimizer(self.args.batch_size)
            model = self.resume_train(model)
            self.no_aug = self.start_epoch >= self.max_epoch - self.exp.no_aug_epochs
            self.train_loader = self.exp.get_data_loader(
                batch_size=self.args.batch_size,
                is_distributed=self.is_distributed,
                no_aug=self.no_aug,
                cache_img=self.args.cache,
            )
            logger.info("init prefetcher, this might take one minute or less...")
            self.prefetcher = PlainPrefetcher(self.train_loader, self.device)
            self.max_iter = len(self.train_loader)
            self.lr_scheduler = self.exp.get_lr_scheduler(
                self.exp.basic_lr_per_img * self.args.batch_size, self.max_iter
            )
            if self.is_distributed:
                model = DDP(model, device_ids=[self.local_rank], broadcast_buffers=False)
            if self.use_model_ema:
                self.ema_model = ModelEMA(model, 0.9998)
                self.ema_model.updates = self.max_iter * self.start_epoch
            self.model = model
            self.evaluator = self.exp.get_evaluator(
                batch_size=self.args.batch_size, is_distributed=self.is_distributed
            )
            logger.info("Training start...")

        def train(self):
            from loguru import logger
            self.before_train()
            try:
                self.train_in_epoch()
            except EarlyStop:
                logger.info("Training stopped by early stopping")
            except Exception as e:
                logger.error("Exception in training: {}".format(e))
                raise
            finally:
                self.after_train()

        def after_iter(self):
            loss_meter = self.meter.get_filtered_meter("loss")
            for k, v in loss_meter.items():
                self._loss_sum[k] = self._loss_sum.get(k, 0.0) + float(v.latest)
            self._loss_count += 1

            if (self.iter + 1) % self.exp.print_interval == 0:
                total = max(1, int(self.exp.max_epoch))
                done = (self.epoch + (self.iter + 1) / max(1, self.max_iter)) / total
                emit(
                    t="progress",
                    epoch=self.epoch + 1,
                    percent=round(min(100.0, max(0.0, done * 100)), 1),
                    message="epoch {}/{} · batch {}/{}".format(
                        self.epoch + 1, total, self.iter + 1, self.max_iter
                    ),
                )

            if (self.progress_in_iter + 1) % 10 == 0:
                self.input_size = self._random_resize()

        def _random_resize(self):
            import random as _random
            exp = self.exp
            size_factor = exp.input_size[1] * 1.0 / exp.input_size[0]
            if not hasattr(exp, "random_size"):
                min_size = int(exp.input_size[0] / 32) - exp.multiscale_range
                max_size = int(exp.input_size[0] / 32) + exp.multiscale_range
                exp.random_size = (min_size, max_size)
            size = _random.randint(*exp.random_size)
            return (int(32 * size), 32 * int(size * size_factor))

        def after_epoch(self):
            self.save_ckpt(ckpt_name="latest")

            losses = {}
            for k, v in self._loss_sum.items():
                losses[k] = v / max(1, self._loss_count)
            self._loss_sum = {}
            self._loss_count = 0

            lr = float(self.optimizer.param_groups[0]["lr"])
            emit(
                t="epoch",
                epoch=self.epoch + 1,
                totalEpochs=self.max_epoch,
                lr=lr,
                metrics=self._build_metrics(losses),
            )

            if (self.epoch + 1) % self.exp.eval_interval == 0:
                all_reduce_norm(self.model)
                self.evaluate_and_save_model()

        def _build_metrics(self, losses):
            prev = self._last_metrics
            return {
                "boxLoss": round(float(losses.get("iou_loss", 0.0)), 4),
                "clsLoss": round(float(losses.get("cls_loss", 0.0)), 4),
                "dflLoss": round(float(losses.get("l1_loss", 0.0)), 4),
                "precision": (prev or {}).get("precision", 0.0),
                "recall": (prev or {}).get("recall", 0.0),
                "mAP50": (prev or {}).get("mAP50", 0.0),
                "mAP50_95": (prev or {}).get("mAP50_95", 0.0),
            }

        def evaluate_and_save_model(self):
            if self.use_model_ema:
                evalmodel = self.ema_model.ema
            else:
                evalmodel = self.model
                if is_parallel(evalmodel):
                    evalmodel = evalmodel.module

            with adjust_status(evalmodel, training=False):
                ap50_95, ap50, summary = self.exp.eval(
                    evalmodel, self.evaluator, self.is_distributed, return_outputs=False
                )

            update_best = ap50_95 > self.best_ap
            self.best_ap = max(self.best_ap, ap50_95)
            if update_best:
                self._best_epoch = self.epoch + 1

            metrics = self._eval_metrics()
            metrics["mAP50"] = round(float(ap50) * 100, 2)
            metrics["mAP50_95"] = round(float(ap50_95) * 100, 2)
            self._last_metrics = metrics
            if update_best:
                self._best_metrics = dict(metrics)

            emit(
                t="log",
                level="info",
                message="Eval @ epoch {} · mAP50 {}% · mAP50-95 {}% · precision {}% · recall {}%".format(
                    self.epoch + 1, metrics["mAP50"], metrics["mAP50_95"], metrics["precision"], metrics["recall"]
                ),
            )

            self.save_ckpt("last_epoch", update_best, ap=ap50_95)

            patience = int(getattr(self.exp, "patience", 0) or 0)
            if patience > 0 and (self.epoch + 1 - self._best_epoch) >= patience:
                from loguru import logger
                logger.info("Early stop triggered at epoch {} (no improvement for {} epochs)".format(self.epoch + 1, patience))
                raise EarlyStop()

        def _eval_metrics(self):
            ce = getattr(self.evaluator, "_coco_eval", None)
            if ce is None or ce.eval is None:
                return {"precision": 0.0, "recall": 0.0}
            prec = ce.eval["precision"]  # [T, R, K, A, M]
            rec = ce.eval["recall"]      # [T, K, A, M]
            p = prec[5, :, :, 0, -1]
            p = p[p > -1]
            precision = round(float(p.mean()) * 100, 2) if p.size else 0.0
            r = rec[:, :, 0, -1]
            r = r[r > -1]
            recall = round(float(r.mean()) * 100, 2) if r.size else 0.0
            return {"precision": precision, "recall": recall}

        def after_train(self):
            from loguru import logger
            logger.info("Training done, best AP50-95: {:.2f}".format(self.best_ap * 100))
            best_path = os.path.join(self.file_name, "best_ckpt.pth")
            if not os.path.exists(best_path):
                best_path = os.path.join(self.file_name, "latest_ckpt.pth")
            if not os.path.exists(best_path):
                emit(t="error", message="训练结束但未找到 checkpoint：" + best_path)
                return
            m = self._best_metrics or self._last_metrics
            metrics = None
            if m:
                metrics = {
                    "precision": m.get("precision", 0.0),
                    "recall": m.get("recall", 0.0),
                    "mAP50": m.get("mAP50", 0.0),
                    "mAP50_95": m.get("mAP50_95", 0.0),
                }
            emit(
                t="done",
                modelPath=best_path,
                sizeBytes=os.path.getsize(best_path),
                metrics=metrics,
                artifacts=None,
            )

    device = pick_device(cfg)
    emit(t="log", level="info", message="YOLOX " + str(getattr(yolox, "__version__", "?")) + " 已就绪 · 设备 " + device)

    total_epochs = int(cfg["epochs"])
    emit(t="start", jobId=cfg["runName"], totalEpochs=total_epochs, message="训练已启动（YOLOX）")

    try:
        exp = build_exp(cfg)
        args = SimpleNamespace(
            experiment_name=cfg["runName"],
            fp16=False,
            batch_size=int(cfg["batch"]),
            resume=False,
            ckpt=cfg.get("ckptPath") or None,
            start_epoch=None,
            cache=None,
            occupy=False,
            logger="",
            exp_file=None,
            name=str(cfg.get("model", "yolox_s")),
        )
        trainer = NoBoWoTrainer(exp, args, device=device)
        trainer.train()
        return 0
    except Exception:
        emit(t="error", message=traceback.format_exc())
        return 1


def run_export(cfg):
    yolox = setup_yolox(cfg)
    if yolox is None:
        return 1
    fmt = str(cfg.get("format", "onnx"))
    imgsz = int(cfg.get("imageSize", 640))
    model_path = cfg["modelPath"]
    try:
        if fmt == "tflite":
            emit(t="error", message="YOLOX 官方不支持 TFLite 导出。请导出 ONNX 后，用 onnx2tf / ai-edge-litert 等工具自行转换。")
            return 1
        if fmt == "openvino":
            emit(t="error", message="YOLOX 官方不支持 OpenVINO 导出。请导出 ONNX 后，用 OpenVINO 工具链（mo）自行转换。")
            return 1
        return run_onnx(cfg, model_path, imgsz)
    except Exception:
        emit(t="error", message=traceback.format_exc())
        return 1


def run_onnx(cfg, model_path, imgsz):
    from yolox.exp import get_exp
    from yolox.models.network_blocks import SiLU
    from yolox.utils import replace_module
    from torch import nn

    base = str(cfg.get("baseModel", "yolox_s"))
    exp = get_exp(None, base)
    num_classes = int(cfg.get("numClasses") or exp.num_classes)
    exp.num_classes = num_classes
    exp.test_size = (imgsz, imgsz)

    model = exp.get_model()
    ckpt = torch.load(model_path, map_location="cpu")
    if "model" in ckpt:
        ckpt = ckpt["model"]
    model.load_state_dict(ckpt)
    model.eval()
    model = replace_module(model, nn.SiLU, SiLU)

    out_dir = os.path.dirname(model_path)
    out_name = os.path.join(out_dir, "yolox_{}x{}.onnx".format(imgsz, imgsz))
    dummy = torch.randn(1, 3, imgsz, imgsz)
    emit(t="log", level="info", message="开始导出 ONNX（{}x{}）…".format(imgsz, imgsz))
    torch.onnx.export(
        model,
        dummy,
        out_name,
        input_names=["images"],
        output_names=["output"],
        opset_version=11,
        dynamic_axes={"images": {0: "batch"}, "output": {0: "batch"}},
    )
    try:
        import onnx
        from onnxsim import simplify
        onnx_model = onnx.load(out_name)
        model_simp, check = simplify(onnx_model)
        if check:
            onnx.save(model_simp, out_name)
    except Exception as exc:
        emit(t="log", level="warn", message="onnx-simplifier 未安装，跳过精简：" + str(exc))
    emit(t="log", level="info", message="导出完成：" + out_name)
    emit(t="done", modelPath=out_name, sizeBytes=os.path.getsize(out_name), metrics=None)
    return 0


def main():
    if len(sys.argv) < 2:
        emit(t="error", message="缺少配置文件参数")
        return 2
    cfg_path = sys.argv[1]
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception as exc:
        emit(t="error", message="读取配置失败：" + str(exc))
        return 1

    if cfg.get("mode") == "export":
        return run_export(cfg)
    return run_training(cfg)


if __name__ == "__main__":
    try:
        from yolox.utils import configure_module
        configure_module()
    except Exception:
        pass
    sys.exit(main())
`;

const yoloRootDir = () => join(app.getPath('userData'), 'yolo');
const yoloDatasetsDir = () => join(yoloRootDir(), 'datasets');
const yoloModelsDir = () => join(yoloRootDir(), 'models');
const yoloRunsDir = () => join(yoloRootDir(), 'runs');
const yoloIndexFile = () => join(yoloRootDir(), 'index.json');
const yoloSettingsFile = () => join(yoloRootDir(), 'settings.json');
const yoloWeightsDir = () => join(yoloRootDir(), 'weights');

type YoloSettings = {
  /** YOLOX 源码目录（绝对路径） */
  yoloxPath: string | null;
};

async function loadYoloSettings(): Promise<YoloSettings> {
  try {
    const raw = await readFile(yoloSettingsFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<YoloSettings>;
    if (parsed && typeof parsed.yoloxPath === 'string' && parsed.yoloxPath.trim()) {
      return { yoloxPath: parsed.yoloxPath };
    }
  } catch {
    // 首次运行或文件损坏
  }
  return { yoloxPath: null };
}

async function saveYoloSettings(settings: YoloSettings) {
  await ensureYoloDirs();
  await writeFile(yoloSettingsFile(), JSON.stringify(settings, null, 2), 'utf8');
}

/** 解析 YOLOX 源码目录：先用户配置，其次项目内置 third_party/YOLOX */
async function resolveYoloxPath(): Promise<string | null> {
  const settings = await loadYoloSettings();
  if (settings.yoloxPath) {
    try {
      await stat(join(settings.yoloxPath, 'yolox', '__init__.py'));
      return settings.yoloxPath;
    } catch {
      // 配置路径失效，回退到内置路径
    }
  }
  const candidates = [
    join(app.getAppPath(), 'third_party', 'YOLOX'),
    join(process.resourcesPath, 'third_party', 'YOLOX'),
  ];
  for (const p of candidates) {
    try {
      await stat(join(p, 'yolox', '__init__.py'));
      return p;
    } catch {
      // continue
    }
  }
  return null;
}

/** 查找本机已下载的 YOLOX 预训练权重（yolo/weights/{model}.pth） */
async function resolvePretrainedWeight(baseModel: string): Promise<string | null> {
  const name = String(baseModel ?? '').replace(/-/g, '_');
  if (!name) return null;
  const p = join(yoloWeightsDir(), `${name}.pth`);
  try {
    const s = await stat(p);
    return s.size > 0 ? p : null;
  } catch {
    return null;
  }
}

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
  numClasses: number;
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

/** 导出数据集为 YOLO + COCO 格式（YOLO txt + data.yaml + COCO JSON + 训练/验证划分），返回导出目录与类别数 */
async function writeYoloExport(datasetId: string, splitTrain: number, seed: number): Promise<{ dataDir: string; classCount: number }> {
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
  await writeFile(join(exportDir, 'data.yaml'), yaml, 'utf8');

  // ===== COCO JSON（YOLOX 原生训练/评估格式） =====
  const annotationsDir = join(exportDir, 'annotations');
  await mkdir(annotationsDir, { recursive: true });

  const writeCocoJson = async (imageIds: Set<string>, fileName: string) => {
    const images: Array<Record<string, unknown>> = [];
    const annotations: Array<Record<string, unknown>> = [];
    const idByFile = new Map<string, number>();
    let id = 0;
    for (const img of data.images) {
      if (!imageIds.has(img.id)) continue;
      id += 1;
      idByFile.set(img.file, id);
      images.push({ id, file_name: img.file, width: img.width, height: img.height });
    }
    let annId = 1;
    for (const img of data.images) {
      if (!imageIds.has(img.id)) continue;
      const imgId = idByFile.get(img.file);
      if (!imgId) continue;
      for (const ann of data.annotations[img.id] ?? []) {
        if (!ann.classId) continue;
        const ci = classIndex.get(ann.classId);
        if (ci === undefined) continue;
        const x = Math.min(1, Math.max(0, ann.box.x));
        const y = Math.min(1, Math.max(0, ann.box.y));
        const w = Math.min(1, Math.max(0, ann.box.width));
        const h = Math.min(1, Math.max(0, ann.box.height));
        const pw = w * img.width;
        const ph = h * img.height;
        if (pw <= 0 || ph <= 0) continue;
        annotations.push({
          id: annId,
          image_id: imgId,
          category_id: ci,
          bbox: [Math.round(x * img.width * 100) / 100, Math.round(y * img.height * 100) / 100, Math.round(pw * 100) / 100, Math.round(ph * 100) / 100],
          area: Math.round(pw * ph * 100) / 100,
          iscrowd: 0,
        });
        annId += 1;
      }
    }
    await writeFile(
      join(annotationsDir, fileName),
      JSON.stringify({
        images,
        annotations,
        categories: data.classes.map((c, i) => ({ id: i, name: c.name })),
      }),
      'utf8',
    );
  };

  await writeCocoJson(trainSet, 'instances_train.json');
  const valSet = new Set(data.images.filter((img) => !trainSet.has(img.id)).map((img) => img.id));
  await writeCocoJson(valSet, 'instances_val.json');

  return { dataDir: exportDir, classCount: data.classes.length };
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

  const broadcastPackage = (ev: YoloTrainingEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('yolo:packageOutput', ev);
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
      const dest = join(yoloModelsDir(), `${id}.pth`);
      await mkdir(yoloModelsDir(), { recursive: true });
      await copyFile(ev.modelPath, dest);
      const size = await stat(dest);
      const model: YoloModel = {
        id,
        name: `${meta.datasetName} · ${meta.baseModel.replace(/\.(pt|pth)$/, '')}`,
        baseModel: meta.baseModel,
        datasetId: meta.datasetId,
        datasetName: meta.datasetName,
        epochs: meta.epochs,
        imageSize: meta.imageSize,
        batch: meta.batch,
        numClasses: meta.numClasses,
        file: `${id}.pth`,
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
    const yoloxPath = await resolveYoloxPath();
    if (!yoloxPath) return { started: false, message: '未找到 YOLOX 源码目录，请先在「环境」页选择 YOLOX 目录' };
    const cmd = pythonCommand();
    const runDir = join(yoloRunsDir(), `export-${Date.now()}`);
    await mkdir(runDir, { recursive: true });
    const enginePath = join(runDir, 'engine.py');
    const configPath = join(runDir, 'config.json');
    await writeFile(enginePath, YOLO_ENGINE_SOURCE, 'utf8');
    await writeFile(
      configPath,
      JSON.stringify({
        mode: 'export',
        yoloxPath,
        modelPath: join(yoloModelsDir(), model.file),
        format,
        imageSize,
        baseModel: model.baseModel,
        numClasses: model.numClasses ?? 0,
      }),
      'utf8',
    );
    const child = spawn(cmd, [enginePath, configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  ipcMain.handle('yolo:getYoloxPath', async (): Promise<string | null> => resolveYoloxPath());

  ipcMain.handle('yolo:setYoloxPath', async (_event, path: string): Promise<void> => {
    await saveYoloSettings({ yoloxPath: path?.trim() || null });
  });

  ipcMain.handle('yolo:pickYoloxPath', async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: '选择 YOLOX 源码目录（含 yolox 子目录）',
          properties: ['openDirectory'],
          buttonLabel: '选择此目录',
        })
      : null;
    if (!result || result.canceled || result.filePaths.length === 0) return null;
    const picked = result.filePaths[0];
    await saveYoloSettings({ yoloxPath: picked });
    return picked;
  });

  ipcMain.handle('yolo:getEnvInfo', async (): Promise<YoloEnvInfo> => {
    const cmd = pythonCommand();
    const yoloxPath = await resolveYoloxPath();
    const probe = [
      'import sys, json, subprocess;',
      ...(yoloxPath ? [`sys.path.insert(0, ${JSON.stringify(yoloxPath)});`] : []),
      'out={"python": sys.executable, "pythonVersion": sys.version.split()[0], "pip": None};',
      'try:',
      '  r=subprocess.run([sys.executable,"-m","pip","--version"],capture_output=True,text=True,timeout=8);',
      '  if r.returncode==0: out["pip"]=r.stdout.split()[1];',
      'except Exception: out["pip"]=None;',
      'try:',
      '  import yolox; out["yolox"]=getattr(yolox,"__version__","?");',
      'except Exception: out["yolox"]=None;',
      'try:',
      '  import torch; out["torch"]=torch.__version__;',
      '  out["cuda"]=bool(torch.cuda.is_available());',
      '  mps=getattr(torch.backends,"mps",None);',
      '  out["mps"]=bool(mps is not None and mps.is_available());',
      'except Exception: out["torch"]=None; out["cuda"]=False; out["mps"]=False;',
      'print(json.dumps(out))',
    ].join('\n');
    const res = await runCaptured(cmd, ['-c', probe], 20000);
    const info: YoloEnvInfo = {
      pythonAvailable: false,
      pythonPath: null,
      pythonVersion: null,
      pip: null,
      yolox: null,
      yoloxPath,
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
      info.pip = typeof parsed.pip === 'string' ? parsed.pip : null;
      info.yolox = typeof parsed.yolox === 'string' ? parsed.yolox : null;
      info.torch = typeof parsed.torch === 'string' ? parsed.torch : null;
      info.cuda = Boolean(parsed.cuda);
      info.mps = Boolean(parsed.mps);
      info.device = info.torch ? (info.cuda ? 'cuda' : info.mps ? 'mps' : 'cpu') : 'none';
      return info;
    } catch {
      return info;
    }
  });

  ipcMain.handle('yolo:installPackage', async (_event, packageName: string): Promise<{ started: boolean; message?: string }> => {
    if (packageChild) return { started: false, message: '已有安装任务在进行中' };
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

  ipcMain.handle('yolo:installYoloxDeps', async (): Promise<{ started: boolean; message?: string }> => {
    if (packageChild) return { started: false, message: '已有安装任务在进行中' };
    const yoloxPath = await resolveYoloxPath();
    if (!yoloxPath) {
      return { started: false, message: '未找到 YOLOX 源码目录，请先在「环境」页选择 YOLOX 目录' };
    }
    const reqFile = join(yoloxPath, 'requirements.txt');
    try {
      await stat(reqFile);
    } catch {
      return { started: false, message: `未找到 requirements.txt：${reqFile}` };
    }
    const cmd = pythonCommand();
    const child = spawn(cmd, ['-m', 'pip', 'install', '-r', reqFile], { stdio: ['ignore', 'pipe', 'pipe'] });
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
        message: code === 0 ? 'YOLOX 依赖安装完成 ✓' : `pip 退出，退出码 ${code}`,
      });
      packageChild = null;
    });
    return { started: true };
  });

  const YOLOX_WEIGHTS: Record<string, string> = {
    yolox_nano: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.pth',
    yolox_tiny: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.pth',
    yolox_s: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.pth',
    yolox_m: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_m.pth',
    yolox_l: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_l.pth',
    yolox_x: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_x.pth',
  };

  ipcMain.handle('yolo:getWeightsInfo', async (): Promise<{ name: string; present: boolean; sizeBytes: number }[]> => {
    await mkdir(yoloWeightsDir(), { recursive: true });
    const out: { name: string; present: boolean; sizeBytes: number }[] = [];
    for (const name of Object.keys(YOLOX_WEIGHTS)) {
      try {
        const s = await stat(join(yoloWeightsDir(), `${name}.pth`));
        out.push({ name, present: s.size > 0, sizeBytes: s.size });
      } catch {
        out.push({ name, present: false, sizeBytes: 0 });
      }
    }
    return out;
  });

  ipcMain.handle('yolo:downloadWeights', async (_event, modelName: string): Promise<{ started: boolean; message?: string }> => {
    const name = String(modelName ?? '').replace(/-/g, '_');
    const url = YOLOX_WEIGHTS[name];
    if (!url) return { started: false, message: `未知模型：${modelName}` };
    if (packageChild) return { started: false, message: '已有安装任务在进行中' };
    try {
      await mkdir(yoloWeightsDir(), { recursive: true });
      const dest = join(yoloWeightsDir(), `${name}.pth`);
      try {
        const existing = await stat(dest);
        if (existing.size > 0) return { started: false, message: `${name} 预训练权重已存在` };
      } catch {
        // 不存在则下载
      }
      broadcastPackage({ t: 'log', level: 'info', message: `开始下载 ${name} 预训练权重…` });
      const response = await fetch(url);
      if (!response.ok) {
        broadcastPackage({ t: 'log', level: 'error', message: `下载失败（HTTP ${response.status}），请检查网络后重试` });
        return { started: false, message: `下载失败（HTTP ${response.status}）` };
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(dest, buffer);
      broadcastPackage({ t: 'log', level: 'info', message: `${name} 预训练权重下载完成（${(buffer.length / 1024 / 1024).toFixed(1)} MB）` });
      return { started: true };
    } catch (err) {
      broadcastPackage({ t: 'log', level: 'error', message: `下载失败：${err instanceof Error ? err.message : String(err)}` });
      return { started: false, message: err instanceof Error ? err.message : String(err) };
    }
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

        const yoloxPath = await resolveYoloxPath();
        if (!yoloxPath) {
          return { started: false, message: '未找到 YOLOX 源码目录，请先在「环境」页选择 YOLOX 目录（如 third_party/YOLOX）' };
        }

        const jobId = `run-${Date.now()}`;
        const { dataDir, classCount } = await writeYoloExport(datasetId, cfg.splitTrain, cfg.seed);
        const runDir = join(yoloRunsDir(), jobId);
        await rm(runDir, { recursive: true, force: true });
        await mkdir(runDir, { recursive: true });

        const enginePath = join(runDir, 'engine.py');
        await writeFile(enginePath, YOLO_ENGINE_SOURCE, 'utf8');
        const configPath = join(runDir, 'config.json');
        await writeFile(
          configPath,
          JSON.stringify(
            {
              ...cfg,
              mode: 'train',
              yoloxPath,
              dataDir,
              numClasses: classCount,
              ckptPath: await resolvePretrainedWeight(cfg.model),
              projectDir: yoloRunsDir(),
              runName: jobId,
            },
            null,
            2,
          ),
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
          numClasses: classCount,
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

// ===== 视觉引擎（识别测试台 / 执行引擎共用） =====

function registerEngineIpc() {
  ipcMain.handle('engine:envInfo', async (): Promise<EngineEnvInfo> => {
    const yoloxPath = await resolveYoloxPath();
    const result = await runVisionEngine('check', { yoloxPath }, 20000);
    if (result.ok && result.env && typeof result.env === 'object') {
      const env = result.env as Record<string, unknown>;
      return {
        cv2: typeof env.cv2 === 'string' ? env.cv2 : null,
        torch: typeof env.torch === 'string' ? env.torch : null,
        yolox: typeof env.yolox === 'string' ? env.yolox : null,
        cuda: Boolean(env.cuda),
        mps: Boolean(env.mps),
        device: typeof env.device === 'string' ? env.device : 'none',
      };
    }
    return { cv2: null, torch: null, yolox: null, cuda: false, mps: false, device: 'none' };
  });

  ipcMain.handle(
    'engine:templateMatch',
    async (
      _event,
      payload: { imageDataUrl: string; templateId?: string; templatePath?: string; threshold?: number },
    ): Promise<EngineRunResult> => {
      const index = await loadIndex();
      const template = payload.templateId
        ? index.templates.find((item) => item.id === payload.templateId)
        : null;
      const templatePath = template
        ? join(templateImagesDir(), template.imageFile)
        : (payload.templatePath ?? null);
      if (!templatePath) {
        return { ok: false, message: '未选择匹配模板，请先在策略中选定模板' };
      }
      try {
        await stat(templatePath);
      } catch {
        return { ok: false, message: '模板文件不存在，可能已被删除' };
      }
      const imagePath = await writeImageToTemp(payload.imageDataUrl);
      if (!imagePath) return { ok: false, message: '无法保存测试截图' };
      return runVisionEngine('template', {
        imagePath,
        templatePath,
        threshold: payload.threshold ?? 60,
        sourceRect: template?.sourceRect,
        hotspot: template?.matchHotspot,
        clickOffset: template?.clickOffset,
      });
    },
  );

  ipcMain.handle(
    'engine:yoloDetect',
    async (
      _event,
      payload: { imageDataUrl: string; modelId?: string; modelPath?: string; threshold?: number },
    ): Promise<EngineRunResult> => {
      const index = await loadYoloIndex();
      const model = payload.modelId ? index.models.find((item) => item.id === payload.modelId) : null;
      const modelPath = model ? join(yoloModelsDir(), model.file) : (payload.modelPath ?? null);
      if (!modelPath) {
        return { ok: false, message: '未选择 YOLO 模型，请先在策略中选定模型' };
      }
      try {
        await stat(modelPath);
      } catch {
        return { ok: false, message: '模型文件不存在，可能已被删除' };
      }
      let classNames: string[] = [];
      if (model?.datasetId) {
        const data = await loadDatasetFile(model.datasetId);
        classNames = data.classes.map((cls) => cls.name);
      }
      const imagePath = await writeImageToTemp(payload.imageDataUrl);
      if (!imagePath) return { ok: false, message: '无法保存测试截图' };
      const threshold = Math.max(1, Math.min(100, payload.threshold ?? 60));
      return runVisionEngine('yolo', {
        imagePath,
        modelPath,
        baseModel: model?.baseModel ?? 'yolox_s',
        numClasses: model?.numClasses ?? classNames.length,
        classNames,
        imageSize: model?.imageSize ?? 640,
        confThre: threshold / 100,
        nmsThre: 0.45,
        yoloxPath: await resolveYoloxPath(),
      });
    },
  );
}

app.whenReady().then(() => {
  registerCloudApiIpc();
  registerStreamIpc();
  registerOcrIpc();
  registerTemplateIpc();
  registerYoloIpc();
  registerEngineIpc();
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
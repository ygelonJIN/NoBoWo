import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { app } from 'electron';
import { join } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import type {
  Ps5AccountProfile,
  Ps5Frame,
  Ps5HostInfo,
  Ps5HostTestResult,
  Ps5RuntimeStatus,
  Ps5StreamResolution,
} from '@nobowo/core';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type Ps5ConnectPayload = {
  host: string;
  accountId: string;
  resolution?: Ps5StreamResolution;
  fps?: number;
  quality?: string;
};

async function resolvePs5RuntimePath(): Promise<string | null> {
  const candidates = [
    join(process.resourcesPath, 'engine', 'python', 'ps5_runtime.py'),
    join(app.getAppPath(), 'packages', 'engine', 'python', 'ps5_runtime.py'),
    join(app.getAppPath(), 'engine', 'python', 'ps5_runtime.py'),
  ];
  for (const path of candidates) {
    try {
      await stat(path);
      return path;
    } catch {
      // try next
    }
  }
  return null;
}

export class Ps5RuntimeClient {
  private static readonly TELEMETRY_VERSION = 2;
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<ChildProcessWithoutNullStreams> | null = null;
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, PendingRequest>();

  private async ensureChild(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const runtimePath = await resolvePs5RuntimePath();
      if (!runtimePath) throw new Error('未找到 PS5 串流运行时（packages/engine/python/ps5_runtime.py）');
      const dataDir = join(app.getPath('userData'), 'ps5');
      await mkdir(dataDir, { recursive: true });
      const python = process.platform === 'win32' ? 'python' : 'python3';
      const child = spawn(python, [runtimePath, 'serve', dataDir], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.handleOutput(chunk));
      child.stderr.on('data', (chunk: string) => {
        const message = chunk.trim();
        if (message) console.warn('[ps5-runtime]', message.slice(0, 800));
      });
      child.on('exit', (code, signal) => {
        this.child = null;
        const error = new Error(`PS5 串流运行时已退出（${signal ?? code ?? '?'}）`);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
      });
      this.child = child;
      return child;
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private handleOutput(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (!line.startsWith('{')) continue;
      try {
        const response = JSON.parse(line) as { id?: number; ok?: boolean; result?: unknown; error?: string };
        const pending = response.id ? this.pending.get(response.id) : undefined;
        if (!pending) continue;
        this.pending.delete(response.id!);
        clearTimeout(pending.timer);
        if (response.ok) pending.resolve(response.result);
        else pending.reject(new Error(response.error || 'PS5 运行时请求失败'));
      } catch {
        // ignore partial/non-JSON logs
      }
    }
  }

  async request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    const child = await this.ensureChild();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`PS5 运行时请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private async restartChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.buffer = '';
    if (child && child.exitCode === null && !child.killed) child.kill();
  }

  async status(): Promise<Ps5RuntimeStatus> {
    const status = await this.request<Ps5RuntimeStatus>('status', {}, 10000);
    if (status.telemetryVersion !== Ps5RuntimeClient.TELEMETRY_VERSION && !status.connected) {
      await this.restartChild();
      return this.request<Ps5RuntimeStatus>('status', {}, 10000);
    }
    return status;
  }

  discover(timeout = 2.5): Promise<{ devices: Ps5HostInfo[] }> {
    return this.request<{ devices: Ps5HostInfo[] }>('discover', { timeout }, Math.max(15000, timeout * 1000 + 5000));
  }

  getPsnLoginUrl(): Promise<{ url: string }> {
    return this.request('getPsnLoginUrl', {}, 10000);
  }

  lookupAccountIdFromRedirect(redirectUrl: string): Promise<{ onlineId: string; accountId: string; source: string }> {
    return this.request('lookupAccountIdFromRedirect', { redirectUrl }, 30000);
  }

  listAccounts(): Promise<{ accounts: Ps5AccountProfile[] }> {
    return this.request('listAccounts', {}, 10000);
  }

  saveAccount(payload: Partial<Ps5AccountProfile> & { onlineId: string; accountId: string }): Promise<{ account: Ps5AccountProfile }> {
    return this.request('saveAccount', payload as Record<string, unknown>, 10000);
  }

  removeAccount(id: string): Promise<{ ok: boolean }> {
    return this.request('removeAccount', { id }, 10000);
  }

  listHosts(): Promise<{ hosts: Array<{ host: string; accountId: string; updatedAt: number }> }> {
    return this.request('listHosts', {}, 10000);
  }

  testHost(host: string): Promise<Ps5HostTestResult> {
    return this.request('testHost', { host }, 15000);
  }

  pair(payload: { host: string; accountId: string; pin: string }): Promise<{ host: string; accountId: string }> {
    return this.request('pair', payload, 30000);
  }

  connect(payload: Ps5ConnectPayload): Promise<Ps5RuntimeStatus> {
    return this.status().then(async (status) => {
      if (status.telemetryVersion !== Ps5RuntimeClient.TELEMETRY_VERSION) {
        await this.restartChild();
      }
      return this.request<Ps5RuntimeStatus>('connect', payload as unknown as Record<string, unknown>, 60000);
    });
  }

  disconnect(): Promise<{ connected: boolean }> {
    return this.request('disconnect', {}, 15000);
  }

  getFrame(): Promise<Ps5Frame> {
    return this.request('getFrame', {}, 10000);
  }

  sendKey(key: string, down: boolean): Promise<{ key: string; button: string; down: boolean }> {
    return this.request('sendKey', { key, down }, 5000);
  }

  sendButton(action: string, pressed?: boolean, durationMs = 0): Promise<{ action: string; button: string; durationMs?: number }> {
    return this.request('sendButton', { action, pressed, durationMs }, 5000);
  }

  setStick(stick: 'left' | 'right', x: number, y: number): Promise<{ stick: string; x: number; y: number }> {
    return this.request('setStick', { stick, x, y }, 5000);
  }

  dispose(): void {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}

let client: Ps5RuntimeClient | null = null;

export function getPs5RuntimeClient(): Ps5RuntimeClient {
  if (!client) client = new Ps5RuntimeClient();
  return client;
}

export function disposePs5RuntimeClient(): void {
  client?.dispose();
  client = null;
}

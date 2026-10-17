import { spawn } from 'node:child_process';
import { app } from 'electron';
import { join } from 'node:path';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { EngineRunResult } from '@nobowo/core';

/** 查找视觉运行时脚本（开发时位于仓库内；打包后位于 resourcesPath） */
export async function resolveVisionEnginePath(): Promise<string | null> {
  const candidates = [
    join(app.getAppPath(), 'packages', 'engine', 'python', 'vision_runtime.py'),
    join(process.resourcesPath, 'engine', 'python', 'vision_runtime.py'),
    join(app.getAppPath(), 'engine', 'python', 'vision_runtime.py'),
  ];
  for (const path of candidates) {
    try {
      await stat(path);
      return path;
    } catch {
      // 尝试下一个候选路径
    }
  }
  return null;
}

function dataUrlToFileData(dataUrl: string): { buffer: Buffer; ext: string } | null {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  return { buffer, ext };
}

/** 把渲染层传来的 dataURL 图片写入临时目录，返回文件绝对路径 */
export async function writeImageToTemp(dataUrl: string): Promise<string | null> {
  const file = dataUrlToFileData(dataUrl);
  if (!file) return null;
  const dir = await mkdtemp(join(tmpdir(), 'nobowo-frame-'));
  const imagePath = join(dir, `frame.${file.ext}`);
  try {
    await writeFile(imagePath, file.buffer);
    return imagePath;
  } catch {
    return null;
  }
}

/**
 * 运行视觉引擎脚本。
 * command: 'check' | 'template' | 'yolo'
 * 返回脚本最后一个 stdout JSON 事件；失败时返回错误信息。
 */
export async function runVisionEngine(
  command: string,
  cfg: Record<string, unknown>,
  timeoutMs = 90000,
): Promise<EngineRunResult> {
  const enginePath = await resolveVisionEnginePath();
  if (!enginePath) {
    return { ok: false, message: '未找到视觉引擎脚本（packages/engine/python/vision_runtime.py）' };
  }
  const python = process.platform === 'win32' ? 'python' : 'python3';

  let dir: string | null = null;
  let configPath: string;
  try {
    dir = await mkdtemp(join(tmpdir(), 'nobowo-engine-'));
    configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(cfg), 'utf8');
  } catch (err) {
    return { ok: false, message: `无法准备引擎配置：${err instanceof Error ? err.message : String(err)}` };
  }

  const cleanup = () => {
    if (dir) void rm(dir, { recursive: true, force: true });
  };

  return new Promise((resolve) => {
    const child = spawn(python, [enginePath, command, configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      resolve({ ok: false, message: `无法启动 Python（${python}）：${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      const jsonLine = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('{'))
        .pop();
      if (jsonLine) {
        try {
          const parsed = JSON.parse(jsonLine) as EngineRunResult;
          if (parsed && typeof parsed === 'object') {
            resolve(parsed);
            return;
          }
        } catch {
          // 非 JSON，按普通输出处理
        }
      }
      const detail = stderr.trim() || stdout.trim();
      resolve({
        ok: false,
        message: `视觉引擎退出（退出码 ${code ?? '?'}）${detail ? `：${detail.slice(0, 400)}` : ''}`,
      });
    });
  });
}

export type YoloInferenceConfig = Record<string, unknown>;

type PendingYoloFrame = {
  resolve: (result: EngineRunResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** 常驻 YOLO 推理会话：模型只加载一次，后续帧通过 stdin/stdout JSONL 复用。 */
export class YoloInferenceSession {
  private readonly child: ReturnType<typeof spawn>;
  private readonly configDir: string;
  private readonly pending = new Map<number, PendingYoloFrame>();
  private nextFrameId = 1;
  private stdoutBuffer = '';
  private stderrText = '';
  private closed = false;
  private closePromise: Promise<void> | null = null;

  private constructor(
    child: ReturnType<typeof spawn>,
    configDir: string,
  ) {
    this.child = child;
    this.configDir = configDir;
  }

  static async start(
    cfg: YoloInferenceConfig,
    startupTimeoutMs = 90000,
  ): Promise<YoloInferenceSession> {
    const enginePath = await resolveVisionEnginePath();
    if (!enginePath) {
      throw new Error('未找到视觉引擎脚本（packages/engine/python/vision_runtime.py）');
    }
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const configDir = await mkdtemp(join(tmpdir(), 'nobowo-yolo-session-'));
    const configPath = join(configDir, 'config.json');
    await writeFile(configPath, JSON.stringify(cfg), 'utf8');

    const child = spawn(python, [enginePath, 'yolo-stream', configPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session = new YoloInferenceSession(child, configDir);
    let startupSettled = false;

    const startupPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (startupSettled) return;
        startupSettled = true;
        void session.close();
        reject(new Error(`YOLO 常驻推理启动超时（${startupTimeoutMs}ms）${session.stderrText ? `：${session.stderrText.slice(-400)}` : ''}`));
      }, startupTimeoutMs);

      session.onReady = () => {
        if (startupSettled) return;
        startupSettled = true;
        clearTimeout(timer);
        resolve();
      };
      session.onFatal = (message) => {
        if (startupSettled) return;
        startupSettled = true;
        clearTimeout(timer);
        reject(new Error(message));
      };
    });

    session.attachChild();
    try {
      await startupPromise;
      return session;
    } catch (err) {
      await session.close();
      throw err;
    }
  }

  private onReady: (() => void) | null = null;
  private onFatal: ((message: string) => void) | null = null;

  private attachChild(): void {
    this.child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      // A queued frame or stop message can race with child shutdown. EPIPE is
      // handled here so it cannot escape as an uncaught stream error.
      if (err.code !== 'EPIPE' && !this.closed) {
        this.onFatal?.(`YOLO 常驻推理 stdin 错误：${err.message}`);
      }
      this.failPending(new Error(`YOLO 常驻推理管道已关闭：${err.message}`));
    });
    this.child.stdout?.on('data', (chunk: Buffer | string) => {
      this.stdoutBuffer += String(chunk);
      let newline = this.stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.stdoutBuffer.slice(0, newline).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        if (line) this.handleLine(line);
        newline = this.stdoutBuffer.indexOf('\n');
      }
    });
    this.child.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrText = `${this.stderrText}${String(chunk)}`.slice(-8000);
    });
    this.child.once('error', (err) => {
      this.onFatal?.(`无法启动 YOLO 常驻推理（${err.message}）`);
      this.failPending(new Error(`YOLO 常驻推理进程错误：${err.message}`));
    });
    this.child.once('close', (code) => {
      if (!this.closed) {
        const detail = this.stderrText.trim() || this.stdoutBuffer.trim();
        this.onFatal?.(`YOLO 常驻推理退出（退出码 ${code ?? '?'}）${detail ? `：${detail.slice(-400)}` : ''}`);
      }
      this.failPending(new Error(`YOLO 常驻推理已退出（退出码 ${code ?? '?'}）`));
      this.closed = true;
    });
  }

  private handleLine(line: string): void {
    if (!line.startsWith('{')) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.t === 'ready') {
      this.onReady?.();
      return;
    }
    const frameId = Number(event.id);
    if (!Number.isInteger(frameId)) return;
    const pending = this.pending.get(frameId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(frameId);
    pending.resolve(event as EngineRunResult);
  }

  async detect(
    frameDataUrl: string,
    timeoutMs = 5000,
    confidenceThreshold?: number,
  ): Promise<EngineRunResult> {
    if (this.closed || !this.child.stdin?.writable) {
      return { ok: false, message: 'YOLO 常驻推理会话已关闭' };
    }
    const id = this.nextFrameId++;
    return new Promise<EngineRunResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`YOLO 常驻推理帧超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const request: Record<string, unknown> = { id, frameDataUrl };
        if (confidenceThreshold !== undefined) {
          request.confThre = Math.max(0.01, Math.min(1, confidenceThreshold / 100));
        }
        this.child.stdin!.write(`${JSON.stringify(request)}\n`, (err) => {
          if (!err) return;
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        void rm(this.configDir, { recursive: true, force: true }).finally(resolve);
      };
      if (this.closed || !this.child.stdin?.writable) {
        this.closed = true;
        this.child.kill();
        finish();
        return;
      }
      const timer = setTimeout(() => {
        this.child.kill();
        finish();
      }, 250);
      this.child.once('close', () => {
        clearTimeout(timer);
        finish();
      });
      try {
        this.child.stdin.end(`${JSON.stringify({ command: 'stop' })}\n`, () => {
          // The close event remains authoritative; this callback absorbs a
          // concurrent shutdown write error without leaving it unhandled.
        });
      } catch {
        this.child.kill();
      }
    });
    return this.closePromise;
  }
}

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

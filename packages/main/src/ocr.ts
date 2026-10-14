import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import type { OcrMatch, OcrResult } from '@nobowo/core';
import { writeImageToTemp } from './engine';

type VisionBlock = {
  text: string;
  confidence: number;
  box: { x: number; y: number; width: number; height: number };
};

type VisionResult = { error: string } | { width: number; height: number; blocks: VisionBlock[] };

function resolveVisionOcrScript(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'packages', 'engine', 'macos', 'vision_ocr.js'),
    path.join(process.resourcesPath, 'engine', 'macos', 'vision_ocr.js'),
    path.join(app.getAppPath(), 'engine', 'macos', 'vision_ocr.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Run macOS Vision OCR through the existing JXA bridge. Confidence is returned as 0-1. */
export function runMacosVisionOcr(imagePath: string, languages: string[]): Promise<VisionResult> {
  return new Promise((resolve) => {
    const scriptPath = resolveVisionOcrScript();
    if (!scriptPath) {
      resolve({ error: '未找到 macOS Vision 脚本（engine/macos/vision_ocr.js）' });
      return;
    }
    let stdout = '';
    let stderr = '';
    const child = spawn('osascript', ['-l', 'JavaScript', scriptPath, imagePath, languages.join(',')]);
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // process may already have exited
      }
    }, 30000);
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ error: err.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout) as VisionResult);
      } catch {
        resolve({ error: stderr.trim() || 'Vision OCR 输出解析失败' });
      }
    });
  });
}

export function normalizeOcrText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[·•]/g, ' ')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findOcrMatch(matches: OcrMatch[], targetText: string, threshold = 0): OcrMatch | null {
  const target = normalizeOcrText(targetText);
  if (!target) return null;
  return matches.find((match) => {
    const confidence = typeof match.confidence === 'number' ? match.confidence : 100;
    return confidence >= threshold && normalizeOcrMatchText(match.text).includes(target);
  }) ?? null;
}

function normalizeOcrMatchText(text: string): string {
  return normalizeOcrText(text);
}

export function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Run the system OCR path used by both the test bench and workflow executor.
 * Returns null when macOS Vision is unavailable so callers can choose a fallback.
 * Confidence is normalized to 0-100 for workflow threshold comparison.
 */
export async function recognizeWithMacosVision(
  imageDataUrl: string,
  options: { lang?: 'auto' | 'eng' | 'chi_sim'; targetText?: string; width?: number; height?: number } = {},
): Promise<OcrResult | null> {
  if (process.platform !== 'darwin') return null;
  const imagePath = await writeImageToTemp(imageDataUrl);
  if (!imagePath) return null;
  try {
    const languages = options.lang === 'chi_sim' || (options.lang === 'auto' && hasCjk(options.targetText ?? ''))
      ? ['zh-Hans', 'en-US']
      : ['en-US'];
    const result = await runMacosVisionOcr(imagePath, languages);
    if ('error' in result) return null;
    return {
      engine: 'macosVision',
      width: result.width || options.width || 0,
      height: result.height || options.height || 0,
      text: result.blocks.map((block) => block.text).join('\n'),
      matches: result.blocks.map((block, index) => ({
        id: `vision-${index}-${block.box.x}-${block.box.y}`,
        text: block.text,
        box: block.box,
        confidence: Math.round(Math.max(0, Math.min(1, block.confidence)) * 100),
      })),
    };
  } finally {
    await rm(imagePath, { force: true }).catch(() => {});
  }
}

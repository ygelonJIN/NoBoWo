import { app } from 'electron';
import { mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const PROJECT_PACKAGE_NAME = 'nobowo-desktop-automation';

function findProjectRoot(startPath: string): string {
  let current = resolve(startPath);
  while (true) {
    const packageFile = join(current, 'package.json');
    if (existsSync(packageFile)) {
      try {
        const pkg = JSON.parse(readFileSync(packageFile, 'utf8')) as { name?: string };
        if (pkg.name === PROJECT_PACKAGE_NAME) return current;
      } catch {
        // Keep walking when package.json is unreadable or malformed.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

/** 模板明文保存在项目根目录的 templates/ 下，并由 .gitignore 排除。 */
export function templatesDir(): string {
  return join(findProjectRoot(app.getAppPath()), 'templates');
}

export function templateIndexFile(): string {
  return join(templatesDir(), 'index.json');
}

export function templateImagesDir(): string {
  return join(templatesDir(), 'images');
}

export function templateSourcesDir(): string {
  return join(templatesDir(), 'sources');
}

export async function ensureTemplatesDir(): Promise<void> {
  await mkdir(templateImagesDir(), { recursive: true });
  await mkdir(templateSourcesDir(), { recursive: true });
}

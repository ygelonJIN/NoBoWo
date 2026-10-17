export type ShortcutTargetLike = {
  tagName?: string;
  isContentEditable?: boolean;
} | null;

export function classIndexFromShortcut(key: string, classCount: number): number | null {
  if (!/^[1-9]$/.test(key)) return null;
  const index = Number(key) - 1;
  return index >= 0 && index < classCount ? index : null;
}

export function isTextShortcutTarget(target: ShortcutTargetLike): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tagName = String(target.tagName ?? '').toUpperCase();
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

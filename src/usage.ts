import { randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename, unlink, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RecordEntry } from './core.ts';

export function parseThreshold(value: string): number | null {
  if (value === 'off') return null;
  if (!/^\d{1,2}%?$/.test(value)) throw new Error('Use /context auto 80 (whole percent from 1 to 95), /context auto off, or /context auto show.');
  const n = Number(value.replace('%', ''));
  if (n < 1 || n > 95) throw new Error('Auto-compaction threshold must be from 1 to 95 percent.');
  return n;
}
export const thresholdFor = (r: RecordEntry) => r.autoCompactPercent === undefined ? 80 : r.autoCompactPercent;
export function nativeBudget(tokens: number, percent: number | null) {
  // Pi triggers on strictly greater than (window - reserve). Start at the first
  // integer token count at/above the requested percentage, with no rounding gap.
  const trigger = percent === null ? tokens + 1 : Math.ceil(tokens * percent / 100);
  return {reserveTokens: Math.max(0, tokens - trigger + 1), keepRecentTokens: Math.floor(tokens * Math.min((percent ?? 80) / 200, 1 / 16))};
}
export const compactionKeys = (r: RecordEntry) => [`ollama-context/managed-${r.key}`, `ollama-context/${r.variant}`];
export function autoStatus(r: RecordEntry, settings: any): string {
  const percent = thresholdFor(r);
  if (percent === null) return 'auto off';
  if (settings.compaction?.enabled === false) return 'auto off (Pi setting)';
  const wanted = nativeBudget(r.tokens, percent);
  const overrides = settings.compaction?.modelOverrides ?? {};
  const ready = compactionKeys(r).every(key => overrides[key]?.reserveTokens === wanted.reserveTokens && overrides[key]?.keepRecentTokens === wanted.keepRecentTokens);
  return ready ? `auto ${percent}%` : `auto ${percent}% pending/overridden`;
}
export function usageText(tokens: number | null | undefined, capacity: number, status: string): string {
  const known = typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0;
  const used = known ? `~${Math.ceil(tokens).toLocaleString('en-US')}` : '?';
  const percentage = known ? `${(tokens / capacity * 100).toFixed(1)}%` : 'usage unknown';
  return `ctx ${used} / ${capacity.toLocaleString('en-US')} · ${percentage} · ${status}`;
}

/** Update only our two exact model overrides. Shares Pi/proper-lockfile's .lock
 * directory convention, so native settings writes cannot race this transaction.
 * A private backup preserves the full pre-edit contents. Never changes enabled.
 */
export async function writeNativeBudget(path: string, r: RecordEntry, remove = false): Promise<boolean> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const lock = `${path}.lock`;
  try { await mkdir(lock, {mode: 0o700}); }
  catch { throw new Error('Pi settings are busy/locked. Wait for other settings changes, then retry /context auto. No settings were overwritten.'); }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const before = await readFile(path, 'utf8').catch((e: any) => {if (e.code === 'ENOENT') return undefined; throw e;});
    const settings = before === undefined ? {} : JSON.parse(before.replace(/^\uFEFF/, ''));
    const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (!object(settings) || (settings.compaction !== undefined && !object(settings.compaction)) || (settings.compaction?.modelOverrides !== undefined && !object(settings.compaction.modelOverrides))) throw new Error('Invalid Pi settings structure; no settings overwritten.');
    const next = structuredClone(settings);
    next.compaction ??= {}; next.compaction.modelOverrides ??= {};
    for (const key of compactionKeys(r)) {
      if (remove) delete next.compaction.modelOverrides[key];
      else next.compaction.modelOverrides[key] = {...next.compaction.modelOverrides[key], ...nativeBudget(r.tokens, thresholdFor(r))};
    }
    if (JSON.stringify(settings) === JSON.stringify(next)) return false;
    if (before !== undefined) {
      const backup = await open(`${path}.pi-ollama-context-backup-${randomUUID()}`, 'wx', 0o600);
      try {await backup.writeFile(before); await backup.sync();} finally {await backup.close();}
    }
    const file = await open(temp, 'wx', 0o600);
    try {await file.writeFile(JSON.stringify(next, null, 2) + '\n');await file.sync();} finally {await file.close();}
    await rename(temp, path);
    return true;
  } finally {await unlink(temp).catch(()=>{});await rmdir(lock);}
}

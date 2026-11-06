import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export const PRESETS = ['4K — 4096 tokens', '8K — 8192 tokens', '16K — 16384 tokens', '32K — 32768 tokens', '64K — 65536 tokens', 'Custom — Enter a token count'];
export function parseContext(value: string): number {
  const match = /^([1-9]\d*)(k)?$/i.exec(value.trim());
  const n = match ? Number(match[1]) * (match[2] ? 1024 : 1) : NaN;
  if (!Number.isSafeInteger(n) || n < 512 || n > 1048576) throw new Error('Enter a whole token count from 512 to 1048576, or a value such as 8k.');
  return n;
}
export function endpoint(baseUrl: string): string {
  const u = new URL(baseUrl);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('Use an HTTP(S) Ollama base URL without embedded credentials, query, or fragment.');
  u.pathname = u.pathname.replace(/\/+$/, '');
  if (!u.pathname.endsWith('/v1')) throw new Error('Expected an Ollama OpenAI endpoint ending in /v1 (proxy prefixes are supported).');
  u.pathname = u.pathname.slice(0, -3);
  return u.toString().replace(/\/+$/, '');
}
export const canonical = (name: string) => name.slice(name.lastIndexOf('/') + 1).includes(':') ? name : `${name}:latest`;
export const keyFor = (url: string, model: string) => createHash('sha256').update(`${url}\n${canonical(model)}`).digest('hex').slice(0, 24);
export const outputBudget = (n: number) => Math.max(128, Math.min(2048, Math.floor(n / 8)));
export function assertFits(messages: unknown, size: number): void {
  // A conservative UTF-8 byte bound, not a pretend exact tokenizer. Includes tool schemas.
  const text = JSON.stringify(messages);
  if (/"type"\s*:\s*"(?:image|audio)"/.test(text)) throw new Error('Context safety for image/audio inputs is not supported yet. Use a text-only conversation.');
  const bound = Buffer.byteLength(text, 'utf8') + 256 + outputBudget(size);
  if (bound > size) throw new Error(`Conversation safety bound (${bound} tokens including output reserve) exceeds ${size}. Keep the larger context, use /compact there, or start /new. Nothing was truncated. This conservative byte bound can reject text that a model-specific tokenizer would fit.`);
}
export interface RecordEntry { key: string; endpoint: string; source: string; sourceDigest: string; variant: string; variantDigest: string; tokens: number; }
export interface Settings { version: 1; entries: Record<string, RecordEntry>; }
function validateSettings(value: any): Settings {
  if (value?.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) throw new Error('Invalid context settings file; restore its backup or rename it before retrying.');
  for (const [k, r] of Object.entries(value.entries) as [string, any][]) {
    if (!r || r.key !== k || typeof r.endpoint !== 'string' || typeof r.source !== 'string' || typeof r.variant !== 'string' || typeof r.sourceDigest !== 'string' || typeof r.variantDigest !== 'string' || parseContext(String(r.tokens)) !== r.tokens || keyFor(r.endpoint, r.source) !== k || endpoint(`${r.endpoint}/v1`) !== r.endpoint) throw new Error('Invalid context settings entry. Settings were not overwritten.');
  }
  return value;
}
export class Store {
  readonly path: string;
  constructor(path: string) { this.path = path; }
  async read(): Promise<Settings> {
    try { return validateSettings(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (e: any) { if (e.code === 'ENOENT') return {version: 1, entries: {}}; throw e; }
  }
  async update(key: string, entry?: RecordEntry): Promise<void> {
    await mkdir(dirname(this.path), {recursive: true, mode: 0o700});
    let lock;
    try { lock = await open(`${this.path}.lock`, 'wx', 0o600); }
    catch { throw new Error(`Settings are locked by another /context operation. If no Pi process is changing context, remove ${this.path}.lock and retry.`); }
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const settings = await this.read();
      if (entry) settings.entries[key] = entry; else delete settings.entries[key];
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(settings, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path);
    } finally { await unlink(temp).catch(() => {}); await lock.close(); await unlink(`${this.path}.lock`); }
  }
}
export interface Allocation { name: string; context_length: number; size: number; size_vram: number; digest?: string; }
export class Ollama {
  readonly url: string; readonly headers: Record<string, string>; readonly request: typeof fetch; readonly signal?: AbortSignal;
  constructor(url: string, headers: Record<string, string> = {}, request: typeof fetch = fetch, signal?: AbortSignal) { this.url = url; this.headers = headers; this.request = request; this.signal = signal; }
  async call(path: string, body?: unknown): Promise<any> {
    try {
      const signals = [AbortSignal.timeout(path === '/api/generate' || path === '/api/create' ? 180000 : 15000)];
      if (this.signal) signals.push(this.signal);
      const res = await this.request(`${this.url}${path}`, {method: body === undefined ? 'GET' : 'POST', headers: {...this.headers, 'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any(signals), redirect: 'error'});
      if (!res.ok) throw new Error(`HTTP ${res.status} at ${path}`);
      const data = await res.json();
      if (data.error) throw new Error(`Ollama rejected ${path}: ${String(data.error).slice(0, 200)}`);
      return data;
    } catch (e: any) { throw new Error(`Ollama ${path} failed: ${e.message}. Check the selected server, authentication and native API access; no fallback server was used.`); }
  }
  async info(model: string) {
    const info = await this.call('/api/show', {model});
    if (info.remote_model || info.remote_host || /:cloud$/.test(model)) throw new Error('Cloud models are unsupported; select a locally installed Ollama completion model.');
    if (!info.capabilities?.includes('completion')) throw new Error('This model is not a supported local completion model (embedding-only models cannot be used).');
    return info;
  }
  async digest(model: string): Promise<string> {
    const tags = await this.call('/api/tags');
    const tag = tags.models?.find((m: any) => canonical(m.name ?? m.model) === canonical(model));
    if (!tag?.digest) throw new Error(`Model ${model} is not installed on the selected server. Install it first; /context never pulls models.`);
    return tag.digest;
  }
  async allocation(model: string): Promise<Allocation | undefined> {
    const ps = await this.call('/api/ps');
    return ps.models?.find((m: any) => canonical(m.name ?? m.model) === canonical(model));
  }
  async verify(entry: RecordEntry): Promise<Allocation> {
    if (await this.digest(entry.source) !== entry.sourceDigest) throw new Error('The original model changed. Run /context with the desired size again to create a fresh variant.');
    if (await this.digest(entry.variant) !== entry.variantDigest) throw new Error('The managed variant was replaced. Run /context with the desired size again.');
    const info = await this.info(entry.variant);
    if (parameterContext(info.parameters) !== entry.tokens) throw new Error('The variant no longer has the requested num_ctx. Run /context with the desired size again.');
    let allocation = await this.allocation(entry.variant);
    if (!allocation || allocation.context_length !== entry.tokens) {
      // No num_ctx override: verify the saved model default, including after an eviction/restart.
      await this.call('/api/generate', {model: entry.variant, stream: false, keep_alive: '5m'});
      allocation = await this.allocation(entry.variant);
    }
    if (!allocation || allocation.context_length !== entry.tokens) throw new Error(`Requested ${entry.tokens}, but Ollama reports ${allocation?.context_length ?? 'unknown'} allocated tokens. Not applied. Check server limits/version and available memory; no fallback size was accepted.`);
    if (allocation.digest && allocation.digest !== entry.variantDigest) throw new Error('Loaded model digest differs from the verified variant. Retry after checking concurrent Ollama clients.');
    return allocation;
  }
  async create(source: string, tokens: number): Promise<{entry: RecordEntry; allocation: Allocation}> {
    const info = await this.info(source);
    const maxima = Object.entries(info.model_info ?? {}).filter(([k]) => k.endsWith('.context_length')).map(([, v]) => Number(v)).filter(Number.isFinite);
    if (!maxima.length) throw new Error('Ollama does not report this model’s maximum context length; refusing to guess.');
    const max = Math.min(...maxima);
    if (tokens > max) throw new Error(`Requested ${tokens} exceeds the model’s reported maximum of ${max}.`);
    const sourceDigest = await this.digest(source);
    // Random suffix avoids overwriting existing user/other-process models. Never delete any model.
    const variant = `${source.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48)}-ctx${tokens % 1024 ? tokens : `${tokens / 1024}k`}-${randomUUID().replaceAll('-', '')}:latest`;
    const existing = await this.call('/api/tags');
    if (existing.models?.some((m: any) => canonical(m.name ?? m.model) === variant)) throw new Error('Variant name collision; nothing overwritten. Retry.');
    await this.call('/api/create', {model: variant, from: source, parameters: {num_ctx: tokens}, stream: false});
    const entry = {key: keyFor(this.url, source), endpoint: this.url, source, sourceDigest, variant, variantDigest: await this.digest(variant), tokens};
    try { return {entry, allocation: await this.verify(entry)}; }
    catch (e: any) { throw new Error(`${e.message} Unselected variant ${variant} was retained for inspection; the original is unchanged.`); }
  }
}
export function parameterContext(parameters: string = ''): number | undefined {
  const match = /^\s*num_ctx\s+(\d+)\s*$/m.exec(parameters);
  return match ? Number(match[1]) : undefined;
}
export function describeAllocation(a?: Allocation): string {
  if (!a) return 'Effective: unknown (not currently loaded)';
  const mib = (n: number) => Number.isFinite(n) ? `${Math.round(n / 1048576)} MiB` : 'unknown';
  const placement = a.size_vram === 0 ? 'CPU allocation' : a.size_vram > 0 ? 'GPU allocation present (not proof of full GPU execution)' : 'placement unknown';
  return `Effective: ${a.context_length ?? 'unknown'} tokens; model allocation ${mib(a.size)}, VRAM ${mib(a.size_vram)}; ${placement}`;
}

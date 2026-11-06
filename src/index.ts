import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { autoStatus, parseThreshold, thresholdFor, usageText, writeNativeBudget } from './usage.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Ollama, Store, PRESETS, assertFits, describeAllocation, endpoint, keyFor, outputBudget, parseContext, type RecordEntry } from './core.ts';

const PROVIDER = 'ollama-context';
function selectionIdentity(ctx: ExtensionContext): string {
  return JSON.stringify([ctx.model?.provider, ctx.model?.id, ctx.model?.baseUrl, ctx.sessionManager.getSessionId(), ctx.sessionManager.getLeafId()]);
}
const virtualId = (r: RecordEntry) => `managed-${r.key}`;
function history(ctx: ExtensionContext): unknown[] {
  // Pi 1.5 exposes the projection; 1.3 exposes the finalized session context.
  const manager = ctx.sessionManager as typeof ctx.sessionManager & {buildSessionContext?: () => {messages: unknown[]}};
  if (typeof manager.buildSessionProjection === 'function') return manager.buildSessionProjection().messages;
  if (typeof manager.buildSessionContext === 'function') return manager.buildSessionContext().messages;
  throw new Error('This Pi build has no supported conversation inspection API. Update Pi before changing context.');
}

// Registering a separate provider is necessary: Pi routes only to catalog models and discards
// ad-hoc context metadata on returned model objects. Never register/replace the ollama provider.
export default async function extension(pi: ExtensionAPI) {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  const store = new Store(join(agentDir, 'pi-ollama-context.json'));
  const settingsPath = join(agentDir, 'settings.json');
  let compacting = false;
  let compactionFailed = false;
  let entries: Record<string, RecordEntry> = {};
  let busy = false;
  let switching = false;
  let startupError: string | undefined;
  const physical = new Map<string, any>();
  try { entries = (await store.read()).entries; } catch (e: any) { startupError = e.message; }

  function selected(ctx: ExtensionContext): RecordEntry | undefined {
    return Object.values(entries).find(r => ctx.model?.provider === PROVIDER && [virtualId(r), r.variant].includes(ctx.model.id));
  }
  function paint(ctx: ExtensionContext) {
    const r = selected(ctx);
    if (!r) {ctx.ui.setStatus('ollama-context', undefined); return;}
    const tokens = ctx.getContextUsage()?.tokens;
    const state = compacting ? 'compacting…' : compactionFailed ? 'compaction failed · /compact' : autoStatus(r, pi.getSettings());
    let text = usageText(tokens, r.tokens, state);
    if (ctx.ui.theme && typeof tokens === 'number' && tokens / r.tokens >= (thresholdFor(r) ?? 100) / 100) text = ctx.ui.theme.fg('warning', text);
    ctx.ui.setStatus('ollama-context', text);
  }
  function original(ctx: ExtensionContext, entry?: RecordEntry): any {
    const model = entry ? ctx.modelRegistry.find('ollama', entry.source) : ctx.model;
    if (!model || model.provider !== 'ollama' || model.api !== 'openai-completions') throw new Error('Select a local Ollama model from pi-ollama first. If discovery is still running, use /ollama-refresh and retry. Only its OpenAI-completions transport is supported.');
    if (entry && endpoint(model.baseUrl) !== entry.endpoint) throw new Error('The Ollama endpoint changed. Select the original model and run /context again; saved settings are endpoint-specific.');
    return model;
  }
  async function client(ctx: ExtensionContext, model: any, signal?: AbortSignal): Promise<Ollama> {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error('Cannot resolve Ollama authentication. Check pi-ollama configuration.');
    if (auth.baseUrl && endpoint(auth.baseUrl) !== endpoint(model.baseUrl)) throw new Error('Dynamic authentication changed the endpoint; configure the same explicit Ollama base URL before using /context.');
    const headers: Record<string, string> = {...model.headers, ...auth.headers};
    if (auth.apiKey && !Object.keys(headers).some(k => k.toLowerCase() === 'authorization')) headers.Authorization = `Bearer ${auth.apiKey}`;
    return new Ollama(endpoint(model.baseUrl), headers, fetch, signal);
  }
  function registerPhysical(model: any, r: RecordEntry, api: Ollama) {
    physical.set(r.key, {...model, provider: PROVIDER, id: r.variant, name: `${r.source} (${r.tokens} verified context)`, contextWindow: r.tokens, maxTokens: outputBudget(r.tokens), headers: api.headers});
    pi.registerProvider(PROVIDER, {
      api: 'openai-completions', baseUrl: model.baseUrl, apiKey: 'ollama-context-local', authHeader: false,
      models: [...physical.values()],
    });
  }
  function register(r: RecordEntry) {
    pi.registerVirtualModel({provider: PROVIDER, id: virtualId(r), name: `${r.source} · context ${r.tokens}`, contextWindow: r.tokens, maxTokens: outputBudget(r.tokens), input: ['text'],
      async route(request, ctx) {
        // Re-read preferences to catch reset/change in another Pi process. Never silently use a stale size.
        const current = (await store.read()).entries[r.key];
        if (!current || current.variant !== r.variant) throw new Error('Context preference changed in another session. Run /context show, then /context with the desired size.');
        // A direct route chooses credentials/model for Pi's summary generator;
        // these messages are the source history, NOT the final summary prompt.
        // Pi sizes that separate request using the verified physical model limits.
        if (request.reason !== 'direct') {
          const last = request.messages.findLast(m => m.role === 'assistant' && m.stopReason !== 'error' && m.stopReason !== 'aborted');
          const calibrated = last?.role === 'assistant' && last.model === r.variant;
          assertFits(request.messages, r.tokens, calibrated ? ctx.getContextUsage()?.tokens : undefined);
        }
        const model = original(ctx, r);
        const api = await client(ctx, model, request.signal);
        await api.verify(r);
        registerPhysical(model, r, api);
        const target = ctx.modelRegistry.find(PROVIDER, r.variant);
        if (!target) throw new Error('Pi could not register the verified model. Reload extensions and retry.');
        return {model: target, thinkingLevel: request.thinkingLevel};
      },
    });
  }
  async function select(ctx: ExtensionContext, r: RecordEntry) {
    register(r);
    const model = ctx.modelRegistry.find(PROVIDER, virtualId(r));
    if (!model) throw new Error('Pi did not expose the managed model; reload extensions and retry.');
    switching = true;
    try { if (!await pi.setModel(model)) throw new Error('Pi refused the model selection. Check provider authentication.'); }
    finally { switching = false; }
  }
  if (typeof pi.registerVirtualModel !== 'function') {
    pi.registerCommand('context', {description: 'Ollama context manager (requires Pi 1.3+)', async handler(_args, ctx) { ctx.ui.notify('pi-ollama-context requires @earendil-works/pi-coding-agent 1.3.0 or newer with the virtual-model API. Legacy @mariozechner builds are unsupported.', 'error'); }});
    return;
  }
  for (const r of Object.values(entries)) register(r);

  async function restore(_event: unknown, ctx: ExtensionContext) {
    if (switching || busy || !ctx.isIdle()) return;
    compacting = false; compactionFailed = false;
    if (startupError) { ctx.ui.notify(startupError, 'error'); return; }
    try {
      const r = selected(ctx) ?? (ctx.model?.provider === 'ollama' ? entries[keyFor(endpoint(ctx.model.baseUrl), ctx.model.id)] : undefined);
      if (!r) { ctx.ui.setStatus('ollama-context', undefined); return; }
      if (ctx.model?.id !== virtualId(r)) await select(ctx, r);
      ctx.ui.setStatus('ollama-context', usageText(ctx.getContextUsage()?.tokens, r.tokens, autoStatus(r, pi.getSettings())));
    } catch (e: any) { ctx.ui.notify(e.message, 'error'); }
  }
  pi.on('session_start', restore);
  pi.on('model_select', restore);
  pi.on('before_provider_request', async (event, ctx) => {
    const r = selected(ctx);
    const payload = event.payload as Record<string, unknown> | null;
    if (!r || !payload || typeof payload !== 'object' || payload.model !== r.variant) return;
    const limits = [payload.max_tokens, payload.max_completion_tokens].filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
    // Ollama documents max_tokens; Pi's model metadata alone does not bound an
    // ordinary response. Preserve any tighter caller limit and reserve space.
    const next: Record<string, unknown> = {...payload, max_tokens: Math.max(1, Math.floor(Math.min(outputBudget(r.tokens), ...limits)))};
    delete next.max_completion_tokens;
    return next;
  });
  // Pi owns timing, summary generation and session persistence. Our settings only
  // adjust its per-model reserve/retained-tail budgets; no timer or extra model call.
  pi.on('session_before_compact', async (event, ctx) => {
    const r = selected(ctx);
    if (!r) return;
    if (event.reason === 'threshold') {
      const percent = thresholdFor(r);
      const tokens = ctx.getContextUsage()?.tokens;
      if (percent === null || tokens == null || tokens < Math.ceil(r.tokens * percent / 100)) return {cancel: true};
    }
    compacting = true; compactionFailed = false; paint(ctx);
  });
  pi.on('session_compact', async (_event, ctx) => {compacting = false; compactionFailed = false; paint(ctx);});
  pi.on('session_compact_failed', async (event, ctx) => {
    compacting = false;
    if (!selected(ctx)) return;
    // Our deliberate suppression of an early native threshold isn't a failure.
    if (!event.aborted) {
      compactionFailed = true;
      ctx.ui.notify(`Compaction failed; no successful summary was recorded. ${event.errorMessage ?? 'Try /compact or a larger context.'}`, 'warning');
    }
    paint(ctx);
  });
  pi.on('message_end', async (_event, ctx) => {paint(ctx);});
  pi.on('turn_end', async (_event, ctx) => {paint(ctx);});
  pi.on('agent_end', async (_event, ctx) => {paint(ctx);});
  pi.on('agent_settled', async (_event, ctx) => {paint(ctx);});
  pi.on('session_tree', async (_event, ctx) => {paint(ctx);});


  pi.registerCommand('context', {
    description: 'Set verified Ollama context: [tokens|4k|8k|16k|32k|64k|show|reset|auto [1-95|off|show]]',
    async handler(args, ctx) {
      if (busy) { ctx.ui.notify('A context operation is already running; wait for it to finish.', 'warning'); return; }
      busy = true;
      try {
        if (startupError) throw new Error(startupError);
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('Wait for the current turn and queued messages to finish before changing context.');
        entries = (await store.read()).entries;
        const managed = selected(ctx);
        const model = original(ctx, managed);
        const api = await client(ctx, model);
        const key = keyFor(api.url, model.id);
        const saved = entries[key];
        const startSelection = selectionIdentity(ctx);
        let arg = args.trim().toLowerCase();
        if (arg === 'auto' || arg.startsWith('auto ')) {
          if (!saved) throw new Error('Set a context first, for example /context 8192.');
          let value = arg.slice(4).trim();
          if (!value) {
            if (!ctx.hasUI) throw new Error('Use /context auto 80, /context auto off, or /context auto show.');
            const answer = await ctx.ui.select('Auto-compact when context reaches', ['60%', '70%', '80%', '90%', 'Custom percentage', 'Off']);
            if (!answer) return;
            value = answer === 'Custom percentage' ? (await ctx.ui.input('Whole percent (1–95)', '80') ?? '') : answer.toLowerCase();
            if (!value) return;
          }
          if (value === 'show') {ctx.ui.notify(usageText(ctx.getContextUsage()?.tokens, saved.tokens, autoStatus(saved, pi.getSettings())), 'info');paint(ctx);return;}
          const updated = {...saved, autoCompactPercent: parseThreshold(value)};
          await writeNativeBudget(settingsPath, updated);
          await store.update(key, updated); entries[key] = updated;
          ctx.ui.notify(`Saved ${updated.autoCompactPercent === null ? 'auto-compaction off' : `auto-compaction at ${updated.autoCompactPercent}%`} for ${model.id}. Reloading Pi to activate native settings. Project overrides and Pi’s global auto-compaction switch remain authoritative.`, 'info');
          await ctx.reload();
          return;
        }
        if (!arg || arg === 'show') {
          const loaded = await api.allocation(managed?.variant ?? model.id, managed?.variantDigest);
          const status = `Selected: ${ctx.model?.name ?? model.id}\nOriginal: ${model.id}\nRequested: ${saved?.tokens ?? 'original default'}\n${describeAllocation(loaded)}\n${saved ? usageText(ctx.getContextUsage()?.tokens, saved.tokens, autoStatus(saved, pi.getSettings())) : 'Set /context SIZE to enable the usage footer and threshold.'}\nPersistent: ${saved ? 'yes (per model and endpoint)' : 'no override'}`;
          if (arg === 'show') { ctx.ui.notify(status, 'info'); return; }
          if (!ctx.hasUI) throw new Error('Interactive selection needs Pi UI; use /context 8192.');
          const choice = await ctx.ui.select(`${status}\nChoose context (larger sizes can reload the model and use more memory)`, PRESETS);
          if (!choice) return;
          if (choice === PRESETS.at(-1)) {
            const custom = await ctx.ui.input('Context tokens', '8192');
            if (custom === undefined || !custom.trim()) return;
            arg = custom;
          } else arg = String([4096, 8192, 16384, 32768, 65536][PRESETS.indexOf(choice)]);
        }
        if (arg === 'reset') {
          if (!saved) { ctx.ui.notify('No saved override for this model.', 'info'); return; }
          // Original is never modified. Reset only removes the preference and selects it again.
          // Capacity of its default is unknown until loaded; don't risk truncating a conversation.
          const messages = history(ctx);
          if (messages.length) throw new Error('Use /new before /context reset: the original default may be smaller than this conversation. Saved variants and history are retained.');
          await api.call('/api/generate', {model: model.id, stream: false, keep_alive: '5m'});
          const allocation = await api.allocation(model.id);
          if (!allocation?.context_length) throw new Error('Cannot verify the original model’s default allocation; preference retained.');
          if (selectionIdentity(ctx) !== startSelection) throw new Error('Model changed during context setup. Retry on the selected model.');
          switching = true;
          try { if (!await pi.setModel({...model, contextWindow: allocation.context_length})) throw new Error('Pi refused to restore the original model.'); }
          finally { switching = false; }
          await writeNativeBudget(settingsPath, saved, true);
          await store.update(key);
          delete entries[key];
          pi.unregisterVirtualModel(PROVIDER, virtualId(saved));
          ctx.ui.setStatus('ollama-context', undefined);
          ctx.ui.notify(`Restored ${model.id}. ${describeAllocation(allocation)}. Persistent override removed; derived models retained. Original provider metadata may revert on /ollama-refresh.`, 'info');
          return;
        }
        const tokens = parseContext(arg);
        const messages = history(ctx);
        if (messages.length) assertFits({system: ctx.getSystemPrompt(), messages}, tokens);
        ctx.ui.setStatus('ollama-context', `checking ${tokens} tokens…`);
        let result;
        if (saved?.tokens === tokens && await api.digest(model.id) === saved.sourceDigest && await api.digest(saved.variant).catch(() => '') === saved.variantDigest) result = {entry: saved, allocation: await api.verify(saved)};
        else result = await api.create(model.id, tokens);
        if (selectionIdentity(ctx) !== startSelection || !ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('Model/session activity changed during setup; selection and preference were not changed. Retry when idle.');
        result.entry.autoCompactPercent = saved?.autoCompactPercent === undefined ? 80 : saved.autoCompactPercent;
        registerPhysical(model, result.entry, api);
        // Persist before selection, so routing always observes a committed preference.
        await store.update(key, result.entry);
        entries[key] = result.entry;
        try { await select(ctx, result.entry); }
        catch (e) { await store.update(key, saved); if (saved) entries[key] = saved; else delete entries[key]; throw e; }
        paint(ctx);
        ctx.ui.notify(`Selected ${model.id} → ${result.entry.variant}\nRequested: ${tokens}\n${describeAllocation(result.allocation)}\nPersistent: yes. Original model unchanged; shared model weights, separate context allocation.`, 'info');
        await writeNativeBudget(settingsPath, result.entry);
        ctx.ui.notify('Reloading Pi to apply this model’s native auto-compaction threshold and retained-history budget.', 'info');
        await ctx.reload();
      } catch (e: any) {
        ctx.ui.setStatus('ollama-context', undefined);
        ctx.ui.notify(e.message, 'error');
      } finally { busy = false; }
    },
  });
}

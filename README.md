# pi-ollama-context

Change **Ollama's actual context allocation** from Pi with `/context 8192`.
No model has to execute configuration instructions. No root, service edits,
model downloads, or model-facing tools. Zero runtime dependencies.

```text
/context
  4K — 4096 tokens
› 8K — 8192 tokens
  16K — 16384 tokens
  32K — 32768 tokens
  64K — 65536 tokens
  Custom — Enter a token count

/context 8192
Selected: your-model → your-model-ctx8k-<unique-id>:latest
Requested: 8192
Effective: 8192 tokens; model allocation …; VRAM …
Persistent: yes. Original model unchanged.
```

Illustrative terminal transcript; memory numbers come from the running server,
not from a model-name guess.

## Install

Requires **Pi 1.3.0 or newer** (`@earendil-works/pi-coding-agent`) with its
virtual-model API, Node 22.19+ when using the Node distribution, and a local
completion model already installed in Ollama. Legacy `@mariozechner` Pi builds
without this API are not supported.

Keep your existing discovery extension installed:

```sh
pi install npm:@jamesjfoong/pi-ollama
pi install git:github.com/Reen06/pi-ollama-context@v0.2.0
```

Restart Pi (or `/reload`), select an **ollama** model, then:

```text
/context 8192
```

If discovery is still running, `/ollama-refresh` and retry. The extension never
pulls a missing model and never substitutes another server. GitHub is the
published installation channel for this release; **it has not been published
to npm**. Do not use `npm:pi-ollama-context` unless a future release announces it.

Once installed, this extension contacts only the selected Ollama server.
Internet access is not required. Pi and other extensions have their own
networking settings. An Ollama server on your LAN still requires LAN access.

## Commands

| Command | Result |
| --- | --- |
| `/context` | Built-in Pi selector with model, requested/effective capacity and persistence status |
| `/context 8192` | Set 8,192 tokens |
| `/context 16k` | Set 16,384 tokens; `k` means 1,024 |
| `/context show` | Read allocation/status without loading a model |
| `/context auto` | Choose an auto-compaction threshold interactively |
| `/context auto 80` | Compact at 80% (custom whole percentages 1–95 accepted) |
| `/context auto off` | Disable threshold compaction for this managed model; manual/overflow recovery remains |
| `/context auto show` | Show usage and whether the threshold is active |
| `/context reset` | Remove the saved preference and select the untouched original; requires an empty `/new` session |

Custom values must be whole numbers between 512 and 1,048,576, and must not
exceed the original model's reported context maximum. A missing maximum,
unsupported model or unverifiable allocation is an error, not an assumed success.
A larger setting can take time to load and use substantially more RAM/VRAM.
The command waits for verification and shows a working status.

Preferences are private, atomically written JSON in
`~/.pi/agent/pi-ollama-context.json` (or `$PI_CODING_AGENT_DIR`). They are keyed
by endpoint and original model. API keys and conversation content are not saved.
Switching back to that original model restores its preference. The server must
still have the original and derived models installed after an Ollama restart.

## What actually changes

Ollama's OpenAI-compatible API does not provide a reliable per-request
`num_ctx` control. The extension uses native `/api/create` to derive a model:

```json
{"model":"your-model-ctx8k-<unique-id>:latest","from":"your-model","parameters":{"num_ctx":8192},"stream":false}
```

This is the API equivalent of `FROM your-model` plus `PARAMETER num_ctx 8192`.
**The weight blobs are shared**, not copied. A new context can still need a
separate memory allocation. Original models are never edited or deleted.
Variants are reused for a repeated identical selection when their digests match;
changing sizes can leave additional variants. Reset/uninstall does not delete them.

Before reporting success, the extension checks the saved parameter and digests,
loads the model **without a request-level context override**, and requires
`/api/ps` to report exactly the requested `context_length`. Unknown or mismatched
allocation fails. Before each managed inference it checks again, reloading an
evicted model if necessary. It then uses Pi's existing OpenAI-completions
transport, targeting the verified derived model.

Pi receives the same context capacity through a separate `ollama-context`
provider and virtual model. **The `ollama` provider is never replaced.** Pi only
routes to catalog models, so this separate catalog is necessary to preserve
correct limits across discovery refreshes. No inference transport is reimplemented.
See [architecture](docs/architecture.md).

## Usage footer and native auto-compaction

Pi already includes a context percentage in its native footer and `/compact`.
This extension adds a compact status line with an explicit numerator and your
managed model's verified capacity:

```text
ctx ~6,144 / 8,192 · 75.0% · auto 80%
```

Usage comes from Pi's **current conversation** accounting, not cumulative session
billing totals or Ollama's memory allocation. It includes provider-reported usage
and estimates for newer messages. `~` means estimated. The display refreshes after
assistant/tool messages, turns, model changes and compaction. It is not a live
per-token GPU cache monitor. After compaction Pi can report usage as unknown until
the next response: the footer shows `?`, never the stale pre-compaction percentage.

```text
/context auto       # selector: presets, custom percentage, or off
/context auto 70    # set your own threshold for this model
/context auto 80    # default
/context auto off   # disable threshold compaction for this model
/context auto show
/compact           # Pi's native manual compaction
```

The threshold persists per original model and endpoint, and survives context-size
changes. New `/context SIZE` selections configure 80% by default. **Upgrading from
0.1.0:** install the new tag, restart Pi, select your managed model and run
`/context auto 80` once to activate its native budgets. Pending/overridden settings
are labelled in the footer rather than falsely reported as active.

The extension writes only its own exact model keys in
`~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`), takes a private
backup before edits, uses Pi's settings-lock convention and reloads Pi automatically
to activate the change. Conversation history is preserved by that reload. It does
not change the global compaction switch or other providers. If Pi auto-compaction
is disabled in `/settings`, the footer says so; enable it there if desired.
Project settings can override the saved values and are never rewritten.

Pi's native compaction runs at its next eligible checkpoint once usage reaches the
threshold **and enough history exists to summarize**. It does not interrupt each
streaming token. Pi generates the summary and keeps the original session log. The
retained recent-history budget scales down to at most 1/16 of the small context,
so Pi's default 20K retained history cannot prevent a 4K/8K session from compacting.
The remaining history is summarized, not deleted from the session file. Very low
thresholds cause frequent summaries; high thresholds leave less headroom for tool
results and replies. An unusually large single message can still exceed capacity.

The footer shows `compacting…` during summarization and reports failures. Manual
`/compact` and Pi's overflow recovery remain available even with our threshold off.
Compaction can lose detail, and model-generated summaries can contain mistakes.
It helps manage context pressure; it **does not guarantee against hallucinations**.

## Conversations and small contexts

Changing capacity does not clear or rewrite history and is refused during active
turns/queued messages. For a new capacity, the conservative UTF-8 byte bound plus
output reserve remains in place. For ordinary requests after this managed model
has responded, the guard uses Pi's current usage estimate, including newer content,
plus the output reserve. Unknown usage falls back to the byte bound. Neither is
an exact model-specific tokenizer. Native compaction requests are budgeted by Pi's
summary generator using the verified physical model limits; the source history is
not incorrectly treated as the final summarization prompt.

A full coding-agent prompt/toolset may not fit a 4K or 8K safety budget. For a
minimal text-only session, Pi supports `--no-tools --system-prompt "Reply briefly."`.
Keep a larger window, `/compact`, or start `/new` when needed. The request output
reserve remains between 128 and 2,048 tokens (one eighth of the context). Ordinary
managed requests explicitly send Ollama’s `max_tokens` limit; a smaller caller
limit is preserved. This prevents a missing transport limit from consuming the
space reserved for the response.

## Compatibility and limitations

- Tested together: **Pi 1.3.0 + pi-ollama 1.0.3**, both extension orders, including native threshold compaction, usage display and
  `/ollama-refresh`, `/ollama-info`, actual inference, restart and model switching.
  No pi-ollama files are changed; all its commands, including `/ollama-fix`, remain registered.
- Current Pi 1.5 declarations were also reviewed/type-checked; its binary was not
  part of the runtime test matrix. Conversation inspection supports both API forms.
- Tested real Ollama **0.40.5**, SmolLM2 135M, CPU and NVIDIA GTX 1060 via Vulkan.
  4K/8K allocations were verified before and after inference and after reload.
  Gemma 4 E2B/E4B are intended to work through the same local completion API,
  subject to their reported limits and memory, but **were not hardware-tested**.
- Text conversations only. Image/audio token budgets are unsupported. Cloud and
  embedding-only models are rejected. No speculative GPU-placement claims:
  status reports Ollama's size/VRAM counters, not “fully GPU loaded.”
- The selected model must use `ollama` / `openai-completions` with a base URL
  ending in `/v1`. Prefixes such as `/ollama/v1` are retained for native API calls.
  Reverse proxies must also expose authenticated `/api/show`, `/api/tags`,
  `/api/create`, `/api/generate` and `/api/ps` on the matching prefix.
- Allocation verification is a point-in-time check. Another application can
  mutate or reload a variant after that check; Ollama offers no atomic reservation
  spanning verification and inference. Avoid editing managed variants externally.
  Configurations where parallel scheduling reports a different allocation are
  rejected; the extension never changes server concurrency settings.
- If the original model changes, run `/context SIZE` again. A fresh variant is
  created instead of silently using old weights. Failed operations can leave an
  unselected variant, retained for inspection. No automatic model deletion.
- Reset returns control to the original provider. Its context metadata can again
  follow pi-ollama's discovery defaults after a refresh; no context override remains.
- Loading/creation times out after three minutes; other requests after 15 seconds.
  A server still loading can be retried. Errors leave the original model intact.

## Development and tests

```sh
npm test                         # no npm install needed
python3 scripts/fetch-test-tools.py /path/to/disposable/fixtures
export PI_BINARY=/path/to/disposable/fixtures/pi/pi/pi
export PI_OLLAMA_EXTENSION=/path/to/disposable/fixtures/discovery/package/extensions/index.ts
npm run test:pi                  # real Pi + real discovery; mock HTTP server
```

`fetch-test-tools.py` downloads fixed, checksum-verified Linux x86-64 test
artifacts only. It is not an install hook. The unit and Pi tests use disposable
settings, never your normal Pi configuration. GitHub Actions runs both suites.

Optional real tests **create and retain derived models**; use a disposable server:

```sh
export TEST_OLLAMA_URL=http://127.0.0.1:11434
export TEST_OLLAMA_MODEL=smollm2:135m
npm run test:ollama
node --experimental-strip-types test/real-pi-smoke.ts
```

See [test evidence](docs/testing.md) and [security notes](SECURITY.md).

## Upstream references

- [Ollama OpenAI compatibility and context configuration](https://docs.ollama.com/api/openai-compatibility)
- [Native model creation](https://docs.ollama.com/api/create), [running allocations](https://docs.ollama.com/api/ps)
- [Pi native compaction](https://pi.dev/docs/latest/compaction), [settings](https://pi.dev/docs/latest/settings)
- [Pi extensions](https://pi.dev/docs/latest/extensions), [virtual models](https://pi.dev/docs/latest/virtual-models)
- [pi-ollama](https://github.com/jamesjfoong/pi-ollama)

MIT licensed. Independent project; not an official Pi or Ollama component.

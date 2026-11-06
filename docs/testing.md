# Validation record — 2026-11-06

## Automated tests

- 39 Node tests, no installed dependencies: interactive preset/custom/cancel,
  numeric parsing, invalid/unsupported inputs, persistence, restart, multiple
  models, endpoint isolation, private settings, lock/corruption handling, safe
  history rejection, busy sessions, reset retention, CPU/GPU status, unload/reload,
  digest drift, allocation mismatch, offline/unreachable server, auth/proxy paths,
  model refresh object identity, Pi 1.5 projection compatibility and compaction.
- Real **Pi 1.3.0** binary with real **pi-ollama 1.0.3** loaded simultaneously in
  both orders, using a mock HTTP server: Pi UI selector, commands, actual outgoing
  derived-model ID and auth, `/ollama-refresh`, `/ollama-info`, model switching,
  preference restoration in a second process, and fail-closed request routing.
- TypeScript 5.9.3 strict source check against reviewed Pi 1.5.0 declarations
  (declaration dependency checks skipped). This is not a runtime Pi 1.5 test.

## Real allocation and inference

Disposable loopback-only **Ollama 0.40.5**; **SmolLM2 135M** model digest:

```text
9077fe9d2ae1a4a41a868836b56b8163731a8fe16621397028c2c76f838c6907
```

| Backend | Requested | `/api/ps` context | Allocation bytes | VRAM bytes |
| --- | ---: | ---: | ---: | ---: |
| CPU | 4096 | 4096 | 383212583 | 0 |
| CPU | 8192 | 8192 | 505528974 | 0 |
| GTX 1060 3GB, Vulkan | 4096 | 4096 | 381828463 | 381828463 |
| GTX 1060 3GB, Vulkan | 8192 | 8192 | 502959963 | 502959963 |

For each size/backend, tests checked the original digest remained unchanged,
original and variant `FROM` referenced the same weight blob, an OpenAI-compatible
chat completion succeeded, allocation remained correct after inference, and
unloading/reloading recovered the saved allocation without a num_ctx override.
VRAM equality is a reported allocation metric, not a general claim that all
execution is on GPU.

Full real Pi + pi-ollama smoke tests on CPU and GPU Ollama additionally set `/context 8192`,
refreshed discovery, generated a response with `stopReason: stop`, and confirmed
8,192 tokens still allocated. These used a small system prompt and no coding tools.

No production Ollama service, Pi configuration, drivers or system services were
modified. Test servers and settings are disposable. The real tests retain derived
models intentionally; do not point them at a production server expecting cleanup.

## Not established by these tests

Gemma 4 E2B/E4B inference, AMD/Apple/Intel GPU behavior, Windows/macOS Pi execution,
all proxy authentication schemes, every historical Ollama release, exact tokenizer
budgeting, and allocation stability under concurrent external model edits are not
covered. Real tests are opt-in rather than downloading model weights in CI.

## Fixture provenance

- Pi 1.3.0: official `earendil-works/pi` Linux x86-64 release, published 2026-10-15;
  SHA-256 `24f5be328b66d4da36876296989501974f43ab8434fbb57c35c523a3ea505ded`.
- pi-ollama 1.0.3: official scoped npm package, published 2026-09-10; SHA-512
  pinned in `scripts/fetch-test-tools.py`. No lifecycle hooks or package dependencies
  are installed by our test setup. Upstream source is not copied into this repository.
- Ollama 0.40.5: official `ollama/ollama` release, published 2026-10-14; Linux amd64
  archive SHA-256 `dc5eabc292f9949546c90a97c820f924b035e05243b0de13c7f366182562169c`.
- CI actions are pinned to full upstream commits; Node is pinned to 22.22.2.
  Checksums identify reviewed artifacts; they are not a claim of universal safety.

## 0.2.0 additions

Threshold parser/boundaries, exact native reserve arithmetic, current-vs-cumulative
usage formatting, unknown usage, private settings backups, shared settings locks,
corruption handling, unrelated/global settings preservation, custom threshold
persistence, selector/custom/off behavior, project override status and compaction
success/failure states are covered by the expanded unit suite.

The real Pi RPC suite now drives deterministic provider usage from below 80% to
6,554 / 8,192 tokens, verifies native summary requests and a saved compaction result,
checks the footer's unknown post-compaction count, disables the threshold and proves
manual compaction still works. Both extension registration orders pass. Provider
usage is simulated in this suite; this proves Pi scheduling and integration, not
real-model tokenizer counts.

A real CPU Ollama run additionally set a custom 1% test threshold (to exercise the
path quickly), exchanged real messages, recorded a native compaction result,
showed unknown usage afterward and verified the allocation remained 8,192 tokens.
This used Pi 1.3.0, pi-ollama 1.0.3 and SmolLM2 135M; no claim is made about the
quality of that tiny model’s summary. The unit and real Pi request tests also
check the explicit `max_tokens` output limit.

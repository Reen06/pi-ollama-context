# Changelog

## 0.2.0 — 2026-11-06

- Footer shows estimated current conversation tokens / allocated capacity and percentage.
- `/context auto` selector plus configurable 1–95% thresholds, off and show; defaults to 80%.
- Use Pi's native per-model compaction engine with smaller retained-history budgets.
- Preserve other providers, global auto-compaction state and project overrides; back up settings.
- Show unknown usage after compaction and visible compaction/failure states.
- Use calibrated Pi usage for ongoing requests; let Pi budget native summary requests.
- Recognize loaded Ollama aliases by exact manifest digest without relaxing context verification.
- Added native Pi compaction tests in both extension orders and threshold/status tests.
- Send an explicit output limit on managed inference so ordinary replies respect the reserved response budget.

## 0.1.0 — 2026-11-06

- `/context` selector, token counts and `k` suffixes, status and reset.
- Persistent derived Ollama models with live allocation verification.
- Pi virtual routing and separate verified catalog; pi-ollama remains unchanged.
- Per-endpoint/model preferences, safe history checks and small-context handling.
- CPU/GPU allocation status, no model deletion or system changes.
- Zero runtime dependencies; unit, real Pi/discovery and real Ollama tests.

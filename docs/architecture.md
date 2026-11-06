# Architecture

The extension has three modules, uses Node built-ins and fetch, and has no runtime
package dependencies. `core.ts` handles parsing, endpoint selection, atomic
preferences, native Ollama operations and allocation verification. `index.ts`
uses Pi's official TypeScript API for a command, built-in dialogs, model routing,
session/model selection hooks, and native per-model compaction settings. `usage.ts` formats the usage footer and safely updates only managed model compaction keys.

## Change transaction

1. Require an idle Pi session and an `ollama` OpenAI-completions model. Resolve
   its authentication through Pi. Preserve the selected `/v1` URL's proxy prefix.
   Never consult a hard-coded localhost fallback or put secrets in preferences.
2. Validate input and conservatively check existing conversation size. Read
   `/api/show` to reject cloud/embedding models and requests above the reported
   architectural maximum. Read the original digest from `/api/tags`.
3. Reuse an intact variant for an identical saved selection, or create a uniquely
   named model using `{from: original, parameters: {num_ctx: requested}}`.
   Original weights are content-addressed blobs shared by both manifests.
   A random 128-bit suffix and pre-create collision check avoid overwriting models.
4. Verify variant digest and `num_ctx`; load it without a num_ctx override if
   needed. Require `/api/ps.context_length === requested`. A missing field is an
   error. No model load success or UI metadata is accepted as allocation proof.
5. Recheck selected model, endpoint, session/branch and idle state. Background
   discovery may replace the model object without changing identity; this is
   allowed. A real user selection/session change aborts the switch.
6. Register the physical catalog entry under `ollama-context`, atomically save
   the preference, and select its virtual entry. Failure to select rolls back the
   preference. An unselected variant may remain; no automatic deletion occurs.

## Why a separate catalog and virtual entry?

Simply calling `setModel({...model, contextWindow})` does not survive provider
refreshes. Registering an `ollama` provider ourselves would replace pi-ollama's
catalog. A virtual route alone is also insufficient: Pi resolves returned models
back to physical catalog entries, discarding ad-hoc returned metadata.

Therefore `ollama-context` contains physical derived entries with verified
limits and a virtual selection per original model/endpoint. A route checks the
committed preference, conversation budget (Pi usage after a matching model response, otherwise a conservative byte bound), current source/variant digests,
persisted parameter and live allocation, then refreshes its physical entry using
the original model's transport, current credentials, URL and compatibility flags.
It never replaces `ollama`, implements a duplicate inference transport, or adds
model-facing tools. Physical entries are visible in Pi's catalog; selecting a
managed physical entry is redirected to its corresponding virtual entry.

Router exceptions terminate inference. Ordinary Pi event-handler exceptions may
only be logged while processing continues, so those are not used as a security
or allocation enforcement mechanism. RPC tests prove verification failure sends
no inference request.

## Persistence, discovery and concurrency

Preferences use endpoint/model identity, immutable digests and requested size.
They restore when Pi starts or selects the original model. Virtual entries are
registered before background discovery; their route waits until a usable
original provider entry exists or fails with refresh instructions. No assumptions
about extension order or pi-ollama cache timing are required.

A per-process operation guard prevents overlapping commands. Settings use an
exclusive lock, fresh read, private temporary file, fsync and rename. A crash can
leave a lock; only remove it after confirming no context operation is running.
Every route re-reads preferences, so a change/reset from another Pi process
invalidates an old route rather than silently using a stale context.

There is no distributed lock on Ollama. Allocation is checked immediately before
routing, but another client can modify a model afterwards. The extension cannot
promise an atomic context reservation or an exact model-specific token count.
Its byte bound covers the Pi transcript, not arbitrary server-side template
expansion or prompt modifications by other extensions after routing. Avoid
external edits to managed models. The safeguards are intentionally conservative,
not a replacement for server-side isolation.

## Reset and recovery

Reset needs a new empty conversation because the original default may be
smaller. It loads and observes the original, switches back, then removes the
preference. Variants remain. Original provider metadata is again owned by
pi-ollama and can change on refresh. Deleting a variant is always a separate,
explicit user operation using Ollama; the extension has no delete API call.

Endpoint failures, authorization failures, unknown limits, allocation mismatch,
changed digests and unsafe histories all leave the original model intact.

## Native compaction integration (0.2.0)

`/context auto PERCENT` persists a per-model preference and writes `reserveTokens`
and `keepRecentTokens` overrides for both the virtual and physical catalog keys.
The reserve implements Pi's strict `tokens > window - reserve` trigger at the first
integer token count at/above the requested percentage. The retained-history budget
is `floor(window * min(percent/200, 1/16))`; a smaller tail makes summarization
possible with small contexts. Off cancels only threshold compaction, not manual or
overflow recovery. Pi still needs enough source history to find a valid cut point.

Settings edits acquire the same `.lock` directory convention as Pi's file storage,
read fresh JSON, preserve unrelated keys, save a private backup and atomically
replace the file. The command invokes Pi's official reload method, then returns
without using the stale context. Global disabled state and project overrides are
respected and shown. No extension timer, model-facing tool or replacement summarizer
is introduced. An upgrade's existing preferences show pending until configured.

The status uses `ctx.getContextUsage()` and the managed capacity, updating at
message/turn/compaction/session events. Native usage is an estimate, can exceed
100%, and is unknown immediately after compaction. Those states are displayed
without clamping or inventing precision. Native summary routing continues to
verify Ollama allocation, but doesn't apply the normal request byte-bound to the
source history: Pi constructs and budgets a separate summary request afterwards.

Managed ordinary inference payloads explicitly use Ollama’s documented `max_tokens`
field, capped at the response reserve and preserving a tighter caller limit. This
is a convenience payload hook, not a security boundary against other extensions
that subsequently rewrite the payload. Allocation verification remains in the
fail-closed virtual route.

# Security

The extension needs permission to create/load derived models on the Ollama server
selected in Pi. Ollama credentials are resolved by Pi and used only for that
endpoint. Native API redirects are refused. URLs with embedded credentials,
query strings or fragments are rejected. Preferences contain endpoint names and
model metadata but no keys, headers or conversations.

Do not expose an unauthenticated Ollama service to the public internet. A reverse
proxy must protect both native `/api/*` and compatible `/v1/*` routes. The extension
does not edit firewall rules, install services, download models, delete models,
change drivers, or run model-generated configuration commands.

Large context allocations can exhaust RAM/VRAM. Loading failures are surfaced;
there is no automatic lower-context fallback. Context snapshots are not atomic
reservations against other clients. Conversation budgeting is conservative but
not an exact tokenizer; see the architecture notes for scope and limitations.

Native compaction settings are changed only for this extension’s model entries in
Pi’s user settings, under a settings lock with a private backup. Global and project
settings remain authoritative. Usage is an estimate, and compaction summaries are
model-generated: neither is a guarantee of factual accuracy or exact token fit.

Report bugs in GitHub issues, without API keys, private prompts or unredacted
server configuration. For a sensitive vulnerability, use GitHub private vulnerability
reporting if enabled; otherwise open an issue requesting a private contact without
publishing exploit details or secrets. There is no automated npm publishing workflow
or production deployment credential in this repository.

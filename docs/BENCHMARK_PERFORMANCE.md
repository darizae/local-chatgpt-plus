# MCP performance / byte baseline — P1.6, P2.2, P2.3, P2.4

Reproducible evidence from `scripts/benchmark-performance.mjs`. Runs on
disposable temp directories and random loopback ports; spawns `dist/index.js`
with `INBOUND_AUTH_MODE=token`, `LOCAL_CODER_TUI=off`, `MCP_SESSION_RECOVERY=false`,
and a fresh `.mcp-state` per run. It never touches the live server, tunnel,
`.env`, credentials, real state, or any other checkout.

## Environment (single machine; no cross-version comparison)

- macOS 26.6.2, arm64 (darwin)
- Node v26.13.0
- Worktree `agent/performance`, build `npm run build` (tsc) clean
- Commands: `node scripts/benchmark-performance.mjs runs=<n> warm=<n>`

## P1.6 — cold start to ready + tool latency/bytes

Raw samples (4 cold runs per profile×admin cell, 6 warm tool calls):

| profile | admin | t_health ms | t_list ms | RSS KiB |
|---|---|---|---|---|
| full | on | 214/221/225/224 | 10–12 | 122544–123296 |
| slim | on | 223/221/224/223 | 8 | 120864–121968 |
| full | off | 220/223/222/224 | 9–10 | 121824–122272 |
| slim | off | 223/223/223/259 | 8–9 | 119920–121376 |

- Cold start to `/health`: **~220 ms** across all cells; `tools/list` ready adds **~8–12 ms**.
- RSS after ready: **~120–123 MiB**, nearly profile/admin-independent.
- Slim/full and admin on/off do **not** materially change cold start or RSS.

Warm tool latency (p50/p95) and result `content[0].text` bytes:

| tool | p50 ms | p95 ms | bytes p50 | bytes p95 |
|---|---|---|---|---|
| read_text_file (small, 40 B file) | 1.5 | 5 | 403 | 404 |
| read_text_file (large, ~1 MiB) | 4.5 | 6 | 277237 | 277238 |
| grep (`DATA` in 1 MiB fixture) | 3 | 5 | 229246 | 229246 |
| run_command (`node -e ...`) | 422.5 | 423 | 409 | 409 |
| repo_intel (symbol_search `hello`) | 2 | 3 | 507 | 507 |

`tools/list` wire bytes (identical across runs): **full = 71 tools / 90,682 B**,
**slim = 42 tools / 59,423 B**.

## P2.2 — optional-import startup cost

Admin on/off delta above is **~0 ms**; TUI already excluded from the measured
boot (`LOCAL_CODER_TUI=off`). Only `node-pty` is statically imported at startup
among the optional native deps (`pyright`/`typescript-language-server`/
`typescript-lsp` are spawned on demand, never `import`ed at boot).

Experiment: lazy-loading `node-pty` via `await import()` was prototyped in
`src/tools/pty.ts`. Cold start did **not** improve (before ~192–301 ms, after
~219–270 ms; medians both ~220 ms) — the standalone `node -e import('node-pty')`
cost (~160 ms) reflects fresh-process interpreter startup, not in-process addon
load. **Decision: keep-as-is**, revert the lazy import (it adds a dynamic import
against house style with zero measured boot gain).

## P2.3 — text/structured payload duplication

Large `read_text_file` result (identical payload serialized in both fields):

| metric | value |
|---|---|
| `content[0].text` bytes | 277238 |
| `structuredContent` bytes | 277238 |
| duplicate overhead | 277238 B per call |
| full JSON-RPC wire | 560597 B |
| content-only wire (no structuredContent) | 283338 B |
| wire amplification (`full / content_only`) | **1.979×** |

Every tool result carries the payload twice: once as the `content[0].text` JSON
string and again as the identical `structuredContent` object. `toolResult` in
`src/lib/tool-result.ts` is the single source of this envelope.

**Decision: keep-as-is.** `structuredContent` is the machine-readable channel
that clients honoring structured data consume; `content[0].text` is the
human-readable channel the MCP spec requires. Dropping either breaks a client
class. The 2× wire cost is inherent to serving both. A compact representation
would need an explicit interoperability suite before adoption (backlog P2.3
acceptance), which is out of scope for this pass. Documented as the dominant
byte cost and a candidate if a future client contract allows content-only mode.

## P2.4 — snapshot/hook/state duplication review

- All durable state stores (`agent-task`, `operation`, `coding-loop`,
  `parallel-batch`, `idempotency`, `edit-transaction`, `context-capsule`,
  `result`, `worker-registry`) already share the single `atomic-file.ts` writer.
- Only `checkpoint.ts` (rewind snapshot, distinct recovery/rollback guarantees)
  and `context-capsule-store.ts` use their own temp/rename paths; these are
  intentionally separate workflows (backlog note: "do not merge stores that only
  look similar but have different recovery or rollback guarantees").
- **Decision: keep-as-is.** No genuine trivial duplicate to consolidate without
  risking distinct recovery semantics.

## Disposition

- P1.6: reproducible baseline + harness delivered (evidence above); no
  optimization warranted by the measured data.
- P2.2 / P2.4: keep-as-is with measured/review evidence.
- P2.3: keep-as-is; 2× structured duplication quantified as the top byte cost,
  deferred pending a compatibility-gated content-only mode.
## Recheck 2026-11-21 — isolated follow-up

A first attempt launched the harness without a compiled `dist/index.js` in a new
worktree; the child exited early and `stopChild` awaited an already-emitted exit
notification, causing an unsettled top-level await. This is a **harness failure**,
not a valid startup sample. `scripts/benchmark-performance.mjs` now checks
pre-exited children and handles the process exit/error lifecycle safely.

After `npm run build`, a fresh `runs=2 warm=3` baseline completed on the same
macOS/Node platform. Cold-start `/health` samples ranged **271–501 ms**,
with `tools/list` adding **10–34 ms**. Warm p50 (ms): read-small 3,
read-large 7, grep 9, command 114, repo-intel 2. These samples have high
variance and low replication; no production optimization is justified.

Full tools/list: **71 tools / 91,152 bytes**; slim: **42 / 59,893 bytes**.
For the large read, text = structured = **277,240 bytes**, full wire =
**560,601 bytes** versus content-only **283,340** (**1.979×**). The
compatibility-preserving decision remains keep-as-is.

**Unfinished P1.6 acceptance:** controlled apply_patch/verify_project,
background-process lifecycle and TUI-on cold startup remain unmeasured.
The benchmark and fixtures never touched the live service, tunnel or state.

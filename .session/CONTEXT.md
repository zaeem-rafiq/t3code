# Context Receipt

- RECEIPT_SHA: 527b1f6
- RECEIPT_DATE: 2026-07-09

## What this is

T3 Code is a web/desktop/mobile GUI for driving coding agents (Codex, Claude
Code, Cursor, OpenCode — plus Grok and a newly merged Google Antigravity
provider in this fork). A Node.js WebSocket server (`apps/server`, published as
the `t3` npm package) wraps provider CLIs — chiefly `codex app-server` over
JSON-RPC/stdio — and serves a React web app; Electron desktop and Expo mobile
apps ride the same server boundary. The upstream project (pingdotgg/t3code)
self-describes as "VERY EARLY WIP" and is not accepting contributions; this
repo (zaeem-rafiq/t3code) is a fork whose only divergence from upstream is
PR #1 adding the Antigravity provider integration (commit a905c9a, merged as
527b1f6). Audience: developers who want a unified GUI over multiple terminal
coding agents, locally or (per the remote-architecture doc, aspirationally)
against remote environments.

## What exists and works vs half-built vs dead

**Exists and works (tested, shipped):**

- `apps/server` — the core coordinator: WebSocket + HTTP server,
  ServerPushBus (ordered pushes), ServerReadiness startup gate,
  OrchestrationEngine, ProviderService, CheckpointReactor, queue-backed
  background workers, typed "runtime receipt" signals for tests. Heavily
  tested (provider Layers alone have ~18 test files).
- Provider integrations, each with Driver + Adapter + Provider layers and
  adapter tests: Codex, Claude, Cursor, OpenCode, Grok, Antigravity.
- `apps/web` — React/Vite UI (session UX, event rendering, client state);
  largest test concentration in the repo.
- `apps/desktop` — Electron app with real release tooling (dmg/nsis/AppImage
  build scripts, smoke tests, auto-update work in recent commits); distributed
  via winget/brew/AUR.
- `packages/contracts` (schema-only Effect/Schema contracts),
  `packages/shared` (subpath-export runtime utils), `packages/client-runtime`
  (web+mobile shared client code) — all with tests.
- 533 test files total across apps/packages; CI gates are `vp check` +
  `vp run typecheck` (+ `lint:mobile` for native changes).

**Half-built / in flight:**

- `apps/mobile` (Expo/React Native) — very active recent churn: split-view
  iPad layout, Live Activity fixes, scroll/back-swipe fixes, many patched
  native deps; clearly usable but stabilizing.
- "T3 Connect" cloud onboarding (Clerk auth) — landed, reverted, re-landed
  within the last ~15 commits; `docs/cloud/` describes the auth flow.
- `infra/relay` — Cloudflare-targeted relay (Alchemy, Drizzle, Postgres,
  Clerk backend) for the remote story; `docs/architecture/remote.md` is
  explicitly a _target_ architecture, not shipped product.
- Grok provider — implemented and tested but absent from README's supported
  list (Codex/Claude/Cursor/OpenCode only).
- `.plans/` — nine numbered refactor plans (typed IPC boundaries, ChatView
  split, CI quality gates, etc.); status of each not recorded in-repo.
- `docs/project/todo.md` — small UX gaps open (scroll-to-bottom on submit,
  thread archiving, project sorting, message queueing).

**Dead / inert:**

- `experiments/messages-glass-lab` — a UI experiment sandbox.
- Nothing else obviously abandoned; only 2 TODO/FIXME markers in source.
- `.repos/` vendored reference repos are intentionally read-only and not
  present in this clone (managed via `bun run sync:repos`).

## Constraints inferred

- **Stack:** TypeScript ESM monorepo; pnpm 11 workspaces + catalog; Vite Plus
  (`vp`) as the build/test/lint toolchain (a hard prerequisite — `vp i`,
  `vp check`, `vp test`); Node ^24.13; Effect 4.0.0-beta.78 everywhere
  (pinned + patched); `@effect/tsgo` / TypeScript native preview 7.0-dev;
  oxlint with a custom in-repo plugin; React web, Electron desktop,
  Expo/React Native mobile.
- **Integrations:** provider CLIs (codex, claude, cursor-agent, opencode,
  antigravity, grok) spawned as subprocesses; Claude Agent SDK and OpenCode
  SDK as server deps; Clerk for cloud auth (versions pinned with wallet-SDK
  subdeps stripped); Cloudflare/Alchemy + Postgres for the relay; node-pty
  terminals; SQLite (bun sql) on the server.
- **Non-negotiables (from AGENTS.md):** performance and reliability first;
  predictable behavior under load/failures (restarts, reconnects, partial
  streams); correctness over convenience; extract shared logic rather than
  duplicating; keep `packages/contracts` schema-only, no runtime logic; no
  barrel exports in `packages/shared`; `vp check` + typecheck must pass before
  a task counts as done; the WebSocket server boundary is deliberately
  preserved for the remote story; sizable patch set on native/Effect deps
  means dependency bumps must keep patches and vendored `.repos/` in sync.
- **Provider pattern (documented in docs/solutions):** new providers follow a
  fixed 3-layer shape — Driver, Adapter (+ AcpSessionRuntime where ACP-based),
  Provider health probe, TextGeneration — registered in contracts
  (`model.ts`, `settings.ts`), `builtInDrivers.ts`, and web settings/icon maps.

## Assumptions (ranked)

- **HIGH** — This fork exists specifically to develop the Antigravity provider
  against upstream pingdotgg/t3code; all other history is upstream's.
- **HIGH** — `vp` (Vite Plus) tooling is required for any build/test work;
  plain `npm`/`vite` workflows will not match CI.
- **HIGH** — `apps/server` + `apps/web` are the stable core; contracts define
  the wire boundary and are treated as the source of truth for events.
- **MED** — The remote/relay architecture (`docs/architecture/remote.md`,
  `infra/relay`) is aspirational/in-progress rather than shipped; local
  execution remains the primary mode.
- **MED** — Grok and Antigravity are intentionally unadvertised (README
  unchanged) because they are experimental or fork-local.
- **LOW** — The `.plans/` refactor documents reflect current intent; some may
  already be completed or superseded (e.g. CI quality gates appear to exist).

## Could not determine

1. Whether the Antigravity provider has been exercised end-to-end against a
   real Antigravity CLI/agent (only unit/adapter tests are visible; no CI run
   or manual-test record in-repo).
2. The live status of T3 Connect / cloud auth — it was reverted and re-landed
   recently, and whether the relay in `infra/relay` is actually deployed
   anywhere is not knowable from the repo.
3. How this fork intends to track upstream (merge cadence, whether the
   Antigravity work is meant to be upstreamed as a PR to pingdotgg/t3code, or
   maintained as a permanent fork).

## Session log — 2026-07-09

- **Goal:** Prove the Antigravity provider works end-to-end — binary
  pass/fail eval harness driving a full turn through the real orchestration
  engine against a scripted fake ACP agent (kills receipt unknown #1).
- **Chosen architecture:** B — in-process orchestration-engine integration
  harness: real AntigravityAdapter + scripted acp-mock-agent, receipt-gated
  binary evals (E1–E10).
- **Phase 1 handoff:** `.session/PHASE1-HANDOFF.md`
- **Phase 1 complete** — happy-path eval E1–E5 green, deterministic 5/5
  (commit `c17991f`).
- **Phase 2 complete** — failure-mode evals E6–E9 green (interrupt+recover,
  failed prompt, missing binary, agent-written file diff), deterministic 5/5.
  Mock agent gained additive `T3_ACP_WRITE_FILE_PATH`/`_CONTENT` behavior.
  **Defect found by E6:** interrupted-turn state is not persisted —
  `captureCheckpointFromPlaceholder` promotes a cancelled turn's "missing"
  checkpoint to "ready"/"completed"; see `.session/HANDOFF-FAILURES.md`.
- **Defect FIXED (standing order):** two root causes — the placeholder
  fulfiller promotion in CheckpointReactor (now skips real-ref "missing"
  captures via `isProviderDiffPlaceholderRef`) and the SQLite projection
  pipeline mapping finalized "missing" checkpoints to turn state "completed"
  (now "interrupted", mirroring projector.ts). E6 tightened to assert the
  persisted interrupted state. Details in `.session/HANDOFF-FAILURES.md`.
- **Phase 3 landed as opt-in:** live `agy` test gated on
  `ANTIGRAVITY_BINARY_PATH` (mirrors `CODEX_BINARY_PATH`); skipped in CI.
  Running it against a real binary remains the last [FRONTIER] validation.

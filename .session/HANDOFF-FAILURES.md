# Findings log

## Interrupted-turn state was not persisted — FOUND by eval E6, FIXED (2026-07-09)

**Observed (before fix):** Interrupting a hung Antigravity turn worked
mechanically — the adapter emitted `turn.completed{state:"cancelled"}` and
CheckpointReactor finalized the turn checkpoint as `"missing"` — but the
projected end state read `latestTurn:"completed"` + checkpoint `"ready"`
instead of `"interrupted"` + `"missing"`. The web UI explicitly renders
interrupted turns (`MessagesTimeline.logic.ts:331`), so the state loss was
user-visible, and it affected every ACP-based provider (Antigravity, Grok,
Cursor, OpenCode).

**Two root causes, both fixed:**

1. `captureCheckpointFromPlaceholder`
   (`apps/server/src/orchestration/Layers/CheckpointReactor.ts`) treated ANY
   `thread.turn-diff-completed` with status `"missing"` as a Codex-style
   ingestion placeholder and re-captured it with hardcoded `"ready"`. Fixed by
   distinguishing real captures from placeholders via the checkpoint ref:
   ingestion placeholders use synthetic `provider-diff:<eventId>` refs (now
   built via `providerDiffPlaceholderRef` and detected via
   `isProviderDiffPlaceholderRef` in `apps/server/src/checkpointing/Utils.ts`),
   while reactor captures use real `refs/t3/checkpoints/...` refs and are now
   skipped by the fulfiller.

2. The SQLite projection pipeline
   (`apps/server/src/orchestration/Layers/ProjectionPipeline.ts`,
   `thread.turn-diff-completed` case) mapped a finalized `"missing"` checkpoint
   to turn state `"completed"` (`status === "error" ? "error" : "completed"`),
   diverging from the in-memory projector's `checkpointStatusToLatestTurnState`
   (missing → interrupted). Fixed to mirror the projector: missing →
   `"interrupted"`.

**Verified by:** the tightened E6 eval
(`apps/server/integration/antigravityOrchestration.integration.test.ts`)
asserts the persisted end state after interrupting a hung turn:
`latestTurn.state === "interrupted"`, checkpoint `"missing"`, session
`"ready"`, and a successful follow-up turn — plus the full apps/server test
suite for regressions (the codex placeholder-fulfillment flow still passes:
ingestion placeholders keep being promoted to real captures).

**Residual note:** the pipeline's `thread.turn-interrupt-requested` handler
only marks a turn interrupted when the interrupt command carries a `turnId`;
the client protocol dispatches interrupts without one, so the authoritative
interrupted marking comes from the diff-completed path fixed above.

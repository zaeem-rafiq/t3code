# Findings requiring a product decision

## Interrupted-turn state is not persisted (found by Phase 2 eval E6, 2026-07-09)

**Observed:** Interrupting a hung Antigravity turn works mechanically — the
adapter emits `turn.completed{state:"cancelled"}` (verified via runtime-event
capture), and CheckpointReactor finalizes the turn-1 checkpoint with
`status:"missing"` (the receipt fires). But immediately afterwards
`captureCheckpointFromPlaceholder`
(`apps/server/src/orchestration/Layers/CheckpointReactor.ts` ~line 425) treats
ANY `thread.turn-diff-completed` event with status `"missing"` as a
Codex-style ingestion placeholder and re-captures the checkpoint with
hardcoded `status:"ready"`. The projected end state therefore reads
`latestTurn.state:"completed"` + checkpoint `"ready"` instead of
`"interrupted"` + `"missing"`.

**Why it matters:** the web UI explicitly renders interrupted turns
(`apps/web/src/components/chat/MessagesTimeline.logic.ts:331` checks
`latestTurn.state === "interrupted"`), and the projector has a dedicated
mapping (`checkpointStatusToLatestTurnState`: missing → interrupted) that this
promotion defeats. Any ACP-based provider (Antigravity, Grok, Cursor,
OpenCode) whose interrupt path settles via `turn.completed{cancelled}` is
affected — the "interrupted" state is visible at most transiently.

**Not fixed here:** the fix would modify orchestration core
(CheckpointReactor), which Phase 2's approved scope protects. A plausible fix
is to make `captureCheckpointFromPlaceholder` skip diff-completed events whose
turn settled as cancelled/interrupted (e.g. thread the runtime turn state
through the event, or only fulfill placeholders created by ingestion's
`turn.diff.updated` path rather than reactor-finalized "missing" captures).

**Eval accommodation:** E6 asserts the actual observable contract — the
receipt-level `"missing"` finalization, session recovery to `ready`, and a
successful follow-up turn — with a comment in
`apps/server/integration/antigravityOrchestration.integration.test.ts`
explaining why it does not assert a persisted `interrupted` latest-turn state.
If the promotion behavior is fixed, tighten E6 to assert
`latestTurn.state === "interrupted"` and checkpoint `"missing"` after the
interrupt.

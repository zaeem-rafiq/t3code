# Phase 1 Handoff — Antigravity E2E Orchestration Eval

Copy-paste meta-prompt for a fresh unattended session:

---

You are executing Phase 1 of a pre-approved plan in the repo at
/home/user/t3code (branch claude/repo-context-receipt-z1ofz2). Work
unattended; do not redesign. Read .session/CONTEXT.md first for context.

GOAL: Prove the Google Antigravity provider completes a full turn through the
real orchestration engine, using the existing scripted mock ACP agent. Pure
test-side change; ZERO product code changes.

STEP 1 — Extract a shared wrapper util.
Create apps/server/src/provider/testUtils/acpMockAgentWrapper.ts by extracting
makeMockAntigravityWrapper from
apps/server/src/provider/Layers/AntigravityAdapter.test.ts (lines ~34-47): it
writes a temp fake-antigravity.sh that exports given env vars then
`exec node <path-to apps/server/scripts/acp-mock-agent.ts> "$@"`, chmod 755,
returns { binaryPath, dispose }. Update AntigravityAdapter.test.ts to import
it (no behavior change).

STEP 2 — Add a real-Antigravity path to the integration harness.
In apps/server/integration/OrchestrationEngineHarness.integration.ts:

- Extend MakeOrchestrationIntegrationHarnessOptions (lines ~223-226) with
  `realAntigravity?: { readonly binaryPath: string }`.
- Clone realCodexRegistry (lines ~268-281) into an antigravityRegistry:
  decode AntigravitySettings with { binaryPath } (see how
  decodeCodexSettings is built at line ~82; the antigravity equivalent
  decodes the AntigravitySettings schema from @t3tools/contracts), then
  `yield* makeAntigravityAdapter(settings)` (import from
  ../src/provider/Layers/AntigravityAdapter.ts), then
  makeAdapterRegistryMock({ [ProviderDriverKind.make("antigravity")]:
  adapter }), with the SAME provideMerge stack (ServerConfig.layerTest,
  NodeServices.layer, providerSessionDirectoryLayer).
- Generalize the useRealCodex branch at lines ~283-295 to pick
  antigravityRegistry when options.realAntigravity is set.

STEP 3 — Write the Phase 1 test.
Create apps/server/integration/antigravityOrchestration.integration.test.ts
modeled on orchestrationEngine.integration.test.ts (read its happy-path test
and seedProjectAndThread first). Specifics that differ from the codex test:

- Build the wrapper with extraEnv
  { T3_ACP_PROMPT_RESPONSE_TEXT: "antigravity-e2e-ok" } and pass
  realAntigravity: { binaryPath: wrapper.binaryPath } to
  makeOrchestrationIntegrationHarness.
- Seed with EXPLICIT modelSelection { instanceId: "antigravity",
  model: "default" } — do NOT rely on seedProjectAndThread's provider
  derivation (adapterHarness is null in real-adapter mode and it silently
  falls back to codex), and do NOT use DEFAULT_MODEL_BY_PROVIDER
  ("auto" is not in the mock's model list). runtimeMode "full-access",
  worktreePath: harness.workspaceDir.
- Dispatch project.create -> thread.create -> thread.turn.start with a user
  message, then assert ALL of (binary pass/fail, print one line per check):
  E1 waitForReceipt(turn.processing.quiesced for the thread)
  E2 waitForReceipt(checkpoint.diff.finalized, checkpointTurnCount===1,
  status==="ready")
  E3 waitForThread(session.status==="ready" && assistant message text
  contains "antigravity-e2e-ok" && streaming===false &&
  checkpoints.length===1)
  E4 sqlite checkpoint row status "ready" with files: [] (copy the codex
  test's query helper)
  E5 git refs checkpointRefForThreadTurn(threadId, 0) and (threadId, 1)
  exist (gitRefExists helper) and seeded README content intact
  (gitShowFileAtRef).

PROTECTED PATHS — do not modify: anything under apps/server/src/ EXCEPT the
two named test files (acpMockAgentWrapper.ts is new under testUtils;
AntigravityAdapter.test.ts import swap only); packages/contracts/;
packages/effect-acp/src/; apps/server/scripts/acp-mock-agent.ts; patches/;
.repos/; docs/ (except nothing needed).

VERIFY (all must pass; this is the measurable end state):
vp test run apps/server/integration/antigravityOrchestration.integration.test.ts
vp test run apps/server/integration/orchestrationEngine.integration.test.ts
vp test run apps/server/src/provider/Layers/AntigravityAdapter.test.ts
vp check && vp run typecheck
Then run the new file 5 more times in a loop to check determinism.

PROOF OF SUCCESS: paste the vp test output showing the new file passing, plus
one line per E1-E5 check. Commit to branch claude/repo-context-receipt-z1ofz2
with message "test(antigravity): e2e orchestration eval — real adapter +
scripted ACP agent" and push with -u origin.

IF BLOCKED: do not force it. Write what you tried, the exact error, and your
diagnosis to .session/HANDOFF-FAILURES.md, commit that instead, and stop. In
particular, if the turn cannot complete without changing orchestration core
(engine/ingestion/reactor), that is kill-criterion evidence — document it,
don't work around it.

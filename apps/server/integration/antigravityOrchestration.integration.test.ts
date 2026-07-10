import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { checkpointRefForThreadTurn } from "../src/checkpointing/Utils.ts";
import type {
  CheckpointDiffFinalizedReceipt,
  TurnProcessingQuiescedReceipt,
} from "../src/orchestration/Services/RuntimeReceiptBus.ts";
import { makeAcpMockAgentWrapper } from "../src/provider/testUtils/acpMockAgentWrapper.ts";
import {
  gitRefExists,
  gitShowFileAtRef,
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";

const PROJECT_ID = ProjectId.make("project-antigravity-1");
const THREAD_ID = ThreadId.make("thread-antigravity-1");
const ASSISTANT_RESPONSE_TEXT = "antigravity-e2e-ok";

const ANTIGRAVITY_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("antigravity"),
  model: "default",
};

function nowIso() {
  return "2026-05-01T00:00:00.000Z";
}

interface AntigravityHarnessOptions {
  /** Env baked into the mock-agent wrapper; ignored when binaryPath is set. */
  readonly mockAgentEnv?: Record<string, string>;
  /** Explicit binary path (e.g. a nonexistent file for spawn-failure tests). */
  readonly binaryPath?: string;
}

const withAntigravityHarness = <A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
  options?: AntigravityHarnessOptions,
) =>
  Effect.gen(function* () {
    const binaryPath =
      options?.binaryPath ??
      (yield* Effect.promise(() =>
        makeAcpMockAgentWrapper({
          T3_ACP_PROMPT_RESPONSE_TEXT: ASSISTANT_RESPONSE_TEXT,
          ...options?.mockAgentEnv,
        }),
      ));
    return yield* Effect.acquireUseRelease(
      makeOrchestrationIntegrationHarness({ realAntigravity: { binaryPath } }),
      use,
      (harness) => harness.dispose,
    );
  }).pipe(Effect.provide(NodeServices.layer));

const seedProjectAndThread = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const createdAt = nowIso();

    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-antigravity-project-create"),
      projectId: PROJECT_ID,
      title: "Antigravity Integration Project",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: ANTIGRAVITY_MODEL_SELECTION,
      createdAt,
    });

    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-antigravity-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Antigravity Integration Thread",
      modelSelection: ANTIGRAVITY_MODEL_SELECTION,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt,
    });
  });

const startTurn = (
  harness: OrchestrationIntegrationHarness,
  input: { readonly commandId: string; readonly messageId: string; readonly text: string },
) =>
  harness.engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(input.commandId),
    threadId: THREAD_ID,
    message: {
      messageId: MessageId.make(input.messageId),
      role: "user",
      text: input.text,
      attachments: [],
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    createdAt: nowIso(),
  });

const waitForQuiesced = (harness: OrchestrationIntegrationHarness, turnCount: number) =>
  harness.waitForReceipt(
    (receipt): receipt is TurnProcessingQuiescedReceipt =>
      receipt.type === "turn.processing.quiesced" &&
      receipt.threadId === THREAD_ID &&
      receipt.checkpointTurnCount === turnCount,
  );

const waitForFinalizedCheckpoint = (harness: OrchestrationIntegrationHarness, turnCount: number) =>
  Effect.gen(function* () {
    const receipt = yield* harness.waitForReceipt(
      (entry): entry is CheckpointDiffFinalizedReceipt =>
        entry.type === "checkpoint.diff.finalized" &&
        entry.threadId === THREAD_ID &&
        entry.checkpointTurnCount === turnCount,
    );
    if (receipt.type !== "checkpoint.diff.finalized") {
      throw new Error("Expected checkpoint.diff.finalized receipt.");
    }
    return receipt;
  });

it.live(
  "runs a single Antigravity turn end-to-end through the real adapter and mock ACP agent",
  () =>
    withAntigravityHarness((harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* startTurn(harness, {
          commandId: "cmd-antigravity-turn-start",
          messageId: "msg-antigravity-user-1",
          text: "Say hello",
        });

        yield* waitForQuiesced(harness, 1);
        yield* Effect.log("E1 PASS: turn.processing.quiesced receipt observed");

        const finalizedReceipt = yield* waitForFinalizedCheckpoint(harness, 1);
        assert.equal(finalizedReceipt.status, "ready");
        yield* Effect.log("E2 PASS: checkpoint.diff.finalized receipt is ready for turn 1");

        const thread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.status === "ready" &&
            entry.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.streaming === false &&
                message.text.includes(ASSISTANT_RESPONSE_TEXT),
            ) &&
            entry.checkpoints.length === 1,
        );
        assert.equal(thread.checkpoints[0]?.status, "ready");
        assert.equal(thread.checkpoints[0]?.checkpointTurnCount, 1);
        yield* Effect.log("E3 PASS: projected thread ready with mock assistant text");

        const checkpointRows = yield* harness.checkpointRepository.listByThreadId({
          threadId: THREAD_ID,
        });
        assert.equal(checkpointRows.length, 1);
        assert.equal(checkpointRows[0]?.checkpointTurnCount, 1);
        assert.equal(checkpointRows[0]?.status, "ready");
        assert.deepEqual(checkpointRows[0]?.files, []);
        yield* Effect.log("E4 PASS: sqlite checkpoint row ready with empty diff");

        const ref0 = checkpointRefForThreadTurn(THREAD_ID, 0);
        const ref1 = checkpointRefForThreadTurn(THREAD_ID, 1);
        assert.equal(gitRefExists(harness.workspaceDir, ref0), true);
        assert.equal(gitRefExists(harness.workspaceDir, ref1), true);
        assert.equal(gitShowFileAtRef(harness.workspaceDir, ref0, "README.md"), "v1\n");
        assert.equal(gitShowFileAtRef(harness.workspaceDir, ref1, "README.md"), "v1\n");
        yield* Effect.log("E5 PASS: git checkpoint refs exist for turns 0 and 1");
      }),
    ),
);

it.live("interrupts a hung Antigravity turn and recovers on the next turn", () =>
  withAntigravityHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* startTurn(harness, {
          commandId: "cmd-antigravity-turn-hang",
          messageId: "msg-antigravity-hang-1",
          text: "Hang forever",
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) => entry.session !== null && entry.latestTurn?.state === "running",
        );

        yield* harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-antigravity-turn-interrupt"),
          threadId: THREAD_ID,
          createdAt: nowIso(),
        });

        // The adapter settles the cancelled turn with a "missing" checkpoint.
        // CheckpointReactor's placeholder fulfillment then re-captures it as
        // "ready", so the projected end state reads completed/ready rather
        // than interrupted/missing — assert the receipt-level "missing" plus
        // the recovered session, not a persisted "interrupted" latest turn.
        const interruptedReceipt = yield* waitForFinalizedCheckpoint(harness, 1);
        assert.equal(interruptedReceipt.status, "missing");
        yield* waitForQuiesced(harness, 1);
        yield* harness.waitForThread(THREAD_ID, (entry) => entry.session?.status === "ready");
        yield* Effect.log(
          "E6 PASS: hung turn settled after interrupt — checkpoint finalized as missing, session ready",
        );

        yield* startTurn(harness, {
          commandId: "cmd-antigravity-turn-recover",
          messageId: "msg-antigravity-recover-1",
          text: "Say hello",
        });

        const recoveredReceipt = yield* waitForFinalizedCheckpoint(harness, 2);
        assert.equal(recoveredReceipt.status, "ready");
        yield* waitForQuiesced(harness, 2);
        const thread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.latestTurn?.state === "completed" &&
            entry.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.streaming === false &&
                message.text.includes(ASSISTANT_RESPONSE_TEXT),
            ),
        );
        assert.equal(
          thread.checkpoints.some(
            (checkpoint) => checkpoint.checkpointTurnCount === 2 && checkpoint.status === "ready",
          ),
          true,
        );
        yield* Effect.log(
          "E6 PASS: session recovered — follow-up turn completed with ready checkpoint",
        );
      }),
    { mockAgentEnv: { T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1" } },
  ),
);

it.live("surfaces a failed Antigravity prompt as a turn-start failure without crashing", () =>
  withAntigravityHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* startTurn(harness, {
          commandId: "cmd-antigravity-turn-fail",
          messageId: "msg-antigravity-fail-1",
          text: "Fail please",
        });

        const thread = yield* harness.waitForThread(THREAD_ID, (entry) =>
          entry.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
        );
        assert.notEqual(thread.session?.lastError, null);
        yield* Effect.log("E7 PASS: failed prompt surfaced as provider.turn.start.failed activity");

        const result = yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-antigravity-thread-after-fail"),
          threadId: ThreadId.make("thread-antigravity-after-fail"),
          projectId: PROJECT_ID,
          title: "Alive After Failure",
          modelSelection: ANTIGRAVITY_MODEL_SELECTION,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt: nowIso(),
        });
        assert.isAtLeast(result.sequence, 0);
        yield* Effect.log("E7 PASS: engine still dispatches after the failed turn");
      }),
    { mockAgentEnv: { T3_ACP_FAIL_PROMPT: "1" } },
  ),
);

it.live("reports a missing Antigravity binary as a turn-start failure without crashing", () =>
  withAntigravityHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* startTurn(harness, {
          commandId: "cmd-antigravity-turn-missing-binary",
          messageId: "msg-antigravity-missing-1",
          text: "Start with missing binary",
        });

        yield* harness.waitForThread(THREAD_ID, (entry) =>
          entry.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
        );
        yield* Effect.log(
          "E8 PASS: missing binary surfaced as provider.turn.start.failed activity",
        );

        const result = yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-antigravity-thread-after-missing"),
          threadId: ThreadId.make("thread-antigravity-after-missing"),
          projectId: PROJECT_ID,
          title: "Alive After Missing Binary",
          modelSelection: ANTIGRAVITY_MODEL_SELECTION,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt: nowIso(),
        });
        assert.isAtLeast(result.sequence, 0);
        yield* Effect.log("E8 PASS: engine still dispatches after the spawn failure");
      }),
    { binaryPath: "/nonexistent/antigravity-missing-binary" },
  ),
);

it.live("captures workspace files written by the Antigravity agent in the turn checkpoint", () =>
  withAntigravityHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* startTurn(harness, {
          commandId: "cmd-antigravity-turn-write",
          messageId: "msg-antigravity-write-1",
          text: "Write a file",
        });

        const finalizedReceipt = yield* waitForFinalizedCheckpoint(harness, 1);
        assert.equal(finalizedReceipt.status, "ready");
        yield* waitForQuiesced(harness, 1);

        const thread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.status === "ready" &&
            entry.checkpoints.some((checkpoint) =>
              checkpoint.files.some((file) => file.path === "mock-output.txt"),
            ),
        );
        assert.equal(
          thread.checkpoints[0]?.files.some((file) => file.path === "mock-output.txt"),
          true,
        );

        const checkpointRows = yield* harness.checkpointRepository.listByThreadId({
          threadId: THREAD_ID,
        });
        assert.equal(
          checkpointRows[0]?.files.some((file) => file.path === "mock-output.txt"),
          true,
        );

        const ref1 = checkpointRefForThreadTurn(THREAD_ID, 1);
        assert.equal(
          gitShowFileAtRef(harness.workspaceDir, ref1, "mock-output.txt"),
          "from-mock-agent",
        );
        yield* Effect.log(
          "E9 PASS: agent-written file captured in checkpoint diff, sqlite, and git",
        );
      }),
    {
      mockAgentEnv: {
        T3_ACP_WRITE_FILE_PATH: "mock-output.txt",
        // The wrapper bakes env via sh double quotes, which do not interpret
        // escape sequences — keep the content free of newlines.
        T3_ACP_WRITE_FILE_CONTENT: "from-mock-agent",
      },
    },
  ),
);

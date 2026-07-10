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

const withAntigravityHarness = <A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const binaryPath = yield* Effect.promise(() =>
      makeAcpMockAgentWrapper({ T3_ACP_PROMPT_RESPONSE_TEXT: ASSISTANT_RESPONSE_TEXT }),
    );
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

it.live(
  "runs a single Antigravity turn end-to-end through the real adapter and mock ACP agent",
  () =>
    withAntigravityHarness((harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-antigravity-turn-start"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("msg-antigravity-user-1"),
            role: "user",
            text: "Say hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: nowIso(),
        });

        yield* harness.waitForReceipt(
          (receipt): receipt is TurnProcessingQuiescedReceipt =>
            receipt.type === "turn.processing.quiesced" &&
            receipt.threadId === THREAD_ID &&
            receipt.checkpointTurnCount === 1,
        );
        yield* Effect.log("E1 PASS: turn.processing.quiesced receipt observed");

        const finalizedReceipt = yield* harness.waitForReceipt(
          (receipt): receipt is CheckpointDiffFinalizedReceipt =>
            receipt.type === "checkpoint.diff.finalized" &&
            receipt.threadId === THREAD_ID &&
            receipt.checkpointTurnCount === 1,
        );
        if (finalizedReceipt.type !== "checkpoint.diff.finalized") {
          throw new Error("Expected checkpoint.diff.finalized receipt.");
        }
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

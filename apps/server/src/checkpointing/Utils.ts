import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, type ThreadId } from "@t3tools/contracts";

export const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

// ProviderRuntimeIngestion dispatches placeholder checkpoints (no git ref yet)
// with a synthetic ref under this prefix; CheckpointReactor later replaces
// them with real git-ref-based captures. Real captures use
// CHECKPOINT_REFS_PREFIX refs, so the prefix distinguishes the two.
export const PROVIDER_DIFF_PLACEHOLDER_REF_PREFIX = "provider-diff:";

export function providerDiffPlaceholderRef(eventId: string): CheckpointRef {
  return CheckpointRef.make(`${PROVIDER_DIFF_PLACEHOLDER_REF_PREFIX}${eventId}`);
}

export function isProviderDiffPlaceholderRef(checkpointRef: string): boolean {
  return checkpointRef.startsWith(PROVIDER_DIFF_PLACEHOLDER_REF_PREFIX);
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

/**
 * Writes a temporary shell wrapper that execs the scripted mock ACP agent
 * (`apps/server/scripts/acp-mock-agent.ts`) with the given env vars baked in.
 * Point a provider's `binaryPath` setting at the returned path to drive its
 * ACP runtime against the mock agent.
 */
export async function makeAcpMockAgentWrapper(extraEnv?: Record<string, string>): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "antigravity-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-antigravity.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

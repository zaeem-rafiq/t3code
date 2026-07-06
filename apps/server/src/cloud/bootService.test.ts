// @effect-diagnostics nodeBuiltinImport:off - Tests stage fixture directories on the real filesystem.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ProcessRunner from "../processRunner.ts";
import * as BootService from "./bootService.ts";

const isUnsupportedError = Schema.is(BootService.BootServiceUnsupportedError);
const isCommandError = Schema.is(BootService.BootServiceCommandError);

interface RecordedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const makeRecordingRunnerLayer = (
  commands: Array<RecordedCommand>,
  options?: { readonly failCommand?: string },
) =>
  Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          commands.push({ command: input.command, args: input.args });
          const failed = input.command === options?.failCommand;
          return {
            stdout: "",
            stderr: failed ? `${input.command} exploded` : "",
            code: ChildProcessSpawner.ExitCode(failed ? 1 : 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    }),
  );

const makeHost = (entry: string): BootService.BootServiceHost => ({
  execPath: "/usr/local/bin/node",
  cliEntryPath: entry,
});

const provideHostRefs = (home: string, platform: NodeJS.Platform = "linux") =>
  Effect.provide(
    Layer.mergeAll(
      Layer.succeed(HostProcessPlatform, platform),
      Layer.succeed(HostProcessEnvironment, { HOME: home, USER: "theo" }),
    ),
  );

const makeTestDirs = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-boot-service-test-"));
  return {
    home: root,
    baseDir: NodePath.join(root, ".t3"),
    logsDir: NodePath.join(root, ".t3", "userdata", "logs"),
  };
};

it("renders a systemd unit with absolute paths and append-mode logging", () => {
  const unit = BootService.renderBootServiceUnit({
    nodePath: "/usr/local/bin/node",
    t3EntryPath: "/home/theo/.t3/runtime/versions/0.0.27/node_modules/t3/dist/bin.mjs",
    baseDir: "/home/theo/.t3",
    logPath: "/home/theo/.t3/userdata/logs/boot-service.log",
    unitPath: "/home/theo/.config/systemd/user/t3code.service",
  });

  assert.equal(
    unit,
    [
      "[Unit]",
      "Description=T3 Code server (T3 Connect)",
      "",
      "[Service]",
      "Type=simple",
      "WorkingDirectory=%h",
      "Environment=T3CODE_HOME=/home/theo/.t3",
      "ExecStart=/usr/local/bin/node /home/theo/.t3/runtime/versions/0.0.27/node_modules/t3/dist/bin.mjs serve",
      "Restart=always",
      "RestartSec=5",
      "StandardOutput=append:/home/theo/.t3/userdata/logs/boot-service.log",
      "StandardError=append:/home/theo/.t3/userdata/logs/boot-service.log",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  );
});

it("quotes systemd values containing spaces and escapes percent specifiers", () => {
  assert.equal(BootService.quoteSystemdValue("/plain/path"), "/plain/path");
  assert.equal(BootService.quoteSystemdValue("/home/me/T3 Data"), '"/home/me/T3 Data"');
  assert.equal(BootService.quoteSystemdValue("/opt/100%cpu"), "/opt/100%%cpu");

  const unit = BootService.renderBootServiceUnit({
    nodePath: "/home/me/my tools/node",
    t3EntryPath: "/home/me/T3 Data/bin.mjs",
    baseDir: "/home/me/T3 Data",
    logPath: "/home/me/100%logs/boot.log",
    unitPath: "/home/me/.config/systemd/user/t3code.service",
  });
  assert.include(unit, 'ExecStart="/home/me/my tools/node" "/home/me/T3 Data/bin.mjs" serve');
  assert.include(unit, 'Environment=T3CODE_HOME="/home/me/T3 Data"');
  // append: paths take the rest of the line literally (spaces are fine,
  // quoting is not), but % still goes through specifier expansion.
  assert.include(unit, "StandardOutput=append:/home/me/100%%logs/boot.log");
  assert.include(unit, "StandardError=append:/home/me/100%%logs/boot.log");
});

it("flags package-manager cache entry points as ephemeral", () => {
  assert.isTrue(
    BootService.isEphemeralCacheEntry("/home/theo/.npm/_npx/abc123/node_modules/t3/dist/bin.mjs"),
  );
  assert.isTrue(
    BootService.isEphemeralCacheEntry("C:\\Users\\theo\\AppData\\npm-cache\\_npx\\abc\\bin.mjs"),
  );
  assert.isTrue(
    BootService.isEphemeralCacheEntry(
      "/home/theo/.cache/pnpm/dlx/abc/node_modules/t3/dist/bin.mjs",
    ),
  );
  assert.isTrue(
    BootService.isEphemeralCacheEntry("/home/theo/.bun/install/cache/t3@0.0.27/dist/bin.mjs"),
  );
  assert.isFalse(BootService.isEphemeralCacheEntry("/usr/local/lib/node_modules/t3/dist/bin.mjs"));
  assert.isFalse(
    BootService.isEphemeralCacheEntry(
      "/home/theo/.t3/runtime/versions/0.0.27/node_modules/t3/dist/bin.mjs",
    ),
  );
});

it.layer(NodeServices.layer)("BootService", (it) => {
  it.effect("installs the unit, enables the service, and enables linger", () =>
    Effect.gen(function* () {
      const dirs = makeTestDirs();
      const commands: Array<RecordedCommand> = [];
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost("/usr/local/lib/node_modules/t3/dist/bin.mjs"),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home));

      const plan = yield* service.install;

      // A stable entry point is reused directly — no npm install.
      assert.equal(plan.t3EntryPath, "/usr/local/lib/node_modules/t3/dist/bin.mjs");
      assert.deepEqual(
        commands.map((entry) => [entry.command, ...entry.args].join(" ")),
        [
          "systemctl --user daemon-reload",
          "systemctl --user enable t3code.service",
          // restart (not enable --now) so repairing a stale unit replaces a
          // running process instead of leaving the old one until reboot.
          "systemctl --user restart t3code.service",
          "loginctl enable-linger",
        ],
      );

      const unitPath = NodePath.join(dirs.home, ".config", "systemd", "user", "t3code.service");
      const unit = NodeFS.readFileSync(unitPath, "utf8");
      assert.include(
        unit,
        "ExecStart=/usr/local/bin/node /usr/local/lib/node_modules/t3/dist/bin.mjs serve",
      );
      assert.include(unit, `Environment=T3CODE_HOME=${dirs.baseDir}`);

      const status = yield* service.status;
      assert.isTrue(status.supported);
      assert.isTrue(status.installed);
      assert.isTrue(status.current);

      const removed = yield* service.uninstall;
      assert.isTrue(removed);
      assert.isFalse(NodeFS.existsSync(unitPath));
      const statusAfter = yield* service.status;
      assert.isFalse(statusAfter.installed);
      const removedAgain = yield* service.uninstall;
      assert.isFalse(removedAgain);
    }),
  );

  it.effect("pins a runtime via npm install when running from the npx cache", () =>
    Effect.gen(function* () {
      const dirs = makeTestDirs();
      const commands: Array<RecordedCommand> = [];
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost("/home/theo/.npm/_npx/abc/node_modules/t3/dist/bin.mjs"),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home));

      const plan = yield* service.install;

      const runtimeDir = NodePath.join(dirs.baseDir, "runtime", "versions", "0.0.27");
      assert.equal(
        plan.t3EntryPath,
        NodePath.join(runtimeDir, "node_modules", "t3", "dist", "bin.mjs"),
      );
      assert.deepEqual(commands[0], {
        command: "npm",
        args: ["install", "--prefix", runtimeDir, "--no-fund", "--no-audit", "t3@0.0.27"],
      });
      // Success is recorded via a sentinel so interrupted installs re-run.
      assert.isTrue(NodeFS.existsSync(NodePath.join(runtimeDir, ".install-complete")));
    }),
  );

  it.effect("cleans up and fails when the pinned runtime install fails", () =>
    Effect.gen(function* () {
      const dirs = makeTestDirs();
      const commands: Array<RecordedCommand> = [];
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost("/home/theo/.npm/_npx/abc/node_modules/t3/dist/bin.mjs"),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(commands, { failCommand: "npm" })),
        provideHostRefs(dirs.home),
      );

      const error = yield* service.install.pipe(Effect.flip);
      assert.isTrue(isCommandError(error));
      const runtimeDir = NodePath.join(dirs.baseDir, "runtime", "versions", "0.0.27");
      // The half-installed tree must not be reused by the next attempt.
      assert.isFalse(NodeFS.existsSync(runtimeDir));
      assert.isFalse(NodeFS.existsSync(NodePath.join(runtimeDir, ".install-complete")));
    }),
  );

  it.effect("reports an installed-but-stale unit so connect can offer a repair", () =>
    Effect.gen(function* () {
      const dirs = makeTestDirs();
      const commands: Array<RecordedCommand> = [];
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost("/usr/local/lib/node_modules/t3/dist/bin.mjs"),
      }).pipe(Effect.provide(makeRecordingRunnerLayer(commands)), provideHostRefs(dirs.home));

      const unitDir = NodePath.join(dirs.home, ".config", "systemd", "user");
      NodeFS.mkdirSync(unitDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(unitDir, "t3code.service"),
        "[Service]\nExecStart=/old/node /old/t3 serve\n",
      );

      const status = yield* service.status;
      assert.isTrue(status.supported);
      assert.isTrue(status.installed);
      assert.isFalse(status.current);
    }),
  );

  it.effect("fails on non-Linux platforms without touching the filesystem", () =>
    Effect.gen(function* () {
      const dirs = makeTestDirs();
      const commands: Array<RecordedCommand> = [];
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost("/usr/local/lib/node_modules/t3/dist/bin.mjs"),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(commands)),
        provideHostRefs(dirs.home, "darwin"),
      );

      const error = yield* service.install.pipe(Effect.flip);
      assert.isTrue(isUnsupportedError(error));
      assert.lengthOf(commands, 0);
      assert.isFalse(
        NodeFS.existsSync(NodePath.join(dirs.home, ".config", "systemd", "user", "t3code.service")),
      );

      const status = yield* service.status;
      assert.isFalse(status.supported);
      assert.isFalse(status.installed);
    }),
  );

  it.effect("removes the unit file when an activation step fails", () =>
    Effect.gen(function* () {
      const dirs = makeTestDirs();
      const commands: Array<RecordedCommand> = [];
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost("/usr/local/lib/node_modules/t3/dist/bin.mjs"),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(commands, { failCommand: "loginctl" })),
        provideHostRefs(dirs.home),
      );

      const error = yield* service.install.pipe(Effect.flip);
      assert.isTrue(isCommandError(error));
      // A leftover unit would make the next connect report "already set up"
      // even though linger never happened.
      assert.isFalse(
        NodeFS.existsSync(NodePath.join(dirs.home, ".config", "systemd", "user", "t3code.service")),
      );
      const status = yield* service.status;
      assert.isFalse(status.installed);
    }),
  );

  it.effect("appends failed steps to the boot-service log", () =>
    Effect.gen(function* () {
      const dirs = makeTestDirs();
      const commands: Array<RecordedCommand> = [];
      const service = yield* BootService.make({
        baseDir: dirs.baseDir,
        logsDir: dirs.logsDir,
        cliVersion: "0.0.27",
        host: makeHost("/usr/local/lib/node_modules/t3/dist/bin.mjs"),
      }).pipe(
        Effect.provide(makeRecordingRunnerLayer(commands, { failCommand: "systemctl" })),
        provideHostRefs(dirs.home),
      );

      const error = yield* service.install.pipe(Effect.flip);
      assert.isTrue(isCommandError(error));
      assert.include(error.message, "systemctl exploded");

      const logPath = NodePath.join(dirs.logsDir, "boot-service.log");
      assert.isTrue(NodeFS.existsSync(logPath));
      assert.include(NodeFS.readFileSync(logPath, "utf8"), "systemctl exploded");
    }),
  );
});

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ProcessRunner from "../processRunner.ts";

/**
 * Installs T3 Code as a per-user boot service so a connected machine stays
 * reachable through T3 Connect after the SSH session ends. Linux-only for
 * now: systemd user unit + loginctl enable-linger. The service runs a pinned
 * runtime installed under <baseDir>/runtime — never `npx t3`, whose cache is
 * ephemeral and whose registry fetch at boot would make startup depend on
 * the network.
 */

const BOOT_SERVICE_NAME = "t3code";
const BOOT_RUNTIME_DIR = "runtime";

const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`;
const PINNED_RUNTIME_INSTALL_TIMEOUT = Duration.minutes(10);

const EPHEMERAL_CACHE_SEGMENTS = [
  "/_npx/", // npx
  "\\_npx\\",
  "/pnpm/dlx", // pnpm dlx (~/.cache/pnpm/dlx and $PNPM_HOME/.pnpm/dlx)
  "/.pnpm/dlx",
  "/.bun/install/cache/", // bunx
];

/**
 * `npx t3` (and pnpm dlx / bunx) run out of ephemeral package-manager
 * caches that can be evicted at any time — a boot service must never point
 * there. Global installs, repo checkouts, and the pinned runtime below are
 * all stable.
 */
export function isEphemeralCacheEntry(entryPath: string): boolean {
  return EPHEMERAL_CACHE_SEGMENTS.some((segment) => entryPath.includes(segment));
}

/**
 * systemd expands `%` specifiers in most directive values, including the
 * `append:` file paths, which take the rest of the line literally and must
 * NOT be quoted.
 */
export function escapeSystemdSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}

/**
 * systemd word-splits ExecStart and Environment values and expands `%`
 * specifiers, so paths with spaces or percents must be quoted and escaped.
 */
export function quoteSystemdValue(value: string): string {
  const escaped = escapeSystemdSpecifiers(value);
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

export interface BootServicePlan {
  /** Absolute path of the node binary running this CLI. */
  readonly nodePath: string;
  /** Absolute path of the pinned t3 entry point the unit will run. */
  readonly t3EntryPath: string;
  readonly baseDir: string;
  readonly logPath: string;
  readonly unitPath: string;
}

/**
 * Pure so it is testable byte-for-byte. systemd user units run with a
 * minimal environment: every path must be absolute, and the service must
 * not rely on PATH, nvm shims, or shell profiles. Failures land in
 * `logPath` because `systemctl --user` failures are otherwise invisible.
 */
export function renderBootServiceUnit(plan: BootServicePlan): string {
  // No After=network-online.target: it does not exist in the systemd *user*
  // manager, so ordering on it is silently ignored. The server retries its
  // relay connection, and Restart=always covers early-boot failures.
  return [
    "[Unit]",
    "Description=T3 Code server (T3 Connect)",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=%h",
    `Environment=T3CODE_HOME=${quoteSystemdValue(plan.baseDir)}`,
    `ExecStart=${quoteSystemdValue(plan.nodePath)} ${quoteSystemdValue(plan.t3EntryPath)} serve`,
    "Restart=always",
    "RestartSec=5",
    `StandardOutput=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    `StandardError=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export class BootServiceUnsupportedError extends Schema.TaggedErrorClass<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background setup currently supports Linux with systemd; this machine reports '${this.platform}'.`;
  }
}

export class BootServiceCommandError extends Schema.TaggedErrorClass<BootServiceCommandError>()(
  "BootServiceCommandError",
  {
    step: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Background setup failed while ${this.step}: ${this.detail}`;
  }
}

export class BootServiceInstallError extends Schema.TaggedErrorClass<BootServiceInstallError>()(
  "BootServiceInstallError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not set up the T3 Code background service.";
  }
}

export type BootServiceError =
  | BootServiceUnsupportedError
  | BootServiceCommandError
  | BootServiceInstallError;

export interface BootServiceStatus {
  readonly supported: boolean;
  readonly installed: boolean;
  /** False when the installed unit no longer matches what install would write. */
  readonly current: boolean;
  readonly unitPath: string;
  readonly logPath: string;
}

export class BootService extends Context.Service<
  BootService,
  {
    /** Installs the pinned runtime + unit, enables linger, starts the service. */
    readonly install: Effect.Effect<BootServicePlan, BootServiceError>;
    /**
     * Stops and removes the unit; leaves the pinned runtime for reuse.
     * Returns whether a unit was actually removed.
     */
    readonly uninstall: Effect.Effect<boolean, BootServiceError>;
    readonly status: Effect.Effect<BootServiceStatus, BootServiceError>;
  }
>()("t3/cloud/bootService") {}

export interface BootServiceHost {
  readonly execPath: string;
  readonly cliEntryPath: string;
}

const defaultHost = (): BootServiceHost => ({
  execPath: process.execPath,
  // When running the packed CLI this is dist/bin.mjs; when stable (global
  // install, repo checkout) the boot service runs this same artifact.
  cliEntryPath: process.argv[1] ?? "",
});

export const make = Effect.fnUntraced(function* (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) {
  const host = input.host ?? defaultHost();
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;

  const homeDir = env.HOME ?? "";
  const unitDir = path.join(homeDir, ".config", "systemd", "user");
  const unitPath = path.join(unitDir, BOOT_SERVICE_UNIT_FILE);
  const logPath = path.join(input.logsDir, "boot-service.log");
  const runtimeVersionDir = path.join(
    input.baseDir,
    BOOT_RUNTIME_DIR,
    "versions",
    input.cliVersion,
  );
  const runtimeEntryPath = path.join(runtimeVersionDir, "node_modules", "t3", "dist", "bin.mjs");
  const runtimeSentinelPath = path.join(runtimeVersionDir, ".install-complete");

  const requireSystemdLinux = Effect.gen(function* () {
    if (platform !== "linux" || homeDir === "") {
      return yield* new BootServiceUnsupportedError({ platform });
    }
  });

  const runStep = (
    step: string,
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeout?: Duration.Input },
  ) =>
    runner.run({ command, args, env: { ...env }, timeout: options?.timeout }).pipe(
      Effect.mapError(
        (cause) => new BootServiceCommandError({ step, detail: String(cause.message) }),
      ),
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) =>
          new BootServiceCommandError({
            step,
            detail: result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`,
          }),
      ),
      Effect.tapError((error) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            fs.writeFileString(logPath, `${DateTime.formatIso(now)} ${error.message}\n`, {
              flag: "a",
            }),
          ),
          Effect.ignore,
        ),
      ),
    );

  /**
   * Ensures plannedEntryPath exists before the unit points at it. A stable
   * install (global bin, repo checkout) is used as-is; an ephemeral cache
   * entry is replaced by `npm install --prefix`-ing the exact running
   * version into <baseDir>/runtime/versions/<v>. A real install (not a copy
   * of bin.mjs) because t3 ships native deps like node-pty.
   */
  const ensurePinnedRuntime = Effect.gen(function* () {
    if (!isEphemeralCacheEntry(host.cliEntryPath)) {
      return;
    }
    // The sentinel is written only after npm exits 0. Checking the entry
    // file alone is not enough: npm extracts files before running native
    // builds (node-pty), so a killed install leaves a plausible-looking but
    // broken tree behind.
    const alreadyPinned = yield* fs
      .exists(runtimeSentinelPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    if (alreadyPinned) {
      return;
    }
    yield* fs.remove(runtimeVersionDir, { recursive: true, force: true }).pipe(
      Effect.andThen(fs.makeDirectory(runtimeVersionDir, { recursive: true })),
      Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    );
    yield* runStep(
      "installing the pinned t3 runtime (this can take a few minutes)",
      "npm",
      [
        "install",
        "--prefix",
        runtimeVersionDir,
        "--no-fund",
        "--no-audit",
        `t3@${input.cliVersion}`,
      ],
      // Native deps (node-pty) can compile from source on slow boxes; the
      // ProcessRunner default of 60s would kill a healthy install.
      { timeout: PINNED_RUNTIME_INSTALL_TIMEOUT },
    ).pipe(
      Effect.tapError(() =>
        fs.remove(runtimeVersionDir, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    yield* fs
      .writeFileString(runtimeSentinelPath, `${input.cliVersion}\n`)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
  });

  // Where the unit will point: derivable without touching the network, so
  // status can compare units purely; install materializes it first.
  const plannedEntryPath = isEphemeralCacheEntry(host.cliEntryPath)
    ? runtimeEntryPath
    : host.cliEntryPath;
  const plan: BootServicePlan = {
    nodePath: host.execPath,
    t3EntryPath: plannedEntryPath,
    baseDir: input.baseDir,
    logPath,
    unitPath,
  };

  const install: BootService["Service"]["install"] = Effect.gen(function* () {
    yield* requireSystemdLinux;
    yield* fs
      .makeDirectory(input.logsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    yield* ensurePinnedRuntime;

    yield* fs.makeDirectory(unitDir, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(unitPath, renderBootServiceUnit(plan))),
      Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    );

    // If any activation step fails, remove the unit again: a leftover file
    // would make the next `t3 connect` report the service as already set up
    // even though it was never enabled or lingered.
    yield* Effect.gen(function* () {
      yield* runStep("reloading systemd user units", "systemctl", ["--user", "daemon-reload"]);
      yield* runStep("enabling the service", "systemctl", [
        "--user",
        "enable",
        BOOT_SERVICE_UNIT_FILE,
      ]);
      // restart rather than enable --now: --now does not replace an already
      // running process, so repairing a stale unit would leave the old
      // server running until reboot. restart also starts a stopped service.
      yield* runStep("starting the service", "systemctl", [
        "--user",
        "restart",
        BOOT_SERVICE_UNIT_FILE,
      ]);
      // Linger keeps the user manager (and this service) running without an
      // open session — the whole point on a box reached over SSH. No
      // username argument: loginctl defaults to the calling user, which is
      // always right, while $USER can be stale (su without -l) or unset.
      yield* runStep("enabling lingering for this user", "loginctl", ["enable-linger"]);
    }).pipe(Effect.tapError(() => fs.remove(unitPath).pipe(Effect.ignore)));

    return plan;
  }).pipe(Effect.withSpan("cloud.boot_service.install"));

  const uninstall: BootService["Service"]["uninstall"] = Effect.gen(function* () {
    yield* requireSystemdLinux;
    const exists = yield* fs
      .exists(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    if (!exists) {
      return false;
    }
    yield* runStep("stopping the service", "systemctl", [
      "--user",
      "disable",
      "--now",
      BOOT_SERVICE_UNIT_FILE,
    ]).pipe(Effect.ignore({ log: true }));
    yield* fs
      .remove(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    yield* runStep("reloading systemd user units", "systemctl", ["--user", "daemon-reload"]);
    return true;
  }).pipe(Effect.withSpan("cloud.boot_service.uninstall"));

  const status: BootService["Service"]["status"] = Effect.gen(function* () {
    if (platform !== "linux" || homeDir === "") {
      return { supported: false, installed: false, current: false, unitPath, logPath };
    }
    const unit = yield* fs.readFileString(unitPath).pipe(
      Effect.map((content): string | null => content),
      Effect.orElseSucceed((): string | null => null),
    );
    if (unit === null) {
      return { supported: true, installed: false, current: false, unitPath, logPath };
    }
    // A unit written by an older CLI (different pinned runtime, different
    // node) counts as installed but stale, so connect offers a repair.
    const current = unit === renderBootServiceUnit(plan);
    return { supported: true, installed: true, current, unitPath, logPath };
  }).pipe(Effect.withSpan("cloud.boot_service.status"));

  return BootService.of({ install, uninstall, status });
});

export const layer = (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) => Layer.effect(BootService, make(input)).pipe(Layer.provide(ProcessRunner.layer));

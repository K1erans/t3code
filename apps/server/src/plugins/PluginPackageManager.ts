import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";

import {
  PluginCommandInvocationResult,
  type PluginCommandInvokeInput,
  PluginPackageId,
  PluginPackageNotFoundError,
  PluginPackageOperationError,
  type PluginPackageDiscoveryError,
  type PluginPackageOperation,
  type PluginPackageStatus,
  type PluginPackageStatusSnapshot,
} from "@t3tools/contracts";
import type { PluginActivationContext, PluginDefinition } from "@t3tools/plugin-runtime";
import type { PluginManifest } from "@t3tools/plugin-runtime/manifest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as PluginCommandCatalog from "./PluginCommandCatalog.ts";
import * as PluginStorage from "./PluginStorage.ts";
import {
  isHiddenPluginEntry,
  MANIFEST_FILE_NAME,
  readPluginManifest,
  resolvePackageEntrypoint,
} from "./PluginInstall.ts";

const COMMAND_CAPABILITY = "t3.commands@0";
/** `api.storage` and `api.dataDir`. */
const STORAGE_CAPABILITY = "t3.storage@0";
/** Every host capability this T3 provides. A plugin requiring anything else fails activation. */
const PROVIDED_CAPABILITIES: ReadonlyArray<string> = [COMMAND_CAPABILITY, STORAGE_CAPABILITY];
const MAX_REASON_LENGTH = 2_000;
/** Environment-owned plugin state, shared by every client connected to this environment. */
const PLUGIN_STATE_FILE_NAME = "plugins.json";
const MAX_ICON_BYTES = 32 * 1024;
const ICON_MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
/**
 * Capabilities superseded by a newer major, mapped to the T3 version in which
 * they stop working. Plugins requiring one get an "Older API" warning.
 */
const DEPRECATED_CAPABILITIES: ReadonlyMap<string, string> = new Map();
/** The fingerprint of a package tree that cannot be loaded as it stands (for example a symlink). */
const INVALID_PACKAGE_TREE = "invalid";

interface DiscoveredPackage {
  readonly directory: string;
  readonly manifest: PluginManifest & { readonly entrypoints: { readonly server: string } };
}

interface DiscoveryResult {
  readonly errors: ReadonlyArray<PluginPackageDiscoveryError>;
  readonly packages: ReadonlyMap<PluginPackageId, DiscoveredPackage>;
}

/** One loaded version of a package, live in the runtime. */
interface ActivePlugin {
  readonly definition: PluginDefinition;
  readonly manifest: PluginManifest;
  readonly cacheDirectory: string;
  /** The folder fingerprint this version was loaded from. */
  readonly fingerprint: string;
  /** Settles once the runtime has disposed this version. */
  readonly retired: Promise<void>;
}

interface PackageError {
  readonly reason: string;
  /** The loaded version that failed; absent when the package failed to load at all. */
  readonly source?: PluginDefinition;
}

interface PluginDataAccess {
  readonly dataDir: string;
  readonly storage: PluginStorage.PluginStorage;
}

export interface PluginPackageApi {
  /** `<stateDir>/plugin-data/<pluginId>/`, present when the manifest requires `t3.storage@0`. */
  readonly dataDir?: string;
  readonly storage?: PluginStorage.PluginStorage;
  readonly onDispose: (cleanup: () => void | Promise<void>) => void;
  /** Registers a command declared in `contributes.commands`; the palette shows its manifest `title`. */
  readonly registerCommand: (
    command: {
      readonly id: string;
      readonly description?: string;
      readonly surfaces: ReadonlyArray<"web" | "desktop" | "mobile">;
    },
    handler: () => unknown | Promise<unknown>,
  ) => void;
}

type PluginPackageActivator = (api: PluginPackageApi) => void | Promise<void>;

/** Why a plugin entry point failed. Carries only the readable reason, never the stack. */
export class PluginEntryPointError extends Schema.TaggedError<PluginEntryPointError>()(
  "PluginEntryPointError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

type EntryPointOutcome = "threw" | "rejected" | "timed out";

/** Runs one call into plugin code, turning a throw, rejection or timeout into a reason. */
type EntryPointGuard = <A>(
  entryPoint: string,
  invoke: () => A | PromiseLike<A>,
) => Effect.Effect<A, PluginEntryPointError>;

export interface PluginPackageManagerOptions {
  /** How long an async entry point may run before the plugin is marked failed. */
  readonly entryPointTimeout?: Duration.Input;
}

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

const failureReason = (entryPoint: string, outcome: EntryPointOutcome, error: unknown): string => {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  return `${entryPoint} ${outcome}: ${message.length === 0 ? "unknown error" : message}`
    .slice(0, MAX_REASON_LENGTH)
    .trim();
};

const PluginStateJson = Schema.fromJsonString(
  Schema.Struct({ enabled: Schema.Array(PluginPackageId) }),
);
const decodePluginStateJson = Schema.decodeUnknownEffect(PluginStateJson);
const encodePluginStateJson = Schema.encodeEffect(PluginStateJson);
const decodeInvocationResult = Schema.decodeUnknownEffect(PluginCommandInvocationResult);
const isPluginPackageOperationError = Schema.is(PluginPackageOperationError);
const isPluginEntryPointError = Schema.is(PluginEntryPointError);

const detailFromUnknown = (error: unknown): string => {
  if (isPluginEntryPointError(error)) return error.reason;
  if (isPluginPackageOperationError(error)) return error.detail;
  if (typeof error === "object" && error !== null && "cause" in error) {
    const cause = error.cause;
    if (cause !== undefined && cause !== error) return detailFromUnknown(cause);
  }
  const detail = error instanceof Error ? error.message : String(error);
  const trimmed = detail.trim();
  return (trimmed.length === 0 ? "unknown error" : trimmed).slice(0, MAX_REASON_LENGTH).trim();
};

const detailFromCause = (cause: Cause.Cause<unknown>): string =>
  detailFromUnknown(Cause.squash(cause));

/** The wire error: a readable `detail` only, so no server paths or stacks reach clients. */
const operationError = (
  operation: PluginPackageOperation,
  error: unknown,
  id?: PluginPackageId,
): PluginPackageOperationError =>
  isPluginPackageOperationError(error)
    ? error
    : new PluginPackageOperationError({
        ...(id === undefined ? {} : { id }),
        operation,
        detail: detailFromUnknown(error),
      });

/** Maps an internal failure to the wire error, keeping the full cause in the server log. */
const failOperation =
  (operation: PluginPackageOperation, id?: PluginPackageId) => (error: unknown) =>
    Effect.logWarning("Local plugin package operation failed", { operation, id, error }).pipe(
      Effect.andThen(Effect.fail(operationError(operation, error, id))),
    );

interface DefinitionHooks {
  readonly guard: EntryPointGuard;
  readonly run: <A>(effect: Effect.Effect<A, PluginEntryPointError>) => Promise<A>;
  /** A command or cleanup of `definition` failed; commands also retire it. */
  readonly onFailure: (
    definition: PluginDefinition,
    reason: string,
    entryPoint: "command" | "dispose",
  ) => void;
  readonly onRetired: () => void;
}

const makeDefinition = (
  discovered: DiscoveredPackage,
  activatePackage: PluginPackageActivator,
  data: PluginDataAccess | undefined,
  { guard, run, onFailure, onRetired }: DefinitionHooks,
): PluginDefinition => {
  const declaredTitles = new Map(
    (discovered.manifest.contributes?.commands ?? []).map((command) => [command.id, command.title]),
  );
  const requires = new Set(discovered.manifest.requires);

  const definition: PluginDefinition = {
    id: discovered.manifest.id,
    version: discovered.manifest.version,
    activate(context: PluginActivationContext) {
      context.onDispose(onRetired);
      const api: PluginPackageApi = {
        ...data,
        onDispose(cleanup) {
          context.onDispose(() =>
            run(
              guard("dispose", cleanup).pipe(
                Effect.tapError((error) =>
                  Effect.sync(() => onFailure(definition, error.reason, "dispose")),
                ),
              ),
            ),
          );
        },
        registerCommand(command, handler) {
          if (!requires.has(COMMAND_CAPABILITY)) {
            throw new Error(`Manifest does not require ${COMMAND_CAPABILITY}`);
          }
          const title = declaredTitles.get(command.id);
          if (title === undefined) {
            throw new Error(`Command ${command.id} is not declared in the manifest`);
          }
          PluginCommandCatalog.registerPluginCommand(context, {
            command: {
              id: command.id,
              label: title,
              ...(command.description === undefined ? {} : { description: command.description }),
              surfaces: command.surfaces,
            },
            handler: guard(`command ${command.id}`, handler).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => onFailure(definition, error.reason, "command")),
              ),
              Effect.mapError(
                (cause) =>
                  new PluginCommandCatalog.PluginCommandExecutionError({ cause, id: command.id }),
              ),
              Effect.flatMap((result) =>
                decodeInvocationResult(result).pipe(
                  Effect.mapError(
                    (cause) =>
                      new PluginCommandCatalog.PluginCommandExecutionError({
                        cause,
                        id: command.id,
                      }),
                  ),
                ),
              ),
            ),
          });
        },
      };
      return run(guard("activate", () => activatePackage(api)));
    },
  };
  return definition;
};

export class PluginPackageManager extends Context.Service<
  PluginPackageManager,
  {
    /** Reads current state without waiting for a running enable, reload or rescan. */
    readonly status: Effect.Effect<PluginPackageStatusSnapshot, PluginPackageOperationError>;
    /** Invokes a catalog command, then retires any plugin whose command failed. */
    readonly invokeCommand: PluginCommandCatalog.PluginCommandCatalog["Service"]["invoke"];
    readonly enable: (
      id: PluginPackageId,
    ) => Effect.Effect<
      PluginPackageStatusSnapshot,
      PluginPackageNotFoundError | PluginPackageOperationError
    >;
    readonly disable: (
      id: PluginPackageId,
    ) => Effect.Effect<
      PluginPackageStatusSnapshot,
      PluginPackageNotFoundError | PluginPackageOperationError
    >;
    readonly reload: (
      id: PluginPackageId,
    ) => Effect.Effect<
      PluginPackageStatusSnapshot,
      PluginPackageNotFoundError | PluginPackageOperationError
    >;
    /**
     * Re-discovers `plugins/`: retires active packages whose folder is gone
     * and loads enabled packages whose folder changed since they were last
     * loaded or last failed to load. New packages simply appear disabled.
     */
    readonly rescan: Effect.Effect<PluginPackageStatusSnapshot, PluginPackageOperationError>;
  }
>()("t3/plugins/PluginPackageManager") {}

/** Long enough to fold the burst of events one install or copy produces. */
export const WATCH_DEBOUNCE = Duration.millis(250);
/** A watch that stayed up this long was healthy, so losing it restarts the backoff. */
export const WATCH_HEALTHY_AFTER = Duration.minutes(1);
/** The wait before the nth retry of a watch that keeps failing: doubling from 250ms, capped at 30s. */
const watchRetryDelay = (retry: number) =>
  Duration.min(Duration.times(WATCH_DEBOUNCE, 2 ** Math.min(retry, 16)), Duration.seconds(30));

/**
 * Runs `rescan` once per debounced burst of top-level `plugins/` events.
 * Rescan failures are logged and never stop the watch. When the watch itself
 * ends or fails (for example because `plugins/` was deleted), `prepare`
 * recreates the folder and the watch is re-established, starting with one
 * rescan to catch up on changes made while it was down. The first attempt after
 * a healthy watch is immediate; attempts after one that failed back off.
 */
export const watchPluginsDirectory = <E, R, PrepareError, RescanError>(
  events: Stream.Stream<unknown, E, R>,
  prepare: Effect.Effect<void, PrepareError>,
  rescan: Effect.Effect<unknown, RescanError>,
) =>
  Effect.gen(function* () {
    // Consecutive failed attempts, where a healthy watch counts as the first.
    let failures = 0;
    for (let attempt = 0; ; attempt += 1) {
      const startedAt = yield* Clock.currentTimeMillis;
      yield* (attempt === 0 ? Effect.void : prepare).pipe(
        Effect.andThen(
          (attempt === 0 ? events : Stream.concat(Stream.make(undefined), events)).pipe(
            Stream.debounce(WATCH_DEBOUNCE),
            Stream.runForEach(() => rescan.pipe(Effect.ignoreCause({ log: true }))),
          ),
        ),
        Effect.ignoreCause({ log: true }),
      );
      const upFor = Duration.millis((yield* Clock.currentTimeMillis) - startedAt);
      failures = Duration.isGreaterThanOrEqualTo(upFor, WATCH_HEALTHY_AFTER) ? 1 : failures + 1;
      if (failures > 1) yield* Effect.sleep(watchRetryDelay(failures - 2));
    }
  });

export const make = Effect.fn("PluginPackageManager.make")(function* (
  options: PluginPackageManagerOptions = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
  // Serializes enable, disable, reload, rescan and retirement. Status and commands never take it.
  const semaphore = yield* Semaphore.make(1);
  const pluginsDirectory = path.join(config.stateDir, "plugins");
  const pluginCacheDirectory = path.join(config.stateDir, "plugin-cache");
  // Plugin data outlives disable, reload and restarts; nothing here ever deletes it.
  const pluginDataDirectory = path.join(config.stateDir, "plugin-data");
  // Created before the shutdown finalizer below, so stores close after plugins retire.
  const storageScope = yield* Scope.make();
  yield* Effect.addFinalizer((exit) => Scope.close(storageScope, exit));
  // One store per plugin id, shared across reloads so update serialization spans generations.
  const openStores = new Map<PluginPackageId, PluginDataAccess>();
  const pluginStatePath = path.join(config.stateDir, PLUGIN_STATE_FILE_NAME);
  const active = new Map<PluginPackageId, ActivePlugin>();
  const packageErrors = new Map<PluginPackageId, PackageError>();
  // Live versions with a failed command, retired once the invocation returns.
  const failedCommands = new Set<PluginDefinition>();
  // The folder fingerprint of each package's last failed load or failed-command
  // retirement, so rescans and watch events do not re-import unchanged broken code.
  const failedFingerprints = new Map<PluginPackageId, string>();
  const entryPointTimeout = Duration.fromInputUnsafe(options.entryPointTimeout ?? "30 seconds");
  const runEntryPoint = Effect.runPromiseWith(yield* Effect.context<never>());
  let loadSequence = 0;
  // True until startup activation has run, so enabled packages it has not reached show as starting.
  let starting = true;

  // The one wrapper around every call into plugin code (activate, commands, dispose).
  // The reason goes into the package status; the stack stays in the server log.
  const guardEntryPoint =
    (id: PluginPackageId): EntryPointGuard =>
    (entryPoint, invoke) => {
      const fail = (outcome: EntryPointOutcome, error: unknown) =>
        Effect.gen(function* () {
          const reason = failureReason(entryPoint, outcome, error);
          yield* Effect.logWarning("Local plugin package entry point failed", {
            id,
            reason,
            ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
          });
          return yield* new PluginEntryPointError({ reason });
        });
      return Effect.suspend(() => {
        let result: ReturnType<typeof invoke>;
        try {
          result = invoke();
        } catch (error) {
          return fail("threw", error);
        }
        if (!isPromiseLike(result)) return Effect.succeed(result);
        const pending = result;
        return Effect.promise(() =>
          Promise.resolve(pending).then(
            (value) => ({ settled: "fulfilled" as const, value }),
            (error: unknown) => ({ settled: "rejected" as const, error }),
          ),
        ).pipe(
          Effect.flatMap((outcome) =>
            outcome.settled === "fulfilled"
              ? Effect.succeed(outcome.value)
              : fail("rejected", outcome.error),
          ),
          Effect.timeoutOrElse({
            duration: entryPointTimeout,
            orElse: () =>
              fail("timed out", `did not finish within ${Duration.format(entryPointTimeout)}`),
          }),
        );
      });
    };

  // Commands run outside every lock, so an invocation can outlive the version it
  // started on (a reload or disable finished meanwhile). Its failure belongs to
  // that retired version: only the live version is marked failed or retired.
  const recordEntryPointFailure = (
    definition: PluginDefinition,
    reason: string,
    entryPoint: "command" | "dispose",
  ) => {
    if (active.get(definition.id)?.definition !== definition) return;
    packageErrors.set(definition.id, { reason, source: definition });
    if (entryPoint === "command") failedCommands.add(definition);
  };

  const removeCacheDirectory = (directory: string) =>
    fileSystem
      .remove(directory, { recursive: true, force: true })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to remove local plugin package cache", { directory, error }),
        ),
      );

  const dataAccessFor = Effect.fn("PluginPackageManager.dataAccessFor")(function* (
    id: PluginPackageId,
    operation: PluginPackageOperation,
  ) {
    const existing = openStores.get(id);
    if (existing !== undefined) return existing;
    const dataDir = path.join(pluginDataDirectory, id);
    const storage = yield* PluginStorage.open(dataDir).pipe(
      Scope.provide(storageScope),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catch(failOperation(operation, id)),
    );
    const access = { dataDir, storage } satisfies PluginDataAccess;
    openStores.set(id, access);
    return access;
  });

  // Every file's path, size, mtime and inode: in-place edits change the mtime,
  // and a replaced folder has new inodes even when a copy preserves timestamps.
  // Fails when the tree holds a symbolic link, which trusted packages must not.
  const validatePackageTree = Effect.fn("PluginPackageManager.validatePackageTree")(function* (
    discovered: DiscoveredPackage,
    operation: PluginPackageOperation,
  ) {
    const id = discovered.manifest.id;
    const canonicalPluginsDirectory = yield* fileSystem
      .realPath(pluginsDirectory)
      .pipe(Effect.catch(failOperation(operation, id)));
    const relativeRoot = path.relative(pluginsDirectory, discovered.directory);
    const pending: Array<readonly [lexical: string, expectedCanonical: string]> = [
      [discovered.directory, path.resolve(canonicalPluginsDirectory, relativeRoot)],
    ];
    const stamps: Array<string> = [];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) continue;
      const [lexical, expectedCanonical] = current;
      const canonical = yield* fileSystem
        .realPath(lexical)
        .pipe(Effect.catch(failOperation(operation, id)));
      if (path.normalize(canonical) !== path.normalize(expectedCanonical)) {
        return yield* operationError(
          operation,
          "symbolic links are not supported in trusted local plugin packages",
          id,
        );
      }
      const info = yield* fileSystem.stat(lexical).pipe(Effect.catch(failOperation(operation, id)));
      stamps.push(
        [
          path.relative(discovered.directory, lexical),
          info.type,
          info.size,
          Option.getOrUndefined(info.mtime)?.getTime(),
          Option.getOrUndefined(info.ino),
        ].join(":"),
      );
      if (info.type !== "Directory") continue;
      const entries = yield* fileSystem
        .readDirectory(lexical)
        .pipe(Effect.catch(failOperation(operation, id)));
      for (const entry of entries) {
        pending.push([path.join(lexical, entry), path.join(expectedCanonical, entry)]);
      }
    }
    return NodeCrypto.createHash("sha256").update(stamps.sort().join("\n")).digest("hex");
  });

  const fingerprint = (discovered: DiscoveredPackage) =>
    validatePackageTree(discovered, "rescan").pipe(
      Effect.orElseSucceed(() => INVALID_PACKAGE_TREE),
    );

  const discover = Effect.fn("PluginPackageManager.discover")(function* (
    operation: PluginPackageOperation,
  ) {
    yield* fileSystem
      .makeDirectory(pluginsDirectory, { recursive: true })
      .pipe(Effect.catch(failOperation(operation)));
    const entries = yield* fileSystem
      .readDirectory(pluginsDirectory)
      .pipe(Effect.catch(failOperation(operation)));
    const discovered = new Map<PluginPackageId, DiscoveredPackage>();
    const errors: Array<PluginPackageDiscoveryError> = [];

    for (const entry of [...entries].sort()) {
      if (isHiddenPluginEntry(entry)) continue;
      const directory = path.join(pluginsDirectory, entry);
      const hasManifest = yield* fileSystem
        .exists(path.join(directory, MANIFEST_FILE_NAME))
        .pipe(Effect.catch(failOperation(operation)));
      if (!hasManifest) continue;

      const decoded = yield* Effect.exit(
        readPluginManifest(directory).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      if (decoded._tag === "Failure") {
        const detail = Option.match(Cause.findErrorOption(decoded.cause), {
          onNone: () => detailFromCause(decoded.cause),
          onSome: (error) => error.detail.slice(0, MAX_REASON_LENGTH).trim(),
        });
        errors.push({ directory: entry, error: detail });
        continue;
      }
      const packageManifest = decoded.value;
      if (discovered.has(packageManifest.id)) {
        errors.push({ directory: entry, error: `duplicate package id ${packageManifest.id}` });
        continue;
      }
      discovered.set(packageManifest.id, { directory, manifest: packageManifest });
    }

    return { errors, packages: discovered } satisfies DiscoveryResult;
  });

  const loadDefinition = Effect.fn("PluginPackageManager.loadDefinition")(function* (
    discovered: DiscoveredPackage,
    packageFingerprint: string,
    operation: PluginPackageOperation,
  ) {
    const id = discovered.manifest.id;
    const missing = discovered.manifest.requires.filter(
      (capability) => !PROVIDED_CAPABILITIES.includes(capability),
    );
    if (missing.length > 0) {
      return yield* operationError(
        operation,
        `Needs ${missing.join(", ")}; this T3 provides ${PROVIDED_CAPABILITIES.join(", ")}. Update T3 or use an older version of the plugin.`,
        id,
      );
    }
    const serverEntrypoint = discovered.manifest.entrypoints.server;
    const data = discovered.manifest.requires.includes(STORAGE_CAPABILITY)
      ? yield* dataAccessFor(id, operation)
      : undefined;

    const cacheDirectory = path.join(pluginCacheDirectory, id, String(loadSequence++));
    const entrypointPath = resolvePackageEntrypoint(path, cacheDirectory, serverEntrypoint);
    if (entrypointPath === undefined) {
      return yield* operationError(operation, "entrypoints.server escapes the package", id);
    }
    yield* fileSystem
      .makeDirectory(path.dirname(cacheDirectory), { recursive: true })
      .pipe(Effect.catch(failOperation(operation, id)));
    const copied = yield* Effect.exit(
      fileSystem
        .copy(discovered.directory, cacheDirectory)
        .pipe(Effect.catch(failOperation(operation, id))),
    );
    if (copied._tag === "Failure") {
      yield* removeCacheDirectory(cacheDirectory);
      return yield* Effect.failCause(copied.cause);
    }

    // Each load imports a fresh cache URL so reloads see new code. Node never
    // unloads ES modules, so every load stays in memory until the server
    // restarts; rescans therefore skip unchanged packages, including ones whose
    // last load failed.
    const loaded = yield* Effect.exit(
      Effect.gen(function* () {
        const moduleUrl = NodeURL.pathToFileURL(entrypointPath);
        // A module whose top-level code never settles would otherwise hold the manager
        // lock forever. The import cannot be cancelled: timing out only stops waiting.
        const module = yield* Effect.tryPromise(
          () => import(/* @vite-ignore */ moduleUrl.href) as Promise<Record<string, unknown>>,
        ).pipe(
          Effect.timeoutOrElse({
            duration: entryPointTimeout,
            orElse: () =>
              Effect.fail(
                `import timed out: did not finish within ${Duration.format(entryPointTimeout)}`,
              ),
          }),
          Effect.catch(failOperation(operation, id)),
        );
        if (typeof module.default !== "function") {
          return yield* operationError(
            operation,
            "server entrypoint must export a default activation function",
            id,
          );
        }
        return module.default as PluginPackageActivator;
      }),
    );
    if (loaded._tag === "Failure") {
      yield* removeCacheDirectory(cacheDirectory);
      return yield* Effect.failCause(loaded.cause);
    }

    let markRetired: () => void = () => {};
    const retired = new Promise<void>((resolve) => {
      markRetired = resolve;
    });
    return {
      definition: makeDefinition(discovered, loaded.value, data, {
        guard: guardEntryPoint(id),
        run: runEntryPoint,
        onFailure: recordEntryPointFailure,
        onRetired: markRetired,
      }),
      manifest: discovered.manifest,
      cacheDirectory,
      fingerprint: packageFingerprint,
      retired,
    } satisfies ActivePlugin;
  });

  const readEnabledIds = (operation: PluginPackageOperation, id?: PluginPackageId) =>
    Effect.gen(function* () {
      if (!(yield* fileSystem.exists(pluginStatePath))) return new Set<PluginPackageId>();
      const state = yield* fileSystem
        .readFileString(pluginStatePath)
        .pipe(Effect.flatMap(decodePluginStateJson));
      return new Set<PluginPackageId>(state.enabled);
    }).pipe(Effect.catch(failOperation(operation, id)));

  const persistEnabledIds = (
    ids: ReadonlySet<PluginPackageId>,
    operation: PluginPackageOperation,
    id: PluginPackageId,
  ) =>
    encodePluginStateJson({ enabled: [...ids].sort() }).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: pluginStatePath, contents: `${contents}\n` }),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catch(failOperation(operation, id)),
    );

  /** Puts the enabled set back after a change the runtime rolled back. */
  const restoreEnabledIds = (
    ids: ReadonlySet<PluginPackageId>,
    operation: PluginPackageOperation,
    id: PluginPackageId,
  ) =>
    persistEnabledIds(ids, operation, id).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Failed to restore enabled plugin state", { id, error }),
      ),
    );

  /**
   * Reconciles the runtime with `id` replaced by `next`, or removed when `next`
   * is undefined, and records the result. A failed reconcile normally keeps the
   * previous composition live (`committed: false`, and `next`'s cache is
   * removed); only a changed catalog generation means it committed anyway.
   * Call inside `Effect.uninterruptibleMask`, passing its `restore`, so the
   * bookkeeping always matches what the runtime did.
   */
  const commit = Effect.fnUntraced(function* (
    operation: PluginPackageOperation,
    id: PluginPackageId,
    next: ActivePlugin | undefined,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ) {
    const definitions = [...active.values()]
      .map((plugin) => plugin.definition)
      .filter((definition) => definition.id !== id);
    if (next !== undefined) definitions.push(next.definition);
    definitions.sort((left, right) => left.id.localeCompare(right.id));

    const before = (yield* catalog.list).generation;
    const exit = yield* Effect.exit(
      restore(catalog.reconcile(definitions).pipe(Effect.catch(failOperation(operation, id)))),
    );
    const committed = Exit.isSuccess(exit) || (yield* catalog.list).generation !== before;
    if (!committed) {
      if (next !== undefined) yield* removeCacheDirectory(next.cacheDirectory);
      return { committed, exit };
    }

    const previous = active.get(id);
    if (previous !== undefined) failedCommands.delete(previous.definition);
    if (next === undefined) {
      active.delete(id);
    } else {
      active.set(id, next);
      failedFingerprints.delete(id);
      // An error from the replaced version (say, its cleanup failing just now) is not this one's.
      const error = packageErrors.get(id);
      if (error?.source !== undefined && error.source !== next.definition) packageErrors.delete(id);
    }
    if (previous !== undefined) {
      // In-flight commands of the retired version may still run from this copy; they
      // already imported their code, and their outcome no longer affects the package.
      yield* Effect.promise(() => previous.retired);
      yield* removeCacheDirectory(previous.cacheDirectory);
    }
    return { committed, exit };
  });

  const iconCache = new Map<string, { readonly stamp: string; readonly url: string }>();

  /**
   * Inlines a small package icon so every client, local or remote, can render it.
   * Encoded icons are cached by path, size and mtime so status refreshes skip the read.
   */
  const readIconUrl = (directory: string, icon: string | undefined) =>
    Effect.gen(function* () {
      if (icon === undefined) return undefined;
      const mimeType = ICON_MIME_TYPES[path.extname(icon).toLowerCase()];
      if (mimeType === undefined) return undefined;
      const iconPath = path.resolve(directory, icon);
      const canonicalDirectory = yield* fileSystem.realPath(directory);
      const canonicalIcon = yield* fileSystem.realPath(iconPath);
      if (!canonicalIcon.startsWith(`${canonicalDirectory}${path.sep}`)) return undefined;
      const info = yield* fileSystem.stat(canonicalIcon);
      if (info.type !== "File" || Number(info.size) > MAX_ICON_BYTES) return undefined;
      const stamp = `${info.size}:${Option.match(info.mtime, { onNone: () => "", onSome: (mtime) => mtime.getTime() })}`;
      const cached = iconCache.get(canonicalIcon);
      if (cached?.stamp === stamp) return cached.url;
      const bytes = yield* fileSystem.readFile(canonicalIcon);
      const url = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
      iconCache.set(canonicalIcon, { stamp, url });
      return url;
    }).pipe(Effect.orElseSucceed(() => undefined));

  const status = Effect.fn("PluginPackageManager.status")(function* (
    operation: PluginPackageOperation,
  ): Effect.fn.Return<PluginPackageStatusSnapshot, PluginPackageOperationError> {
    const [discovery, enabledIds] = yield* Effect.all(
      [discover(operation), readEnabledIds(operation)],
      { concurrency: "unbounded" },
    );
    const discovered = discovery.packages;
    const errors = [...discovery.errors];
    const packages: Array<PluginPackageStatus> = [];
    const packageIds = new Set([...discovered.keys(), ...active.keys()]);

    for (const id of [...packageIds].sort()) {
      const current = active.get(id);
      const packageManifest = current?.manifest ?? discovered.get(id)?.manifest;
      if (packageManifest === undefined) continue;
      const directory = discovered.get(id)?.directory ?? path.join(pluginsDirectory, id);
      const iconUrl = yield* readIconUrl(directory, packageManifest.icon);
      const olderApiRemovedIn = packageManifest.requires
        .map((capability) => DEPRECATED_CAPABILITIES.get(capability))
        .find((version) => version !== undefined);
      const enabled = enabledIds.has(id);
      const error = packageErrors.get(id)?.reason;
      packages.push({
        id: packageManifest.id,
        name: packageManifest.name.trim() || packageManifest.id,
        ...(packageManifest.description?.trim()
          ? { description: packageManifest.description.trim() }
          : {}),
        ...(iconUrl === undefined ? {} : { iconUrl }),
        version: packageManifest.version,
        enabled,
        state:
          error !== undefined
            ? "error"
            : current !== undefined
              ? "active"
              : enabled
                ? starting
                  ? "activating"
                  : "idle"
                : "disabled",
        requires: [...packageManifest.requires],
        contributions: {
          commands: (packageManifest.contributes?.commands ?? []).map((command) => command.id),
        },
        ...(olderApiRemovedIn === undefined ? {} : { olderApiRemovedIn }),
        ...(error === undefined ? {} : { error }),
      });
    }

    // Only enabled packages report "Not installed": they are the ones a client
    // expects to be running. A removed disabled package has no state worth
    // keeping, so it simply leaves the list (its data stays in plugin-data).
    for (const id of [...enabledIds].sort()) {
      if (!discovered.has(id)) {
        errors.push({ directory: id, error: "Not installed" });
      }
    }

    return { errors, packages };
  });

  const transition = Effect.fn("PluginPackageManager.transition")(
    (operation: "enable" | "reload", id: PluginPackageId) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const discovery = yield* restore(discover(operation));
          const pluginPackage = discovery.packages.get(id);
          if (pluginPackage === undefined) return yield* new PluginPackageNotFoundError({ id });
          const enabledIds = yield* restore(readEnabledIds(operation, id));
          if (operation === "reload" && !enabledIds.has(id)) {
            return yield* operationError(operation, "package is not enabled", id);
          }
          if (operation === "enable" && active.has(id) && enabledIds.has(id)) {
            return yield* status(operation);
          }
          packageErrors.delete(id);

          let attempted = INVALID_PACKAGE_TREE;
          const failLoad = (cause: Cause.Cause<PluginPackageOperationError>) => {
            // An interrupted action (say, its client disconnected) says nothing about the package.
            if (!Cause.hasInterruptsOnly(cause)) {
              packageErrors.set(id, { reason: detailFromCause(cause) });
              failedFingerprints.set(id, attempted);
            }
            return Effect.failCause(cause);
          };
          const tree = yield* Effect.exit(restore(validatePackageTree(pluginPackage, operation)));
          if (tree._tag === "Failure") return yield* failLoad(tree.cause);
          attempted = tree.value;
          const loaded = yield* Effect.exit(
            restore(loadDefinition(pluginPackage, attempted, operation)),
          );
          if (loaded._tag === "Failure") return yield* failLoad(loaded.cause);

          if (operation === "enable") {
            const persisted = yield* Effect.exit(
              persistEnabledIds(new Set([...enabledIds, id]), operation, id),
            );
            if (persisted._tag === "Failure") {
              packageErrors.set(id, { reason: detailFromCause(persisted.cause) });
              yield* removeCacheDirectory(loaded.value.cacheDirectory);
              return yield* Effect.failCause(persisted.cause);
            }
          }
          const { committed, exit } = yield* commit(operation, id, loaded.value, restore);
          if (Exit.isSuccess(exit)) return yield* status(operation);
          if (!committed) {
            if (operation === "enable") yield* restoreEnabledIds(enabledIds, operation, id);
            return yield* failLoad(exit.cause);
          }
          return yield* Effect.failCause(exit.cause);
        }),
      ),
  );

  const disable = Effect.fn("PluginPackageManager.disable")((id: PluginPackageId) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const discovery = yield* restore(discover("disable"));
        const enabledIds = yield* restore(readEnabledIds("disable", id));
        if (!discovery.packages.has(id) && !enabledIds.has(id) && !active.has(id)) {
          return yield* new PluginPackageNotFoundError({ id });
        }
        packageErrors.delete(id);
        failedFingerprints.delete(id);

        const remaining = new Set(enabledIds);
        remaining.delete(id);
        yield* persistEnabledIds(remaining, "disable", id);
        if (active.has(id)) {
          const { committed, exit } = yield* commit("disable", id, undefined, restore);
          if (!committed) yield* restoreEnabledIds(enabledIds, "disable", id);
          if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
        }
        return yield* status("disable");
      }),
    ),
  );

  // A failed command leaves its package enabled but inactive, showing the reason until Reload.
  const retireFailedCommand = (definition: PluginDefinition) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (!failedCommands.delete(definition)) return;
        const failed = active.get(definition.id);
        if (failed?.definition !== definition) return;
        const { committed, exit } = yield* commit("disable", definition.id, undefined, restore);
        // Rescans leave the unchanged folder alone; Reload or an edit brings it back.
        if (committed) failedFingerprints.set(definition.id, failed.fingerprint);
        else if (Exit.isFailure(exit)) {
          yield* Effect.logWarning("Failed to retire failed local plugin package", {
            id: definition.id,
            error: detailFromCause(exit.cause),
          });
        }
      }),
    );

  /** The live version declaring `commandId`, if one of its commands failed and awaits retirement. */
  const failedOwnerOf = (commandId: string) =>
    [...failedCommands].find((definition) => {
      const owner = active.get(definition.id);
      return (
        owner?.definition === definition &&
        (owner.manifest.contributes?.commands ?? []).some((command) => command.id === commandId)
      );
    });

  const rescanUnlocked = Effect.fn("PluginPackageManager.rescan")(function* () {
    const discovery = yield* discover("rescan");
    const enabledIds = yield* readEnabledIds("rescan");

    for (const id of [...active.keys()].sort()) {
      if (discovery.packages.has(id)) continue;
      const { committed, exit } = yield* Effect.uninterruptibleMask((restore) =>
        commit("rescan", id, undefined, restore),
      );
      if (!committed && Exit.isFailure(exit)) {
        packageErrors.set(id, { reason: detailFromCause(exit.cause) });
      }
    }

    for (const id of [...enabledIds].sort()) {
      const pluginPackage = discovery.packages.get(id);
      if (pluginPackage === undefined) {
        // Gone: the status reports it as not installed until it returns.
        failedFingerprints.delete(id);
        if (!active.has(id)) packageErrors.delete(id);
        continue;
      }
      const current = yield* fingerprint(pluginPackage);
      if (current === active.get(id)?.fingerprint) {
        // The folder is back to the live version, so a failed load of another version
        // no longer applies. Errors of the live version itself stay.
        if (packageErrors.get(id)?.source === undefined) packageErrors.delete(id);
        failedFingerprints.delete(id);
        continue;
      }
      if (current === failedFingerprints.get(id)) continue;
      // A failed load is recorded against the package and shown in status.
      const reloaded = yield* Effect.exit(transition("reload", id));
      if (reloaded._tag === "Failure") {
        yield* Effect.logWarning("Failed to load enabled local plugin package", {
          id,
          detail: detailFromCause(reloaded.cause),
        });
      }
    }
    return yield* status("rescan");
  });

  yield* fileSystem
    .remove(pluginCacheDirectory, { recursive: true, force: true })
    .pipe(Effect.catch(failOperation("status")));
  yield* fileSystem
    .makeDirectory(pluginCacheDirectory, { recursive: true })
    .pipe(Effect.catch(failOperation("status")));

  const startupDiscovery = yield* discover("status");
  for (const error of startupDiscovery.errors) {
    yield* Effect.logWarning("Invalid local plugin package", error);
  }
  // Unreadable plugin state fails here, leaving the environment up without plugins.
  yield* readEnabledIds("status");

  yield* Effect.addFinalizer(() =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const shutdown = yield* Effect.exit(catalog.reconcile([]));
        if (shutdown._tag === "Failure") {
          yield* Effect.logWarning("Failed to retire local plugin packages during shutdown", {
            error: detailFromCause(shutdown.cause),
          });
        }
        for (const [id, error] of packageErrors) {
          yield* Effect.logWarning("Local plugin package reported a shutdown error", {
            id,
            error: error.reason,
          });
        }
        yield* removeCacheDirectory(pluginCacheDirectory);
      }),
    ),
  );

  const rescan = semaphore.withPermits(1)(rescanUnlocked());
  // Forked after the shutdown finalizer so they are interrupted first and cannot
  // load anything once shutdown has retired the packages. Plugins never delay
  // server startup: enabled packages activate in the background, showing as
  // starting until they do, through the same rescan that picks up later changes.
  // Startup holds the lock before the service is returned, so every lifecycle
  // action queues behind it.
  const startupLocked = yield* Deferred.make<void>();
  yield* semaphore
    .withPermits(1)(
      Deferred.succeed(startupLocked, undefined).pipe(Effect.andThen(rescanUnlocked())),
    )
    .pipe(
      Effect.ensuring(
        Effect.sync(() => {
          starting = false;
        }),
      ),
      Effect.ignoreCause({ log: true }),
      Effect.forkScoped,
    );
  yield* Deferred.await(startupLocked);
  yield* watchPluginsDirectory(
    watchEvents(fileSystem, pluginsDirectory),
    fileSystem.makeDirectory(pluginsDirectory, { recursive: true }),
    rescan,
  ).pipe(Effect.forkScoped);

  return {
    status: status("status"),
    // Only an invocation of the failed plugin retires it, so a pending retirement
    // never delays other plugins' responses. The failed call returns once its
    // plugin is retired, so the caller's next catalog read no longer lists it.
    invokeCommand: (input: PluginCommandInvokeInput) =>
      catalog.invoke(input).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            const failed = failedOwnerOf(input.id);
            return failed === undefined
              ? Effect.void
              : semaphore.withPermits(1)(retireFailedCommand(failed));
          }),
        ),
      ),
    enable: (id: PluginPackageId) => semaphore.withPermits(1)(transition("enable", id)),
    disable: (id: PluginPackageId) => semaphore.withPermits(1)(disable(id)),
    reload: (id: PluginPackageId) => semaphore.withPermits(1)(transition("reload", id)),
    rescan,
  } as const;
});

/**
 * Top-level events in `plugins/`. Deleting the folder can leave the watch
 * attached to the removed folder without an error, so the stream ends as soon
 * as `plugins/` is no longer the folder it started on.
 */
const watchEvents = (fileSystem: FileSystem.FileSystem, directory: string) =>
  Stream.unwrap(
    fileSystem.stat(directory).pipe(
      Effect.map((watched) => {
        const replaced = fileSystem.stat(directory).pipe(
          Effect.map(
            (info) => Option.getOrUndefined(info.ino) !== Option.getOrUndefined(watched.ino),
          ),
          Effect.orElseSucceed(() => true),
        );
        return fileSystem.watch(directory).pipe(Stream.takeUntilEffect(() => replaced));
      }),
    ),
  );

const unavailableService = (
  error: PluginPackageOperationError,
  catalog: PluginCommandCatalog.PluginCommandCatalog["Service"],
) =>
  PluginPackageManager.of({
    status: Effect.fail(error),
    invokeCommand: catalog.invoke,
    enable: () => Effect.fail(error),
    disable: () => Effect.fail(error),
    reload: () => Effect.fail(error),
    rescan: Effect.fail(error),
  });

export const layerWith = (options: PluginPackageManagerOptions = {}) =>
  Layer.effect(
    PluginPackageManager,
    make(options).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Local plugin package manager failed to start", {
            error: detailFromUnknown(error),
          });
          return unavailableService(error, yield* PluginCommandCatalog.PluginCommandCatalog);
        }),
      ),
    ),
  );

export const layer = layerWith();

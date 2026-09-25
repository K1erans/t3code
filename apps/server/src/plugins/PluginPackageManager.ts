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
import {
  PluginManifest,
  type PluginManifest as PluginManifestType,
} from "@t3tools/plugin-runtime/manifest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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
import { isHiddenPluginEntry, MANIFEST_FILE_NAME } from "./PluginInstall.ts";

const COMMAND_CAPABILITY = "t3.commands@1";
const MAX_REASON_LENGTH = 2_000;
const STORAGE_CAPABILITY = "t3.storage@0";
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

interface DiscoveredPackage {
  readonly directory: string;
  readonly manifest: PluginManifestType;
}

interface DiscoveryResult {
  readonly errors: ReadonlyArray<PluginPackageDiscoveryError>;
  readonly packages: ReadonlyMap<string, DiscoveredPackage>;
}

interface LoadedDefinition {
  readonly cacheDirectory: string;
  readonly definition: PluginDefinition;
  readonly fingerprint: string;
  readonly retired: Promise<void>;
}

interface PluginDataAccess {
  readonly dataDir: string;
  readonly storage: PluginStorage.PluginStorage;
}

export interface PluginPackageApi {
  /** `<stateDir>/plugin-data/<pluginId>/`, present when the manifest declares `t3.storage@0`. */
  readonly dataDir?: string;
  readonly storage?: PluginStorage.PluginStorage;
  readonly onDispose: (cleanup: () => void | Promise<void>) => void;
  readonly registerCommand: (
    command: {
      readonly id: string;
      readonly label: string;
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

const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));
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
  if (isPluginPackageOperationError(error)) {
    if (error.detail !== undefined) return error.detail;
    if (error.cause !== undefined) return detailFromUnknown(error.cause);
  }
  if (typeof error === "object" && error !== null && "cause" in error) {
    const cause = error.cause;
    if (cause !== undefined && cause !== error) return detailFromUnknown(cause);
  }
  const detail = error instanceof Error ? error.message : String(error);
  const trimmed = detail.trim();
  return (trimmed.length === 0 ? "unknown error" : trimmed).slice(0, 2_000);
};

const detailFromCause = (cause: Cause.Cause<unknown>): string =>
  detailFromUnknown(Cause.squash(cause));

const operationError = (
  operation: PluginPackageOperation,
  error: unknown,
  id?: string,
): PluginPackageOperationError => {
  if (isPluginPackageOperationError(error)) return error;
  return new PluginPackageOperationError({
    ...(id === undefined ? {} : { id }),
    operation,
    ...(typeof error === "string" ? { detail: error } : { cause: error }),
  });
};

interface DefinitionHooks {
  readonly guard: EntryPointGuard;
  readonly run: <A>(effect: Effect.Effect<A, PluginEntryPointError>) => Promise<A>;
  readonly onCommandFailed: () => void;
  readonly onRetired: () => void;
}

const makeDefinition = (
  discovered: DiscoveredPackage,
  activatePackage: PluginPackageActivator,
  data: PluginDataAccess | undefined,
  { guard, run, onCommandFailed, onRetired }: DefinitionHooks,
): PluginDefinition => {
  const declaredCommands = new Set(discovered.manifest.contributes?.commands ?? []);

  return {
    id: discovered.manifest.id,
    version: discovered.manifest.version,
    activate(context: PluginActivationContext) {
      context.onDispose(onRetired);
      const api: PluginPackageApi = {
        ...data,
        onDispose(cleanup) {
          context.onDispose(() => run(guard("dispose", cleanup)));
        },
        registerCommand(command, handler) {
          if (!discovered.manifest.capabilities.includes(COMMAND_CAPABILITY)) {
            throw new Error(`Manifest does not declare capability ${COMMAND_CAPABILITY}`);
          }
          if (!declaredCommands.has(command.id)) {
            throw new Error(`Command ${command.id} is not declared in the manifest`);
          }
          PluginCommandCatalog.registerPluginCommand(context, {
            command,
            handler: guard(`command ${command.id}`, handler).pipe(
              Effect.tapError(() => Effect.sync(onCommandFailed)),
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
};

export class PluginPackageManager extends Context.Service<
  PluginPackageManager,
  {
    readonly status: Effect.Effect<PluginPackageStatusSnapshot, PluginPackageOperationError>;
    /** Invokes a catalog command, then retires any plugin whose command failed. */
    readonly invokeCommand: PluginCommandCatalog.PluginCommandCatalog["Service"]["invoke"];
    readonly enable: (
      id: string,
    ) => Effect.Effect<
      PluginPackageStatusSnapshot,
      PluginPackageNotFoundError | PluginPackageOperationError
    >;
    readonly disable: (
      id: string,
    ) => Effect.Effect<
      PluginPackageStatusSnapshot,
      PluginPackageNotFoundError | PluginPackageOperationError
    >;
    readonly reload: (
      id: string,
    ) => Effect.Effect<
      PluginPackageStatusSnapshot,
      PluginPackageNotFoundError | PluginPackageOperationError
    >;
    /**
     * Re-discovers `plugins/`: retires active packages whose folder is gone
     * and reloads enabled packages whose folder changed since they were last
     * loaded. New packages simply appear disabled.
     */
    readonly rescan: Effect.Effect<PluginPackageStatusSnapshot, PluginPackageOperationError>;
  }
>()("t3/plugins/PluginPackageManager") {}

/** Long enough to fold the burst of events one install or copy produces. */
export const WATCH_DEBOUNCE = Duration.millis(250);

/**
 * Runs `rescan` once per debounced burst of top-level `plugins/` events.
 * Failures are logged and never stop the watch.
 */
export const watchPluginsDirectory = <E, R, RescanError>(
  events: Stream.Stream<unknown, E, R>,
  rescan: Effect.Effect<unknown, RescanError>,
) =>
  events.pipe(
    Stream.debounce(WATCH_DEBOUNCE),
    Stream.runForEach(() => rescan.pipe(Effect.ignoreCause({ log: true }))),
    Effect.ignoreCause({ log: true }),
  );

export const make = Effect.fn("PluginPackageManager.make")(function* (
  options: PluginPackageManagerOptions = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
  const semaphore = yield* Semaphore.make(1);
  const pluginsDirectory = path.join(config.stateDir, "plugins");
  const pluginCacheDirectory = path.join(config.stateDir, "plugin-cache");
  // Plugin data outlives disable, reload and restarts; nothing here ever deletes it.
  const pluginDataDirectory = path.join(config.stateDir, "plugin-data");
  // Created before the shutdown finalizer below, so stores close after plugins retire.
  const storageScope = yield* Scope.make();
  yield* Effect.addFinalizer((exit) => Scope.close(storageScope, exit));
  // One store per plugin id, shared across reloads so update serialization spans generations.
  const openStores = new Map<string, PluginDataAccess>();
  const pluginStatePath = path.join(config.stateDir, PLUGIN_STATE_FILE_NAME);
  const activeDefinitions = new Map<string, PluginDefinition>();
  const activeCacheDirectories = new Map<string, string>();
  const activeManifests = new Map<string, PluginManifestType>();
  const activeRetirements = new Map<string, Promise<void>>();
  const packageErrors = new Map<string, string>();
  const failedCommandPlugins = new Set<string>();
  const entryPointTimeout = Duration.fromInputUnsafe(options.entryPointTimeout ?? "30 seconds");
  const runEntryPoint = Effect.runPromiseWith(yield* Effect.context<never>());
  // The folder fingerprint each active package was loaded from, so a rescan
  // reloads only what changed and retries packages that failed to load.
  const loadedFingerprints = new Map<string, string>();
  let loadSequence = 0;

  // The one wrapper around every call into plugin code (activate, commands, dispose).
  // The reason goes into the package status; the stack stays in the server log.
  const guardEntryPoint =
    (id: string): EntryPointGuard =>
    (entryPoint, invoke) => {
      const fail = (outcome: EntryPointOutcome, error: unknown) =>
        Effect.gen(function* () {
          const reason = failureReason(entryPoint, outcome, error);
          packageErrors.set(id, reason);
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

  // Every file's path, size, mtime and inode: in-place edits change the mtime,
  // and a replaced folder has new inodes even when a copy preserves timestamps.
  const fingerprint = (discovered: DiscoveredPackage) =>
    validatePackageTree(discovered, "rescan").pipe(Effect.orElseSucceed(() => "unknown"));

  const removeCacheDirectory = (directory: string) =>
    fileSystem
      .remove(directory, { recursive: true, force: true })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to remove local plugin package cache", { directory, error }),
        ),
      );

  const dataAccessFor = Effect.fn("PluginPackageManager.dataAccessFor")(function* (
    id: string,
    operation: PluginPackageOperation,
  ) {
    const existing = openStores.get(id);
    if (existing !== undefined) return existing;
    const dataDir = path.join(pluginDataDirectory, id);
    const storage = yield* PluginStorage.open(dataDir).pipe(
      Scope.provide(storageScope),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((error) => operationError(operation, error, id)),
    );
    const access = { dataDir, storage } satisfies PluginDataAccess;
    openStores.set(id, access);
    return access;
  });

  const validatePackageTree = Effect.fn("PluginPackageManager.validatePackageTree")(function* (
    discovered: DiscoveredPackage,
    operation: PluginPackageOperation,
  ) {
    const canonicalPluginsDirectory = yield* fileSystem
      .realPath(pluginsDirectory)
      .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id)));
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
        .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id)));
      if (path.normalize(canonical) !== path.normalize(expectedCanonical)) {
        return yield* operationError(
          operation,
          "symbolic links are not supported in trusted local plugin packages",
          discovered.manifest.id,
        );
      }
      const info = yield* fileSystem
        .stat(lexical)
        .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id)));
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
        .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id)));
      for (const entry of entries) {
        pending.push([path.join(lexical, entry), path.join(expectedCanonical, entry)]);
      }
    }
    return NodeCrypto.createHash("sha256").update(stamps.sort().join("\n")).digest("hex");
  });

  const discover = Effect.fn("PluginPackageManager.discover")(function* (
    operation: PluginPackageOperation,
  ) {
    yield* fileSystem
      .makeDirectory(pluginsDirectory, { recursive: true })
      .pipe(Effect.mapError((error) => operationError(operation, error)));
    const entries = yield* fileSystem
      .readDirectory(pluginsDirectory)
      .pipe(Effect.mapError((error) => operationError(operation, error)));
    const discovered = new Map<string, DiscoveredPackage>();
    const errors: Array<PluginPackageDiscoveryError> = [];

    for (const entry of [...entries].sort()) {
      if (isHiddenPluginEntry(entry)) continue;
      const directory = path.join(pluginsDirectory, entry);
      const manifestPath = path.join(directory, MANIFEST_FILE_NAME);
      if (
        !(yield* fileSystem
          .exists(manifestPath)
          .pipe(Effect.mapError((error) => operationError(operation, error))))
      )
        continue;

      const decoded = yield* Effect.exit(
        fileSystem.readFileString(manifestPath).pipe(Effect.flatMap(decodeManifestJson)),
      );
      if (decoded._tag === "Failure") {
        errors.push({ directory: entry, error: detailFromCause(decoded.cause) });
        continue;
      }
      const packageManifest = decoded.value;
      if (packageManifest.entrypoints.server === undefined) {
        errors.push({ directory: entry, error: "manifest must define entrypoints.server" });
        continue;
      }
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
    operation: PluginPackageOperation,
  ) {
    const serverEntrypoint = discovered.manifest.entrypoints.server;
    if (serverEntrypoint === undefined) {
      return yield* operationError(
        operation,
        "manifest must define entrypoints.server",
        discovered.manifest.id,
      );
    }
    const packageFingerprint = yield* validatePackageTree(discovered, operation);
    const data = discovered.manifest.capabilities.includes(STORAGE_CAPABILITY)
      ? yield* dataAccessFor(discovered.manifest.id, operation)
      : undefined;
    const sourceEntrypointPath = path.resolve(discovered.directory, serverEntrypoint);
    const relativeEntrypoint = path.relative(discovered.directory, sourceEntrypointPath);
    if (
      relativeEntrypoint === ".." ||
      relativeEntrypoint.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeEntrypoint)
    ) {
      return yield* operationError(
        operation,
        "entrypoint escapes the package directory",
        discovered.manifest.id,
      );
    }

    const cacheDirectory = path.join(
      pluginCacheDirectory,
      discovered.manifest.id,
      String(loadSequence++),
    );
    yield* fileSystem
      .makeDirectory(path.dirname(cacheDirectory), { recursive: true })
      .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id)));
    const copied = yield* Effect.exit(
      fileSystem
        .copy(discovered.directory, cacheDirectory)
        .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id))),
    );
    if (copied._tag === "Failure") {
      yield* removeCacheDirectory(cacheDirectory);
      return yield* Effect.failCause(copied.cause);
    }
    const entrypointPath = path.resolve(cacheDirectory, serverEntrypoint);

    const loaded = yield* Effect.exit(
      Effect.gen(function* () {
        const moduleUrl = NodeURL.pathToFileURL(entrypointPath);
        const module = yield* Effect.tryPromise({
          try: () => import(/* @vite-ignore */ moduleUrl.href) as Promise<Record<string, unknown>>,
          catch: (cause) => operationError(operation, cause, discovered.manifest.id),
        });
        if (typeof module.default !== "function") {
          return yield* operationError(
            operation,
            "server entrypoint must export a default activation function",
            discovered.manifest.id,
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
      cacheDirectory,
      definition: makeDefinition(discovered, loaded.value, data, {
        guard: guardEntryPoint(discovered.manifest.id),
        run: runEntryPoint,
        onCommandFailed: () => failedCommandPlugins.add(discovered.manifest.id),
        onRetired: markRetired,
      }),
      fingerprint: packageFingerprint,
      retired,
    } satisfies LoadedDefinition;
  });

  const definitionList = (replacement?: readonly [string, PluginDefinition | undefined]) => {
    const definitions = new Map(activeDefinitions);
    if (replacement !== undefined) {
      const [id, definition] = replacement;
      if (definition === undefined) definitions.delete(id);
      else definitions.set(id, definition);
    }
    return [...definitions.values()].sort((left, right) => left.id.localeCompare(right.id));
  };

  const readEnabledIds = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(pluginStatePath))) return new Set<string>();
    const state = yield* fileSystem
      .readFileString(pluginStatePath)
      .pipe(Effect.flatMap(decodePluginStateJson));
    return new Set<string>(state.enabled);
  });

  const persistEnabledIds = (
    ids: ReadonlySet<string>,
    operation: PluginPackageOperation,
    id?: string,
  ) =>
    encodePluginStateJson({ enabled: [...ids].sort() }).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: pluginStatePath, contents: `${contents}\n` }),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((error) => operationError(operation, error, id)),
    );

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

  const statusUnlocked = Effect.fn("PluginPackageManager.status")(function* (
    operation: PluginPackageOperation,
  ): Effect.fn.Return<PluginPackageStatusSnapshot, PluginPackageOperationError> {
    const [discovery, enabledIds] = yield* Effect.all(
      [
        discover(operation),
        readEnabledIds.pipe(Effect.mapError((error) => operationError(operation, error))),
      ],
      { concurrency: "unbounded" },
    );
    const discovered = discovery.packages;
    const errors = [...discovery.errors];
    const packages: Array<PluginPackageStatus> = [];
    const packageIds = new Set([...discovered.keys(), ...activeManifests.keys()]);

    for (const id of [...packageIds].sort()) {
      const activeManifest = activeManifests.get(id);
      const packageManifest = activeManifest ?? discovered.get(id)?.manifest;
      if (packageManifest === undefined) continue;
      const directory = discovered.get(id)?.directory ?? path.join(pluginsDirectory, id);
      const iconUrl = yield* readIconUrl(directory, packageManifest.icon);
      const olderApiRemovedIn = packageManifest.capabilities
        .map((capability) => DEPRECATED_CAPABILITIES.get(capability))
        .find((version) => version !== undefined);
      const enabled = enabledIds.has(id);
      const active = activeDefinitions.has(id);
      const error =
        packageErrors.get(id) ?? (enabled && !active ? "enabled package is not active" : undefined);
      packages.push({
        id: packageManifest.id,
        name: packageManifest.name?.trim() || packageManifest.id,
        ...(packageManifest.description?.trim()
          ? { description: packageManifest.description.trim() }
          : {}),
        ...(iconUrl === undefined ? {} : { iconUrl }),
        version: packageManifest.version,
        apiVersion: packageManifest.apiVersion,
        enabled,
        state: error !== undefined ? "error" : active ? "active" : "disabled",
        capabilities: [...packageManifest.capabilities],
        contributions: { commands: [...(packageManifest.contributes?.commands ?? [])] },
        ...(olderApiRemovedIn === undefined ? {} : { olderApiRemovedIn }),
        ...(error === undefined ? {} : { error }),
      });
    }

    for (const id of [...enabledIds].sort()) {
      if (!discovered.has(id)) {
        errors.push({ directory: id, error: "Not installed" });
      }
    }

    return { errors, packages };
  });

  const transition = Effect.fn("PluginPackageManager.transition")(
    (operation: "enable" | "reload", id: string) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const discovery = yield* restore(discover(operation));
          const pluginPackage = discovery.packages.get(id);
          if (pluginPackage === undefined) return yield* new PluginPackageNotFoundError({ id });
          const enabledIds = yield* restore(
            readEnabledIds.pipe(Effect.mapError((error) => operationError(operation, error, id))),
          );
          if (operation === "reload" && !enabledIds.has(id)) {
            return yield* operationError(operation, "package is not enabled", id);
          }
          if (operation === "enable" && activeDefinitions.has(id) && enabledIds.has(id)) {
            return yield* statusUnlocked(operation);
          }
          packageErrors.delete(id);
          failedCommandPlugins.delete(id);

          const previousEnabledIds = new Set(enabledIds);
          const previousCacheDirectory = activeCacheDirectories.get(id);
          const previousRetirement = activeRetirements.get(id);
          const loadedExit = yield* Effect.exit(restore(loadDefinition(pluginPackage, operation)));
          if (loadedExit._tag === "Failure") {
            packageErrors.set(id, detailFromCause(loadedExit.cause));
            return yield* Effect.failCause(loadedExit.cause);
          }
          const loaded = loadedExit.value;
          if (operation === "enable") {
            enabledIds.add(id);
            const persisted = yield* Effect.exit(persistEnabledIds(enabledIds, operation, id));
            if (persisted._tag === "Failure") {
              packageErrors.set(id, detailFromCause(persisted.cause));
              yield* removeCacheDirectory(loaded.cacheDirectory);
              return yield* Effect.failCause(persisted.cause);
            }
          }
          const previousCatalog = yield* catalog.list;
          const reconciled = yield* Effect.exit(
            restore(
              catalog
                .reconcile(definitionList([id, loaded.definition]))
                .pipe(Effect.mapError((error) => operationError(operation, error, id))),
            ),
          );
          if (reconciled._tag === "Failure") {
            const currentCatalog = yield* catalog.list;
            if (currentCatalog.generation === previousCatalog.generation) {
              if (operation === "enable") {
                const rolledBack = yield* Effect.exit(
                  persistEnabledIds(previousEnabledIds, operation, id),
                );
                if (rolledBack._tag === "Failure") {
                  packageErrors.set(id, detailFromCause(reconciled.cause));
                  yield* removeCacheDirectory(loaded.cacheDirectory);
                  yield* Effect.logWarning("Failed to restore enabled plugin state", {
                    id,
                    error: rolledBack.cause,
                  });
                  return yield* Effect.failCause(reconciled.cause);
                }
              }
              packageErrors.set(id, detailFromCause(reconciled.cause));
              yield* removeCacheDirectory(loaded.cacheDirectory);
              return yield* Effect.failCause(reconciled.cause);
            }
          }

          activeDefinitions.set(id, loaded.definition);
          loadedFingerprints.set(id, loaded.fingerprint);
          activeCacheDirectories.set(id, loaded.cacheDirectory);
          activeManifests.set(id, pluginPackage.manifest);
          activeRetirements.set(id, loaded.retired);
          if (reconciled._tag === "Success") {
            // A command of the previous version can fail while reconcile waits for it; that
            // failure belongs to the retired version and must not retire or mark this one.
            packageErrors.delete(id);
            failedCommandPlugins.delete(id);
          }
          if (previousCacheDirectory !== undefined) {
            if (reconciled._tag === "Failure" && previousRetirement !== undefined) {
              yield* Effect.promise(() => previousRetirement);
            }
            yield* removeCacheDirectory(previousCacheDirectory);
          }
          if (reconciled._tag === "Failure") return yield* Effect.failCause(reconciled.cause);
          return yield* statusUnlocked(operation);
        }),
      ),
  );

  const disableUnlocked = Effect.fn("PluginPackageManager.disable")((id: string) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const discovery = yield* restore(discover("disable"));
        const enabledIds = yield* restore(
          readEnabledIds.pipe(Effect.mapError((error) => operationError("disable", error, id))),
        );
        if (!discovery.packages.has(id) && !enabledIds.has(id) && !activeDefinitions.has(id)) {
          return yield* new PluginPackageNotFoundError({ id });
        }
        packageErrors.delete(id);
        failedCommandPlugins.delete(id);

        const previousEnabledIds = new Set(enabledIds);
        enabledIds.delete(id);
        const persisted = yield* Effect.exit(persistEnabledIds(enabledIds, "disable", id));
        if (persisted._tag === "Failure") return yield* Effect.failCause(persisted.cause);
        const previousCatalog = yield* catalog.list;
        const reconciled = yield* Effect.exit(
          restore(
            catalog
              .reconcile(definitionList([id, undefined]))
              .pipe(Effect.mapError((error) => operationError("disable", error, id))),
          ),
        );
        if (reconciled._tag === "Failure") {
          const currentCatalog = yield* catalog.list;
          if (currentCatalog.generation === previousCatalog.generation) {
            const rolledBack = yield* Effect.exit(
              persistEnabledIds(previousEnabledIds, "disable", id),
            );
            if (rolledBack._tag === "Failure") {
              yield* Effect.logWarning("Failed to restore enabled plugin state", {
                id,
                error: rolledBack.cause,
              });
              return yield* Effect.failCause(reconciled.cause);
            }
            return yield* Effect.failCause(reconciled.cause);
          }
        }

        activeDefinitions.delete(id);
        activeManifests.delete(id);
        const cacheDirectory = activeCacheDirectories.get(id);
        const retirement = activeRetirements.get(id);
        activeCacheDirectories.delete(id);
        activeRetirements.delete(id);
        if (cacheDirectory !== undefined) {
          if (reconciled._tag === "Failure" && retirement !== undefined) {
            yield* Effect.promise(() => retirement);
          }
          yield* removeCacheDirectory(cacheDirectory);
        }
        if (reconciled._tag === "Failure") return yield* Effect.failCause(reconciled.cause);
        return yield* statusUnlocked("disable");
      }),
    ),
  );

  // A failed command leaves its package enabled but inactive, showing the reason until Reload.
  const retireFailedCommandPlugins = Effect.uninterruptible(
    Effect.gen(function* () {
      for (const id of failedCommandPlugins) {
        failedCommandPlugins.delete(id);
        if (!activeDefinitions.has(id)) continue;
        const previousCatalog = yield* catalog.list;
        const reconciled = yield* Effect.exit(catalog.reconcile(definitionList([id, undefined])));
        if (
          reconciled._tag === "Failure" &&
          (yield* catalog.list).generation === previousCatalog.generation
        ) {
          yield* Effect.logWarning("Failed to retire failed local plugin package", {
            id,
            error: detailFromCause(reconciled.cause),
          });
          continue;
        }
        const cacheDirectory = activeCacheDirectories.get(id);
        const retirement = activeRetirements.get(id);
        activeDefinitions.delete(id);
        activeCacheDirectories.delete(id);
        activeRetirements.delete(id);
        if (cacheDirectory !== undefined) {
          if (retirement !== undefined) yield* Effect.promise(() => retirement);
          yield* removeCacheDirectory(cacheDirectory);
        }
      }
    }),
  );

  const rescanUnlocked = Effect.fn("PluginPackageManager.rescan")(function* () {
    const discovery = yield* discover("rescan");
    const enabledIds = yield* readEnabledIds.pipe(
      Effect.mapError((error) => operationError("rescan", error)),
    );

    const removed = new Set(
      [...activeDefinitions.keys()].filter((id) => !discovery.packages.has(id)),
    );
    if (removed.size > 0) {
      const retired = yield* Effect.exit(
        catalog.reconcile(
          [...activeDefinitions.values()]
            .filter((definition) => !removed.has(definition.id))
            .sort((left, right) => left.id.localeCompare(right.id)),
        ),
      );
      if (retired._tag === "Failure") {
        const detail = detailFromCause(retired.cause);
        for (const id of removed) packageErrors.set(id, detail);
      } else {
        for (const id of removed) {
          const cacheDirectory = activeCacheDirectories.get(id);
          activeDefinitions.delete(id);
          activeManifests.delete(id);
          activeCacheDirectories.delete(id);
          activeRetirements.delete(id);
          if (cacheDirectory !== undefined) yield* removeCacheDirectory(cacheDirectory);
        }
      }
    }

    for (const id of [...enabledIds].sort()) {
      const pluginPackage = discovery.packages.get(id);
      if (pluginPackage === undefined) {
        // Gone: the status reports it as not installed until it returns.
        loadedFingerprints.delete(id);
        if (!activeDefinitions.has(id)) packageErrors.delete(id);
        continue;
      }
      if (loadedFingerprints.get(id) === (yield* fingerprint(pluginPackage))) continue;
      // A failed reload is recorded against the package and shown in status.
      yield* Effect.exit(transition("reload", id));
    }
    return yield* statusUnlocked("rescan");
  });

  yield* fileSystem
    .remove(pluginCacheDirectory, { recursive: true, force: true })
    .pipe(Effect.mapError((error) => operationError("status", error)));
  yield* fileSystem
    .makeDirectory(pluginCacheDirectory, { recursive: true })
    .pipe(Effect.mapError((error) => operationError("status", error)));
  yield* fileSystem
    .makeDirectory(pluginsDirectory, { recursive: true })
    .pipe(Effect.mapError((error) => operationError("status", error)));

  const startupDiscovery = yield* discover("status");
  for (const error of startupDiscovery.errors) {
    yield* Effect.logWarning("Invalid local plugin package", error);
  }
  const startupEnabledIds = yield* readEnabledIds.pipe(
    Effect.mapError((error) => operationError("status", error)),
  );
  for (const id of [...startupEnabledIds].sort()) {
    const pluginPackage = startupDiscovery.packages.get(id);
    if (pluginPackage === undefined) {
      yield* Effect.logWarning("Enabled local plugin package was not discovered", { id });
      continue;
    }
    const startup = yield* Effect.exit(
      Effect.gen(function* () {
        const loaded = yield* loadDefinition(pluginPackage, "status");
        const reconciled = yield* Effect.exit(
          catalog
            .reconcile(definitionList([id, loaded.definition]))
            .pipe(Effect.mapError((error) => operationError("status", error, id))),
        );
        if (reconciled._tag === "Failure") {
          yield* removeCacheDirectory(loaded.cacheDirectory);
          return yield* Effect.failCause(reconciled.cause);
        }
        activeDefinitions.set(id, loaded.definition);
        loadedFingerprints.set(id, loaded.fingerprint);
        activeCacheDirectories.set(id, loaded.cacheDirectory);
        activeManifests.set(id, pluginPackage.manifest);
        activeRetirements.set(id, loaded.retired);
      }),
    );
    if (startup._tag === "Failure") {
      const detail = detailFromCause(startup.cause);
      packageErrors.set(id, detail);
      yield* Effect.logWarning("Failed to activate enabled local plugin package", { id, detail });
    }
  }

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
          yield* Effect.logWarning("Local plugin package reported a shutdown error", { id, error });
        }
        yield* removeCacheDirectory(pluginCacheDirectory);
      }),
    ),
  );

  // Forked after the shutdown finalizer so it is interrupted first and cannot
  // reload anything once shutdown has retired the packages.
  const rescan = semaphore.withPermits(1)(rescanUnlocked());
  yield* watchPluginsDirectory(fileSystem.watch(pluginsDirectory), rescan).pipe(Effect.forkScoped);

  return {
    status: semaphore.withPermits(1)(statusUnlocked("status")),
    invokeCommand: (input: PluginCommandInvokeInput) =>
      catalog
        .invoke(input)
        .pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              failedCommandPlugins.size === 0
                ? Effect.void
                : semaphore.withPermits(1)(retireFailedCommandPlugins),
            ),
          ),
        ),
    enable: (id: string) => semaphore.withPermits(1)(transition("enable", id)),
    disable: (id: string) => semaphore.withPermits(1)(disableUnlocked(id)),
    reload: (id: string) => semaphore.withPermits(1)(transition("reload", id)),
    rescan,
  } as const;
});

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

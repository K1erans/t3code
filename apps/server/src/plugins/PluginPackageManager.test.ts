import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettingsError } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { PluginManifest } from "@t3tools/plugin-runtime/manifest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PluginCommandCatalog from "./PluginCommandCatalog.ts";
import { installPlugin, removePlugin } from "./PluginInstall.ts";
import * as PluginPackageManager from "./PluginPackageManager.ts";

const packageId = "com.acme.runtime-status";
const commandId = "acme.runtime-status";

const manifest = {
  manifestVersion: 1,
  id: packageId,
  version: "1.0.0",
  apiVersion: 1,
  entrypoints: { server: "./index.mjs" },
  capabilities: ["t3.commands@1"],
  contributes: { commands: [commandId] },
} as const;

const encodeManifest = Schema.encodeSync(Schema.fromJsonString(PluginManifest));
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const decodePersistedEnabledPlugins = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ enabledPluginIds: Schema.optional(Schema.Array(Schema.String)) }),
  ),
);

const pluginSource = (disposalFile: string, message = "External plugin runtime is active.") => `
import { appendFile } from "node:fs/promises";

export default function activate(api) {
  api.registerCommand(
    {
      id: "${commandId}",
      label: "External runtime status",
      description: "Report status from an external local plugin package.",
      surfaces: ["web", "desktop", "mobile"]
    },
    () => ({ message: ${encodeJsonString(message)}, tone: "success" })
  );
  api.onDispose(() => appendFile(${encodeJsonString(disposalFile)}, "disposed\\n"));
}
`;

const pluginSourceWithHelper = `
import { message } from "./message.mjs";

export default function activate(api) {
  api.registerCommand(
    {
      id: "${commandId}",
      label: "External runtime status",
      surfaces: ["web", "desktop", "mobile"]
    },
    () => ({ message, tone: "success" })
  );
}
`;

const pluginSourceWithRetirementGate = (startedSymbol: string, releaseSymbol: string) => `
export default function activate(api) {
  api.registerCommand(
    {
      id: "${commandId}",
      label: "External runtime status",
      surfaces: ["web", "desktop", "mobile"]
    },
    () => ({ message: "retirement gate", tone: "success" })
  );
  api.onDispose(() => new Promise((resolve) => {
    const markStarted = Reflect.get(globalThis, Symbol.for(${encodeJsonString(startedSymbol)}));
    if (typeof markStarted === "function") markStarted();
    Reflect.set(globalThis, Symbol.for(${encodeJsonString(releaseSymbol)}), resolve);
  }));
}
`;

const pluginSourceWithCleanupFailure = `
export default function activate(api) {
  api.registerCommand(
    {
      id: "${commandId}",
      label: "External runtime status",
      surfaces: ["web", "desktop", "mobile"]
    },
    () => ({ message: "cleanup failure", tone: "success" })
  );
  api.onDispose(() => { throw new Error("cleanup exploded"); });
}
`;

interface EnvironmentLayerOptions {
  readonly persistenceFailures?: { remaining: number };
  readonly startupFailure?: boolean;
}

const makeEnvironmentLayer = (baseDir: string, options?: EnvironmentLayerOptions) => {
  const configLayer = Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir));
  const liveSettingsLayer = ServerSettings.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(configLayer),
  );
  const persistenceFailures = options?.persistenceFailures;
  const startupFailure = options?.startupFailure === true;
  const settingsLayer =
    persistenceFailures === undefined && !startupFailure
      ? liveSettingsLayer
      : Layer.effect(
          ServerSettings.ServerSettingsService,
          Effect.gen(function* () {
            const live = yield* ServerSettings.ServerSettingsService;
            return ServerSettings.ServerSettingsService.of({
              ...live,
              start: startupFailure
                ? Effect.fail(
                    new ServerSettingsError({
                      cause: new Error("injected startup failure"),
                      operation: "read-file",
                      settingsPath: `${baseDir}/userdata/settings.json`,
                    }),
                  )
                : live.start,
              setEnabledPluginIds: (ids) =>
                Effect.suspend(() => {
                  if (persistenceFailures !== undefined && persistenceFailures.remaining > 0) {
                    persistenceFailures.remaining -= 1;
                    return Effect.fail(
                      new ServerSettingsError({
                        cause: new Error("injected persistence failure"),
                        operation: "write-file",
                        settingsPath: `${baseDir}/userdata/settings.json`,
                      }),
                    );
                  }
                  return live.setEnabledPluginIds(ids);
                }),
            });
          }),
        ).pipe(Layer.provide(liveSettingsLayer));

  return PluginPackageManager.layer.pipe(
    Layer.provideMerge(PluginCommandCatalog.layer),
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(configLayer),
  );
};

const useEnvironment = <A, E>(
  baseDir: string,
  effect: Effect.Effect<
    A,
    E,
    PluginPackageManager.PluginPackageManager | PluginCommandCatalog.PluginCommandCatalog
  >,
  options?: EnvironmentLayerOptions,
) => Effect.scoped(effect.pipe(Effect.provide(makeEnvironmentLayer(baseDir, options))));

it.layer(NodeServices.layer)("plugin package lifecycle", (it) => {
  it.effect("keeps the environment available when package manager startup fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-startup-failure-test-",
      });

      const exit = yield* Effect.exit(
        useEnvironment(
          baseDir,
          Effect.gen(function* () {
            const manager = yield* PluginPackageManager.PluginPackageManager;
            return yield* Effect.exit(manager.status);
          }),
          { startupFailure: true },
        ),
      );

      expect(exit._tag).toBe("Success");
      if (exit._tag === "Success") {
        expect(exit.value._tag).toBe("Failure");
      }
    }),
  );

  it.effect("loads the committed external runtime-status example without rebuilding", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-example-test-",
      });
      const exampleId = "com.t3code.runtime-status-example";
      const exampleCommandId = "example.runtime-status";
      yield* fileSystem.makeDirectory(`${baseDir}/userdata/plugins`, { recursive: true });
      yield* fileSystem.copy(
        path.resolve(import.meta.dirname, "../../../../examples/plugins/runtime-status"),
        `${baseDir}/userdata/plugins/${exampleId}`,
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          yield* manager.enable(exampleId);
          const listed = yield* catalog.list;
          expect(
            yield* catalog.invoke({ generation: listed.generation, id: exampleCommandId }),
          ).toEqual({ message: "external plugin runtime is active.", tone: "success" });
        }),
      );
    }),
  );

  it.effect("discovers, enables, restarts, and cleanly disables an external package", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest(manifest),
      );
      yield* fileSystem.writeFileString(
        `${packageDirectory}/index.mjs`,
        pluginSource(`${packageDirectory}/disposed.log`),
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;

          expect((yield* Effect.exit(manager.reload(packageId)))._tag).toBe("Failure");
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, enabled: false, state: "disabled" }],
          });

          expect(yield* manager.enable(packageId)).toMatchObject({
            packages: [{ id: packageId, enabled: true, state: "active" }],
          });
          const listed = yield* catalog.list;
          expect(listed.commands.map((command) => command.id)).toContain(commandId);
          expect(yield* catalog.invoke({ generation: listed.generation, id: commandId })).toEqual({
            message: "External plugin runtime is active.",
            tone: "success",
          });
        }),
      );

      expect(
        decodePersistedEnabledPlugins(
          yield* fileSystem.readFileString(`${baseDir}/userdata/settings.json`),
        ).enabledPluginIds,
      ).toEqual([packageId]);

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;

          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, enabled: true, state: "active" }],
          });
          expect((yield* catalog.list).commands.map((command) => command.id)).toContain(commandId);

          expect(yield* manager.disable(packageId)).toMatchObject({
            packages: [{ id: packageId, enabled: false, state: "disabled" }],
          });
          expect((yield* catalog.list).commands.map((command) => command.id)).not.toContain(
            commandId,
          );
        }),
      );

      const persisted = yield* fileSystem.readFileString(`${baseDir}/userdata/settings.json`);
      expect(decodePersistedEnabledPlugins(persisted).enabledPluginIds ?? []).toEqual([]);
      expect(yield* fileSystem.readFileString(`${packageDirectory}/disposed.log`)).toBe(
        "disposed\ndisposed\n",
      );
    }),
  );

  it.effect("keeps the previous generation when import or activation fails during reload", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-rollback-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest(manifest),
      );
      yield* fileSystem.writeFileString(`${packageDirectory}/index.mjs`, pluginSourceWithHelper);
      yield* fileSystem.writeFileString(
        `${packageDirectory}/message.mjs`,
        'export const message = "generation one";\n',
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          yield* manager.enable(packageId);
          const committed = yield* catalog.list;
          const manifestV2 = { ...manifest, version: "2.0.0" as const };
          yield* fileSystem.writeFileString(
            `${packageDirectory}/t3-plugin.json`,
            encodeManifest(manifestV2),
          );

          yield* fileSystem.writeFileString(`${packageDirectory}/index.mjs`, "export default (");
          expect((yield* Effect.exit(manager.reload(packageId)))._tag).toBe("Failure");
          expect(yield* catalog.list).toBe(committed);
          expect(
            yield* catalog.invoke({ generation: committed.generation, id: commandId }),
          ).toEqual({ message: "generation one", tone: "success" });

          yield* fileSystem.writeFileString(
            `${packageDirectory}/index.mjs`,
            "export default function activate() { throw new Error('activation failed') }",
          );
          expect((yield* Effect.exit(manager.reload(packageId)))._tag).toBe("Failure");
          expect(yield* catalog.list).toBe(committed);
          expect(yield* manager.status).toMatchObject({
            packages: [
              {
                id: packageId,
                version: "1.0.0",
                enabled: true,
                state: "error",
                error: "activation failed",
              },
            ],
          });
          yield* manager.enable(packageId);
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, state: "error", error: "activation failed" }],
          });

          yield* fileSystem.writeFileString(
            `${packageDirectory}/index.mjs`,
            pluginSourceWithHelper,
          );
          yield* fileSystem.writeFileString(
            `${packageDirectory}/message.mjs`,
            'export const message = "generation two";\n',
          );
          yield* manager.reload(packageId);
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, version: "2.0.0", enabled: true, state: "active" }],
          });
          const reloaded = yield* catalog.list;
          expect(reloaded.generation).toBeGreaterThan(committed.generation);
          expect(yield* catalog.invoke({ generation: reloaded.generation, id: commandId })).toEqual(
            {
              message: "generation two",
              tone: "success",
            },
          );
        }),
      );
    }),
  );

  it.effect("rejects symbolic links before importing a trusted local package", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-symlink-test-",
      });
      const sourceDirectory = `${baseDir}/linked-package-source`;
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      yield* fileSystem.makeDirectory(sourceDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(`${baseDir}/userdata/plugins`, { recursive: true });
      yield* fileSystem.writeFileString(
        `${sourceDirectory}/t3-plugin.json`,
        encodeManifest(manifest),
      );
      yield* fileSystem.writeFileString(
        `${sourceDirectory}/index.mjs`,
        pluginSource(`${sourceDirectory}/disposed.log`),
      );
      yield* fileSystem.symlink(sourceDirectory, packageDirectory);

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          expect((yield* Effect.exit(manager.enable(packageId)))._tag).toBe("Failure");
          expect((yield* catalog.list).commands.map((command) => command.id)).not.toContain(
            commandId,
          );
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, enabled: false, state: "error" }],
          });
        }),
      );
    }),
  );

  it.effect("keeps runtime and persisted enablement aligned when settings writes fail", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-persistence-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest(manifest),
      );
      yield* fileSystem.writeFileString(
        `${packageDirectory}/index.mjs`,
        pluginSource(`${packageDirectory}/disposed.log`),
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          expect((yield* Effect.exit(manager.enable(packageId)))._tag).toBe("Failure");
          expect((yield* catalog.list).commands.map((command) => command.id)).not.toContain(
            commandId,
          );
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, enabled: false }],
          });
        }),
        { persistenceFailures: { remaining: 1 } },
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          yield* manager.enable(packageId);
        }),
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          expect((yield* Effect.exit(manager.disable(packageId)))._tag).toBe("Failure");
          expect((yield* catalog.list).commands.map((command) => command.id)).toContain(commandId);
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, enabled: true, state: "active" }],
          });
        }),
        { persistenceFailures: { remaining: 1 } },
      );
    }),
  );

  it.effect("reports an invalid local manifest without blocking the package service", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-invalid-test-",
      });
      const invalidDirectory = `${baseDir}/userdata/plugins/broken-package`;
      yield* fileSystem.makeDirectory(invalidDirectory, { recursive: true });
      yield* fileSystem.writeFileString(`${invalidDirectory}/t3-plugin.json`, "{}");

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const status = yield* manager.status;
          expect(status).toMatchObject({
            errors: [{ directory: "broken-package" }],
            packages: [],
          });
          expect(status.errors[0]?.error).toContain("manifestVersion");
          expect(status.errors[0]?.error).not.toContain("Cause([");
        }),
      );
    }),
  );

  it.effect("reports cleanup failures after disabling the committed package", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-cleanup-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest(manifest),
      );
      yield* fileSystem.writeFileString(
        `${packageDirectory}/index.mjs`,
        pluginSourceWithCleanupFailure,
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          yield* manager.enable(packageId);
          expect(yield* manager.disable(packageId)).toMatchObject({
            packages: [
              {
                id: packageId,
                enabled: false,
                state: "error",
                error: "cleanup exploded",
              },
            ],
          });
          expect((yield* catalog.list).commands.map((command) => command.id)).not.toContain(
            commandId,
          );
        }),
      );
    }),
  );

  it.effect("finishes disable bookkeeping when interrupted after the runtime commits", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-interruption-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      const startedSymbol = `t3.test.plugin.retirement.started.${baseDir}`;
      const releaseSymbol = `t3.test.plugin.retirement.${baseDir}`;
      let markRetirementStarted!: () => void;
      const retirementStarted = new Promise<void>((resolve) => {
        markRetirementStarted = resolve;
      });
      Reflect.set(globalThis, Symbol.for(startedSymbol), markRetirementStarted);
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest(manifest),
      );
      yield* fileSystem.writeFileString(
        `${packageDirectory}/index.mjs`,
        pluginSourceWithRetirementGate(startedSymbol, releaseSymbol),
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          yield* manager.enable(packageId);
          const disabling = yield* Effect.forkChild(manager.disable(packageId));
          yield* Effect.promise(() => retirementStarted);

          const interrupting = yield* Effect.forkChild(Fiber.interrupt(disabling));
          yield* Effect.yieldNow;
          const release = Reflect.get(globalThis, Symbol.for(releaseSymbol));
          expect(release).toBeTypeOf("function");
          if (typeof release === "function") release();
          yield* Fiber.join(interrupting);
          expect(
            yield* fileSystem.exists(`${baseDir}/userdata/plugin-cache/${packageId}/0`).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 millis"),
                until: (exists) => !exists,
              }),
              Effect.timeout("2 seconds"),
            ),
          ).toBe(false);
          Reflect.deleteProperty(globalThis, Symbol.for(startedSymbol));
          Reflect.deleteProperty(globalThis, Symbol.for(releaseSymbol));

          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, enabled: false, state: "disabled" }],
          });
          expect((yield* catalog.list).commands.map((command) => command.id)).not.toContain(
            commandId,
          );
        }),
      );
      const persisted = yield* fileSystem.readFileString(`${baseDir}/userdata/settings.json`);
      expect(decodePersistedEnabledPlugins(persisted).enabledPluginIds ?? []).toEqual([]);
    }),
  );
});

it.layer(NodeServices.layer)("plugin package pickup", (it) => {
  it.effect("reloads changed enabled packages and reports removed ones as not installed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-rescan-test-",
      });
      const pluginsDirectory = `${baseDir}/userdata/plugins`;
      const disposalFile = `${baseDir}/disposed.log`;
      const writeSource = Effect.fn(function* (
        name: string,
        packageManifest: PluginManifest,
        source: string,
      ) {
        const directory = `${baseDir}/sources/${name}`;
        yield* fileSystem.makeDirectory(directory, { recursive: true });
        yield* fileSystem.writeFileString(
          `${directory}/t3-plugin.json`,
          encodeManifest(packageManifest),
        );
        yield* fileSystem.writeFileString(`${directory}/index.mjs`, source);
        return directory;
      });
      const path = yield* Path.Path;
      const withFileSystem = <A, E>(
        effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
      ) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
      const install = (source: string) =>
        withFileSystem(installPlugin({ pluginsDirectory, source }));
      yield* install(yield* writeSource("v1", manifest, pluginSource(disposalFile, "version one")));

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          const invoke = Effect.gen(function* () {
            const listed = yield* catalog.list;
            return yield* catalog.invoke({ generation: listed.generation, id: commandId });
          });
          yield* manager.enable(packageId);

          // Nothing changed, so nothing reloads.
          yield* manager.rescan;
          expect(yield* fileSystem.exists(disposalFile)).toBe(false);

          yield* install(
            yield* writeSource(
              "v2",
              { ...manifest, version: "2.0.0" },
              pluginSource(disposalFile, "version two"),
            ),
          );
          yield* install(
            yield* writeSource(
              "other",
              { ...manifest, id: "com.acme.other", capabilities: [], contributes: {} },
              "export default () => {};\n",
            ),
          );
          expect(yield* manager.rescan).toMatchObject({
            packages: [
              { id: "com.acme.other", enabled: false, state: "disabled" },
              { id: packageId, version: "2.0.0", enabled: true, state: "active" },
            ],
          });
          expect(yield* invoke).toMatchObject({ message: "version two" });

          yield* withFileSystem(removePlugin({ pluginsDirectory, id: packageId }));
          const removed = yield* manager.rescan;
          expect(removed.packages.map((pluginPackage) => pluginPackage.id)).toEqual([
            "com.acme.other",
          ]);
          expect(removed.errors).toContainEqual({ directory: packageId, error: "Not installed" });
          expect((yield* catalog.list).commands.map((command) => command.id)).not.toContain(
            commandId,
          );

          // Reinstalling brings the still-enabled package back.
          yield* install(`${baseDir}/sources/v2`);
          expect(yield* manager.rescan).toMatchObject({
            packages: [{ id: "com.acme.other" }, { id: packageId, state: "active" }],
          });
        }),
      );
    }),
  );

  it.effect("rescans once per debounced burst of folder events", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<string>();
      const rescans = yield* Queue.unbounded<number>();
      let count = 0;
      yield* PluginPackageManager.watchPluginsDirectory(
        Stream.fromQueue(events),
        // A failing rescan must not end the watch.
        Effect.suspend(() => Queue.offer(rescans, ++count)).pipe(
          Effect.andThen(Effect.fail("boom")),
        ),
      ).pipe(Effect.forkScoped);

      yield* Queue.offerAll(events, ["a", "b", "c"]);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(
        Duration.subtract(PluginPackageManager.WATCH_DEBOUNCE, Duration.millis(1)),
      );
      expect(yield* Queue.size(rescans)).toBe(0);
      yield* TestClock.adjust(Duration.millis(1));
      expect(yield* Queue.take(rescans)).toBe(1);

      yield* Queue.offer(events, "d");
      yield* Effect.yieldNow;
      yield* TestClock.adjust(PluginPackageManager.WATCH_DEBOUNCE);
      expect(yield* Queue.take(rescans)).toBe(2);
      expect(yield* Queue.size(rescans)).toBe(0);
    }),
  );
});

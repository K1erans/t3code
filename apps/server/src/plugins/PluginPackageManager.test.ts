import * as NodeServices from "@effect/platform-node/NodeServices";
import { PluginCommandInvocationError, ServerSettingsError } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { PluginManifest } from "@t3tools/plugin-runtime/manifest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PluginCommandCatalog from "./PluginCommandCatalog.ts";
import * as PluginPackageManager from "./PluginPackageManager.ts";

const packageId = "com.acme.runtime-status";
const commandId = "acme.runtime-status";
const countCommandId = "acme.count-invocations";

const manifest = {
  manifestVersion: 1,
  id: packageId,
  version: "1.0.0",
  apiVersion: 1,
  entrypoints: { server: "./index.mjs" },
  capabilities: ["t3.commands@1", "t3.storage@0"],
  contributes: { commands: [commandId, countCommandId] },
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
  api.registerCommand(
    {
      id: "${countCommandId}",
      label: "Count invocations",
      surfaces: ["web", "desktop", "mobile"]
    },
    async () => {
      const count = await api.storage.update("invocations", (current) => (current ?? 0) + 1);
      return { message: "Invoked " + count + " times.", tone: "success" };
    }
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
  readonly entryPointTimeout?: Duration.Input;
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

  const entryPointTimeout = options?.entryPointTimeout;
  return PluginPackageManager.layerWith(
    entryPointTimeout === undefined ? {} : { entryPointTimeout },
  ).pipe(
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

  it.effect("keeps plugin storage across reload, disable, and restart", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-storage-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      const dataDirectory = `${baseDir}/userdata/plugin-data/${packageId}`;
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest(manifest),
      );
      yield* fileSystem.writeFileString(
        `${packageDirectory}/index.mjs`,
        pluginSource(`${packageDirectory}/disposed.log`),
      );

      const count = Effect.gen(function* () {
        const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
        const listed = yield* catalog.list;
        return (yield* catalog.invoke({ generation: listed.generation, id: countCommandId }))
          .message;
      });

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          yield* manager.enable(packageId);
          expect(yield* count).toBe("Invoked 1 times.");
          expect(yield* count).toBe("Invoked 2 times.");
          yield* manager.reload(packageId);
          expect(yield* count).toBe("Invoked 3 times.");
          yield* manager.disable(packageId);
          expect(yield* fileSystem.exists(`${dataDirectory}/storage.sqlite`)).toBe(true);
          yield* manager.enable(packageId);
          expect(yield* count).toBe("Invoked 4 times.");
        }),
      );

      expect(yield* useEnvironment(baseDir, count)).toBe("Invoked 5 times.");
      expect(yield* fileSystem.exists(`${dataDirectory}/storage.sqlite`)).toBe(true);
      expect(yield* fileSystem.exists(`${baseDir}/userdata/state.sqlite`)).toBe(false);
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
                error: "activate threw: activation failed",
              },
            ],
          });
          yield* manager.enable(packageId);
          expect(yield* manager.status).toMatchObject({
            packages: [
              { id: packageId, state: "error", error: "activate threw: activation failed" },
            ],
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
                error: "dispose threw: cleanup exploded",
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

const healthyPackageId = "com.acme.healthy";
const healthyCommandId = "acme.healthy";

const writePackage = (baseDir: string, id: string, command: string, source: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const packageDirectory = `${baseDir}/userdata/plugins/${id}`;
    yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
    yield* fileSystem.writeFileString(
      `${packageDirectory}/t3-plugin.json`,
      encodeManifest({ ...manifest, id, contributes: { commands: [command] } }),
    );
    yield* fileSystem.writeFileString(`${packageDirectory}/index.mjs`, source);
    return packageDirectory;
  });

const commandPluginSource = (handlerSource: string, disposalFile: string) => `
import { appendFile } from "node:fs/promises";

export default function activate(api) {
  api.registerCommand(
    { id: "${commandId}", label: "Failing command", surfaces: ["web", "desktop", "mobile"] },
    ${handlerSource}
  );
  api.onDispose(() => appendFile(${encodeJsonString(disposalFile)}, "disposed\\n"));
}
`;

const healthySource = `
export default function activate(api) {
  api.registerCommand(
    { id: "${healthyCommandId}", label: "Healthy", surfaces: ["web", "desktop", "mobile"] },
    () => ({ message: "still healthy", tone: "success" })
  );
}
`;

const encodeInvocationError = Schema.encodeUnknownSync(
  Schema.fromJsonString(PluginCommandInvocationError),
);

const failureCases = [
  {
    outcome: "threw",
    activate: "throw new Error('boom')",
    handler: "() => { throw new Error('boom') }",
  },
  {
    outcome: "rejected",
    activate: "return Promise.reject(new Error('boom'))",
    handler: "async () => { throw new Error('boom') }",
  },
  {
    outcome: "timed out",
    activate: "return new Promise(() => {})",
    handler: "() => new Promise(() => {})",
  },
] as const;

const expectedMessage = (outcome: string) =>
  outcome === "timed out" ? "did not finish within 50ms" : "boom";

// Live clock: the timeout cases exercise the real entry point timer.
describe("plugin failure containment", () => {
  for (const { outcome, activate } of failureCases) {
    it.live(`marks only the plugin whose activate ${outcome} as failed`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-plugin-activate-failure-test-",
        });
        yield* writePackage(
          baseDir,
          packageId,
          commandId,
          `export default function activate() { ${activate} }`,
        );
        yield* writePackage(baseDir, healthyPackageId, healthyCommandId, healthySource);

        yield* useEnvironment(
          baseDir,
          Effect.gen(function* () {
            const manager = yield* PluginPackageManager.PluginPackageManager;
            const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
            yield* manager.enable(healthyPackageId);
            expect((yield* Effect.exit(manager.enable(packageId)))._tag).toBe("Failure");

            const status = yield* manager.status;
            expect(status.packages).toMatchObject([
              { id: healthyPackageId, state: "active" },
              {
                id: packageId,
                state: "error",
                error: `activate ${outcome}: ${expectedMessage(outcome)}`,
              },
            ]);
            const listed = yield* catalog.list;
            expect(listed.commands.map((command) => command.id)).not.toContain(commandId);
            expect(
              yield* manager.invokeCommand({ generation: listed.generation, id: healthyCommandId }),
            ).toEqual({ message: "still healthy", tone: "success" });
          }),
          { entryPointTimeout: "50 millis" },
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  }

  for (const { outcome, handler } of failureCases) {
    it.live(`retires the plugin whose command ${outcome} and keeps the reason`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-plugin-command-failure-test-",
        });
        const disposalFile = `${baseDir}/disposed.log`;
        yield* writePackage(
          baseDir,
          packageId,
          commandId,
          commandPluginSource(handler, disposalFile),
        );
        yield* writePackage(baseDir, healthyPackageId, healthyCommandId, healthySource);

        yield* useEnvironment(
          baseDir,
          Effect.gen(function* () {
            const manager = yield* PluginPackageManager.PluginPackageManager;
            const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
            yield* manager.enable(healthyPackageId);
            yield* manager.enable(packageId);
            const listed = yield* catalog.list;

            const failure = yield* Effect.flip(
              manager.invokeCommand({ generation: listed.generation, id: commandId }),
            );
            const reason = `command ${commandId} ${outcome}: ${expectedMessage(outcome)}`;
            expect(failure._tag).toBe("PluginCommandInvocationError");
            const encoded = encodeInvocationError(failure);
            expect(encoded).toContain(reason);
            expect(encoded).not.toContain("index.mjs");

            expect((yield* manager.status).packages).toMatchObject([
              { id: healthyPackageId, state: "active" },
              { id: packageId, enabled: true, state: "error", error: reason },
            ]);
            expect(yield* fileSystem.readFileString(disposalFile)).toBe("disposed\n");
            const afterFailure = yield* catalog.list;
            expect(afterFailure.commands.map((command) => command.id)).toEqual(
              expect.arrayContaining([healthyCommandId]),
            );
            expect(afterFailure.commands.map((command) => command.id)).not.toContain(commandId);
            expect(
              yield* manager.invokeCommand({
                generation: afterFailure.generation,
                id: healthyCommandId,
              }),
            ).toEqual({ message: "still healthy", tone: "success" });

            expect((yield* manager.reload(packageId)).packages).toMatchObject([
              { id: healthyPackageId, state: "active" },
              { id: packageId, state: "active" },
            ]);
          }),
          { entryPointTimeout: "50 millis" },
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  }

  it.live("keeps a reload active when the previous version's command fails during it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-reload-race-test-",
      });
      const gateSymbol = `t3.test.plugin.reload-race.${baseDir}`;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const gate = {
        loads: 0,
        calls: 0,
        started: markStarted,
        reject: (() => {}) as (error: Error) => void,
      };
      Reflect.set(globalThis, Symbol.for(gateSymbol), gate);
      // The first call blocks; importing the reloaded version rejects it mid-reload.
      yield* writePackage(
        baseDir,
        packageId,
        commandId,
        `
const gate = globalThis[Symbol.for(${encodeJsonString(gateSymbol)})];
gate.loads += 1;
if (gate.loads === 2) gate.reject(new Error("late"));
export default function activate(api) {
  api.registerCommand(
    { id: "${commandId}", label: "Racing command", surfaces: ["web", "desktop", "mobile"] },
    () => gate.calls++ === 0
      ? new Promise((_, reject) => { gate.reject = reject; gate.started(); })
      : { message: "reloaded", tone: "success" }
  );
}
`,
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          yield* manager.enable(packageId);
          const invoking = yield* Effect.forkChild(
            manager.invokeCommand({ generation: (yield* catalog.list).generation, id: commandId }),
          );
          yield* Effect.promise(() => started);

          expect((yield* manager.reload(packageId)).packages).toMatchObject([
            { id: packageId, state: "active" },
          ]);
          expect((yield* Fiber.await(invoking))._tag).toBe("Failure");

          const status = yield* manager.status;
          expect(status.packages).toMatchObject([{ id: packageId, state: "active" }]);
          expect(status.packages[0]?.error).toBeUndefined();
          expect(
            yield* manager.invokeCommand({
              generation: (yield* catalog.list).generation,
              id: commandId,
            }),
          ).toEqual({ message: "reloaded", tone: "success" });
        }),
      );
      Reflect.deleteProperty(globalThis, Symbol.for(gateSymbol));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

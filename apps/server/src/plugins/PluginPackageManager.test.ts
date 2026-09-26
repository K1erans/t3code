import * as NodeServices from "@effect/platform-node/NodeServices";
import { PluginCommandInvocationError } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { PluginManifest } from "@t3tools/plugin-runtime/manifest";

import * as ServerConfig from "../config.ts";
import * as PluginCommandCatalog from "./PluginCommandCatalog.ts";
import { installPlugin, removePlugin } from "./PluginInstall.ts";
import * as PluginPackageManager from "./PluginPackageManager.ts";

const packageId = "com.example.fixture";
const commandId = "fixture.say-hello";
const countCommandId = "fixture.count-invocations";

const manifest = {
  manifestVersion: 1,
  id: packageId,
  name: "Fixture",
  version: "1.0.0",
  requires: ["t3.commands@0", "t3.storage@0"],
  entrypoints: { server: "./index.mjs" },
  contributes: {
    commands: [
      { id: commandId, title: "Say hello" },
      { id: countCommandId, title: "Count invocations" },
    ],
  },
} as const;

const encodeManifest = Schema.encodeSync(Schema.fromJsonString(PluginManifest));
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const PluginStateJson = Schema.fromJsonString(
  Schema.Struct({
    enabled: Schema.Array(Schema.String),
    missingSince: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  }),
);
const decodePluginState = Schema.decodeUnknownSync(PluginStateJson);
const encodePluginState = Schema.encodeSync(PluginStateJson);
const readPluginState = (baseDir: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(`${baseDir}/userdata/plugins.json`)),
    Effect.map(decodePluginState),
  );
const readEnabledIds = (baseDir: string) =>
  readPluginState(baseDir).pipe(Effect.map((state) => state.enabled));
/** Runs `effect` while the state directory rejects writes, so persisting enabled state fails. */
const withReadOnlyStateDir = <A, E, R>(
  fileSystem: FileSystem.FileSystem,
  baseDir: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    fileSystem.chmod(`${baseDir}/userdata`, 0o555),
    () => effect,
    () => fileSystem.chmod(`${baseDir}/userdata`, 0o755).pipe(Effect.orDie),
  );

const pluginSource = (disposalFile: string, message = "External plugin runtime is active.") => `
import { appendFile } from "node:fs/promises";

export default function activate(api) {
  api.registerCommand("${commandId}", () => ({ message: ${encodeJsonString(message)}, tone: "success" })
  );
  api.registerCommand("${countCommandId}", async () => {
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
  api.registerCommand("${commandId}", () => ({ message, tone: "success" })
  );
}
`;

const pluginSourceWithRetirementGate = (startedSymbol: string, releaseSymbol: string) => `
export default function activate(api) {
  api.registerCommand("${commandId}", () => ({ message: "retirement gate", tone: "success" })
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
  api.registerCommand("${commandId}", () => ({ message: "cleanup failure", tone: "success" })
  );
  api.onDispose(() => { throw new Error("cleanup exploded"); });
}
`;

interface EnvironmentLayerOptions {
  readonly entryPointTimeout?: Duration.Input;
}

const makeEnvironmentLayer = (baseDir: string, options?: EnvironmentLayerOptions) => {
  const configLayer = Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir));
  const entryPointTimeout = options?.entryPointTimeout;
  return PluginPackageManager.layerWith(
    entryPointTimeout === undefined ? {} : { entryPointTimeout },
  ).pipe(Layer.provideMerge(PluginCommandCatalog.layer), Layer.provideMerge(configLayer));
};

const useEnvironment = <A, E>(
  baseDir: string,
  effect: Effect.Effect<
    A,
    E,
    | PluginPackageManager.PluginPackageManager
    | PluginCommandCatalog.PluginCommandCatalog
    | FileSystem.FileSystem
  >,
  options?: EnvironmentLayerOptions,
) => Effect.scoped(effect.pipe(Effect.provide(makeEnvironmentLayer(baseDir, options))));

it.layer(NodeServices.layer)("plugin package lifecycle", (it) => {
  it.effect("keeps the environment available when plugin state is unreadable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-startup-failure-test-",
      });
      yield* fileSystem.makeDirectory(`${baseDir}/userdata`, { recursive: true });
      yield* fileSystem.writeFileString(`${baseDir}/userdata/plugins.json`, "{ not json");

      const exit = yield* Effect.exit(
        useEnvironment(
          baseDir,
          Effect.gen(function* () {
            const manager = yield* PluginPackageManager.PluginPackageManager;
            return yield* Effect.exit(manager.status);
          }),
        ),
      );

      expect(exit._tag).toBe("Success");
      if (exit._tag === "Success") {
        expect(exit.value._tag).toBe("Failure");
      }
    }),
  );

  it.effect("keeps enabled packages idle at startup until a command activates them", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-lazy-activation-test-",
      });
      const gateSymbol = `t3.test.plugin.lazy-activation.${baseDir}`;
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markActivating!: () => void;
      const activatingStarted = new Promise<void>((resolve) => {
        markActivating = resolve;
      });
      const gate = { activations: 0, started: markActivating, released };
      yield* Effect.acquireRelease(
        Effect.sync(() => Reflect.set(globalThis, Symbol.for(gateSymbol), gate)),
        () => Effect.sync(() => Reflect.deleteProperty(globalThis, Symbol.for(gateSymbol))),
      );
      yield* writePackage(
        baseDir,
        packageId,
        commandId,
        `export default async function activate(api) {
  const gate = globalThis[Symbol.for(${encodeJsonString(gateSymbol)})];
  gate.activations += 1;
  gate.started();
  await gate.released;
  api.registerCommand("${commandId}", () => ({ message: "ready", tone: "success" }));
}
`,
      );
      yield* fileSystem.writeFileString(
        `${baseDir}/userdata/plugins.json`,
        `{"enabled":["${packageId}"]}\n`,
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          // Rescan queues behind the startup load, which does not activate anything.
          expect(yield* manager.rescan).toMatchObject({
            packages: [{ id: packageId, enabled: true, state: "idle" }],
          });
          expect(gate.activations).toBe(0);
          // The palette lists the command from the manifest.
          const listed = yield* catalog.list;
          expect(listed.commands).toEqual([
            { id: commandId, label: "Test command", surfaces: ["web", "desktop"] },
          ]);

          // Both callers wait for the one activation instead of failing.
          const input = { generation: listed.generation, id: commandId };
          const first = yield* Effect.forkChild(manager.invokeCommand(input));
          const second = yield* Effect.forkChild(manager.invokeCommand(input));
          yield* Effect.promise(() => activatingStarted);
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, state: "activating" }],
          });
          release();
          expect(yield* Fiber.join(first)).toEqual({ message: "ready", tone: "success" });
          expect(yield* Fiber.join(second)).toEqual({ message: "ready", tone: "success" });
          expect(gate.activations).toBe(1);
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, state: "active" }],
          });
          // Activating did not change the catalog clients hold.
          expect(yield* catalog.list).toBe(listed);
        }),
      );
    }),
  );

  it.effect("activates onStartup packages with the server and keeps them running", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-on-startup-test-",
      });
      const packageDirectory = yield* writePackage(baseDir, packageId, commandId, healthySource);
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest({
          ...manifest,
          activationEvents: ["onStartup"],
          contributes: { commands: [{ id: healthyCommandId, title: "Test command" }] },
        }),
      );
      yield* fileSystem.writeFileString(
        `${baseDir}/userdata/plugins.json`,
        `{"enabled":["${packageId}"]}\n`,
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          expect(yield* manager.rescan).toMatchObject({
            packages: [{ id: packageId, state: "active" }],
          });
          yield* TestClock.adjust(
            Duration.sum(
              PluginPackageManager.IDLE_TIMEOUT,
              PluginPackageManager.IDLE_CHECK_INTERVAL,
            ),
          );
          expect(yield* manager.rescan).toMatchObject({
            packages: [{ id: packageId, state: "active" }],
          });
        }),
      );
    }),
  );

  it.effect("shuts idle packages down and reactivates them on the next command", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-idle-test-",
      });
      const hookSymbol = `t3.test.plugin.idle.${baseDir}`;
      const hook = { activations: 0, disposed: () => {} };
      yield* Effect.acquireRelease(
        Effect.sync(() => Reflect.set(globalThis, Symbol.for(hookSymbol), hook)),
        () => Effect.sync(() => Reflect.deleteProperty(globalThis, Symbol.for(hookSymbol))),
      );
      yield* writePackage(
        baseDir,
        packageId,
        commandId,
        `export default function activate(api) {
  const hook = globalThis[Symbol.for(${encodeJsonString(hookSymbol)})];
  hook.activations += 1;
  api.registerCommand("${commandId}", () => ({ message: "run " + hook.activations, tone: "success" }));
  api.onDispose(() => hook.disposed());
}
`,
      );
      /** Resolves once the plugin's scope has been disposed. */
      const nextDisposal = () =>
        new Promise<void>((resolve) => {
          hook.disposed = resolve;
        });

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          yield* manager.enable(packageId);
          const listed = yield* catalog.list;
          const input = { generation: listed.generation, id: commandId };
          expect(yield* manager.invokeCommand(input)).toMatchObject({ message: "run 1" });

          // Short of the timeout, the package stays active.
          yield* TestClock.adjust(
            Duration.subtract(
              PluginPackageManager.IDLE_TIMEOUT,
              PluginPackageManager.IDLE_CHECK_INTERVAL,
            ),
          );
          yield* manager.rescan;
          expect(hook.activations).toBe(1);
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, state: "active" }],
          });

          const disposed = nextDisposal();
          yield* TestClock.adjust(PluginPackageManager.IDLE_CHECK_INTERVAL);
          yield* Effect.promise(() => disposed);
          // Rescan queues behind the idle shutdown that is disposing the package.
          expect(yield* manager.rescan).toMatchObject({
            packages: [{ id: packageId, enabled: true, state: "idle" }],
          });
          expect(yield* catalog.list).toBe(listed);

          expect(yield* manager.invokeCommand(input)).toMatchObject({ message: "run 2" });
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, state: "active" }],
          });
        }),
      );
    }),
  );

  it.effect("reactivates for a command that arrives while an idle shutdown is disposing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-idle-race-test-",
      });
      const hookSymbol = `t3.test.plugin.idle-race.${baseDir}`;
      let markDisposing!: () => void;
      const disposing = new Promise<void>((resolve) => {
        markDisposing = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const hook = { activations: 0, disposing: markDisposing, released };
      yield* Effect.acquireRelease(
        Effect.sync(() => Reflect.set(globalThis, Symbol.for(hookSymbol), hook)),
        () => Effect.sync(() => Reflect.deleteProperty(globalThis, Symbol.for(hookSymbol))),
      );
      yield* writePackage(
        baseDir,
        packageId,
        commandId,
        `export default function activate(api) {
  const hook = globalThis[Symbol.for(${encodeJsonString(hookSymbol)})];
  hook.activations += 1;
  api.registerCommand("${commandId}", () => ({ message: "run " + hook.activations, tone: "success" }));
  api.onDispose(() => { hook.disposing(); return hook.released; });
}
`,
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          yield* manager.enable(packageId);
          const input = { generation: (yield* catalog.list).generation, id: commandId };

          yield* TestClock.adjust(PluginPackageManager.IDLE_TIMEOUT);
          yield* Effect.promise(() => disposing);
          // The runtime no longer serves the command, but the shutdown has not finished.
          const invoked = yield* Effect.forkChild(manager.invokeCommand(input));
          yield* Effect.yieldNow;
          release();
          expect(yield* Fiber.join(invoked)).toEqual({ message: "run 2", tone: "success" });
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, state: "active" }],
          });
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
          // The palette label is the manifest title.
          expect(listed.commands.find((command) => command.id === commandId)?.label).toBe(
            "Say hello",
          );
          expect(yield* catalog.invoke({ generation: listed.generation, id: commandId })).toEqual({
            message: "External plugin runtime is active.",
            tone: "success",
          });
        }),
      );

      expect(yield* readEnabledIds(baseDir)).toEqual([packageId]);

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;

          // Rescan queues behind the startup load, which leaves the package idle.
          expect(yield* manager.rescan).toMatchObject({
            packages: [{ id: packageId, enabled: true, state: "idle" }],
          });
          const listed = yield* catalog.list;
          expect(listed.commands.map((command) => command.id)).toContain(commandId);
          yield* manager.invokeCommand({ generation: listed.generation, id: commandId });

          expect(yield* manager.disable(packageId)).toMatchObject({
            packages: [{ id: packageId, enabled: false, state: "disabled" }],
          });
          expect((yield* catalog.list).commands.map((command) => command.id)).not.toContain(
            commandId,
          );
        }),
      );

      expect(yield* readEnabledIds(baseDir)).toEqual([]);
      expect(yield* fileSystem.readFileString(`${packageDirectory}/disposed.log`)).toBe(
        "disposed\ndisposed\n",
      );
    }),
  );

  it.effect("fails activation when the manifest requires a capability T3 does not provide", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-capability-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      const activatedFile = `${packageDirectory}/activated.log`;
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest({ ...manifest, requires: ["t3.commands@0", "t3.screens@2"] }),
      );
      yield* fileSystem.writeFileString(
        `${packageDirectory}/index.mjs`,
        `import { appendFileSync } from "node:fs";
appendFileSync(${encodeJsonString(activatedFile)}, "imported\\n");
export default function activate() {}
`,
      );
      const reason =
        "Needs t3.screens@2; this T3 provides t3.commands@0, t3.storage@0. Update T3 or use an older version of the plugin.";

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const failure = yield* Effect.flip(manager.enable(packageId));
          expect(failure.message).toContain(reason);
          expect(yield* manager.status).toMatchObject({
            packages: [
              {
                id: packageId,
                enabled: false,
                state: "error",
                requires: ["t3.commands@0", "t3.screens@2"],
                error: reason,
              },
            ],
          });
        }),
      );

      expect(yield* fileSystem.exists(activatedFile)).toBe(false);
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
        const manager = yield* PluginPackageManager.PluginPackageManager;
        const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
        const listed = yield* catalog.list;
        return (yield* manager.invokeCommand({ generation: listed.generation, id: countCommandId }))
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

      const afterStartup = PluginPackageManager.PluginPackageManager.pipe(
        Effect.flatMap((manager) => manager.rescan),
        Effect.andThen(count),
      );
      expect(yield* useEnvironment(baseDir, afterStartup)).toBe("Invoked 5 times.");
      expect(yield* fileSystem.exists(`${dataDirectory}/storage.sqlite`)).toBe(true);
      expect(yield* fileSystem.exists(`${baseDir}/userdata/state.sqlite`)).toBe(false);
    }),
  );

  it.effect("starts a data countdown when a plugin is removed and clears it on reinstall", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-data-countdown-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      const install = Effect.gen(function* () {
        yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          `${packageDirectory}/t3-plugin.json`,
          encodeManifest(manifest),
        );
        yield* fileSystem.writeFileString(
          `${packageDirectory}/index.mjs`,
          pluginSource(`${baseDir}/disposed.log`),
        );
      });
      yield* install;
      yield* TestClock.setTime(Duration.toMillis(Duration.days(100)));

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          const count = catalog.list.pipe(
            Effect.flatMap((listed) =>
              manager.invokeCommand({ generation: listed.generation, id: countCommandId }),
            ),
            Effect.map((result) => result.message),
          );
          yield* manager.enable(packageId);
          expect(yield* count).toBe("Invoked 1 times.");
          expect(yield* manager.data).toEqual({
            entries: [{ id: packageId, name: "Fixture", installed: true }],
          });

          const removedAt = yield* Clock.currentTimeMillis;
          yield* fileSystem.remove(packageDirectory, { recursive: true });
          yield* manager.rescan;
          expect((yield* readPluginState(baseDir)).missingSince).toEqual({
            [packageId]: removedAt,
          });
          expect(yield* manager.data).toEqual({
            entries: [
              {
                id: packageId,
                installed: false,
                deletesAt: DateTime.formatIso(
                  DateTime.makeUnsafe(
                    removedAt + Duration.toMillis(PluginPackageManager.PLUGIN_DATA_RETENTION),
                  ),
                ),
              },
            ],
          });

          // A later rescan keeps the original start rather than restarting the countdown.
          yield* TestClock.setTime(removedAt + Duration.toMillis(Duration.days(1)));
          yield* manager.rescan;
          expect((yield* readPluginState(baseDir)).missingSince).toEqual({
            [packageId]: removedAt,
          });

          yield* install;
          yield* manager.rescan;
          expect((yield* readPluginState(baseDir)).missingSince).toBeUndefined();
          expect((yield* manager.data).entries).toEqual([
            { id: packageId, name: "Fixture", installed: true },
          ]);
          expect(yield* count).toBe("Invoked 2 times.");
        }),
      );
    }),
  );

  it.effect("deletes leftover data once its countdown has run out", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-data-expiry-test-",
      });
      const now = Duration.toMillis(Duration.days(100));
      const retention = Duration.toMillis(PluginPackageManager.PLUGIN_DATA_RETENTION);
      yield* TestClock.setTime(now);
      for (const id of [
        "com.acme.expired",
        "com.acme.recent",
        "com.acme.broken",
        "com.acme.bare",
      ]) {
        yield* fileSystem.makeDirectory(`${baseDir}/userdata/plugin-data/${id}`, {
          recursive: true,
        });
      }
      // A plugin whose manifest is unreadable or missing is still installed, so its data stays.
      yield* fileSystem.makeDirectory(`${baseDir}/userdata/plugins/com.acme.bare`, {
        recursive: true,
      });
      yield* fileSystem.makeDirectory(`${baseDir}/userdata/plugins/com.acme.broken`, {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        `${baseDir}/userdata/plugins/com.acme.broken/t3-plugin.json`,
        "{ not json",
      );
      yield* fileSystem.writeFileString(
        `${baseDir}/userdata/plugins.json`,
        encodePluginState({
          enabled: [],
          missingSince: {
            "com.acme.expired": now - retention,
            "com.acme.recent": now - retention + 1,
            "com.acme.gone": now - 1,
            "com.acme.broken": now - retention,
            "com.acme.bare": now - retention,
          },
        }),
      );

      yield* useEnvironment(
        baseDir,
        PluginPackageManager.PluginPackageManager.pipe(Effect.flatMap((manager) => manager.rescan)),
      );

      expect(yield* fileSystem.exists(`${baseDir}/userdata/plugin-data/com.acme.expired`)).toBe(
        false,
      );
      expect(yield* fileSystem.exists(`${baseDir}/userdata/plugin-data/com.acme.recent`)).toBe(
        true,
      );
      for (const id of ["com.acme.broken", "com.acme.bare"]) {
        expect(yield* fileSystem.exists(`${baseDir}/userdata/plugin-data/${id}`)).toBe(true);
      }
      // Entries whose folder is gone or whose plugin is back are dropped along with the expired one.
      expect((yield* readPluginState(baseDir)).missingSince).toEqual({
        "com.acme.recent": now - retention + 1,
      });
    }),
  );

  it.effect("measures plugin data on request and deletes only leftovers", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-data-delete-test-",
      });
      yield* writePackage(baseDir, packageId, commandId, "export default () => {};\n");
      const leftover = `${baseDir}/userdata/plugin-data/com.acme.leftover`;
      yield* fileSystem.makeDirectory(`${leftover}/nested`, { recursive: true });
      yield* fileSystem.writeFileString(`${leftover}/nested/notes.txt`, "hello");
      yield* fileSystem.makeDirectory(`${baseDir}/userdata/plugin-data/${packageId}`);

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          yield* manager.rescan;
          expect((yield* manager.data).entries.map((entry) => entry.sizeBytes)).toEqual([
            undefined,
            undefined,
          ]);
          expect(yield* manager.dataSizes).toMatchObject({
            entries: [
              { id: "com.acme.leftover", installed: false, sizeBytes: 5 },
              { id: packageId, installed: true, sizeBytes: 0 },
            ],
          });

          const installed = yield* Effect.exit(manager.deleteData(packageId));
          expect(installed._tag).toBe("Failure");
          expect(yield* fileSystem.exists(`${baseDir}/userdata/plugin-data/${packageId}`)).toBe(
            true,
          );

          expect((yield* manager.deleteData("com.acme.leftover")).entries).toMatchObject([
            { id: packageId },
          ]);
          expect(yield* fileSystem.exists(leftover)).toBe(false);
          expect((yield* readPluginState(baseDir)).missingSince).toBeUndefined();
          const again = yield* Effect.exit(manager.deleteData("com.acme.leftover"));
          expect(again._tag === "Failure" && Cause.squash(again.cause)).toMatchObject({
            _tag: "PluginPackageNotFoundError",
          });
        }),
      );
    }),
  );

  it.effect("deletes a removed plugin's data only after its running command finishes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-data-running-test-",
      });
      const gateSymbol = `t3.test.plugin.data-running.${baseDir}`;
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markStarted!: () => void;
      const commandStarted = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          Reflect.set(globalThis, Symbol.for(gateSymbol), { started: markStarted, released }),
        ),
        () => Effect.sync(() => Reflect.deleteProperty(globalThis, Symbol.for(gateSymbol))),
      );
      const packageDirectory = yield* writePackage(
        baseDir,
        packageId,
        commandId,
        `export default function activate(api) {
  api.registerCommand("${commandId}", async () => {
    const gate = globalThis[Symbol.for(${encodeJsonString(gateSymbol)})];
    gate.started();
    await gate.released;
    await api.storage.set("last", "written after removal");
    return { message: "stored", tone: "success" };
  });
}
`,
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          yield* manager.enable(packageId);
          const listed = yield* catalog.list;
          const invoked = yield* Effect.forkChild(
            manager.invokeCommand({ generation: listed.generation, id: commandId }),
          );
          yield* Effect.promise(() => commandStarted);

          // The rescan retiring the removed plugin holds the lock until the command
          // finishes, so the delete queued behind it never closes a store in use.
          yield* fileSystem.remove(packageDirectory, { recursive: true });
          const rescanned = yield* Effect.forkChild(manager.rescan);
          const deleted = yield* Effect.forkChild(manager.deleteData(packageId));
          release();

          expect(yield* Fiber.join(invoked)).toEqual({ message: "stored", tone: "success" });
          yield* Fiber.join(rescanned);
          expect((yield* Fiber.join(deleted)).entries).toEqual([]);
          expect(yield* fileSystem.exists(`${baseDir}/userdata/plugin-data/${packageId}`)).toBe(
            false,
          );
        }),
      );
    }),
  );

  it.effect("reports display names and inlines package icons", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-display-test-",
      });
      const namedDirectory = `${baseDir}/userdata/plugins/named`;
      const unnamedDirectory = `${baseDir}/userdata/plugins/unnamed`;
      yield* fileSystem.makeDirectory(namedDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(unnamedDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${namedDirectory}/t3-plugin.json`,
        encodeManifest({
          ...manifest,
          name: "Fixture display",
          description: "Says hello.",
          icon: "./icon.svg",
        }),
      );
      yield* fileSystem.writeFileString(`${namedDirectory}/icon.svg`, "<svg/>");
      yield* fileSystem.writeFileString(
        `${unnamedDirectory}/t3-plugin.json`,
        encodeManifest({ ...manifest, id: "com.acme.unnamed", name: "  ", icon: "./missing.svg" }),
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const { packages } = yield* manager.status;
          expect(packages.find((entry) => entry.id === packageId)).toMatchObject({
            name: "Fixture display",
            description: "Says hello.",
            iconUrl: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
          });
          const unnamed = packages.find((entry) => entry.id === "com.acme.unnamed");
          expect(unnamed?.name).toBe("com.acme.unnamed");
          expect(unnamed?.iconUrl).toBeUndefined();
        }),
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
          // The same commands, so clients' catalog generation stays valid.
          expect(yield* catalog.list).toBe(committed);
          expect(
            yield* catalog.invoke({ generation: committed.generation, id: commandId }),
          ).toEqual({
            message: "generation two",
            tone: "success",
          });
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

  it.effect("keeps runtime and persisted enablement aligned when state writes fail", () =>
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
          const enabled = yield* withReadOnlyStateDir(
            fileSystem,
            baseDir,
            Effect.exit(manager.enable(packageId)),
          );
          expect(enabled._tag).toBe("Failure");
          expect((yield* catalog.list).commands.map((command) => command.id)).not.toContain(
            commandId,
          );
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, enabled: false }],
          });
        }),
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
          yield* manager.rescan;
          const disabled = yield* withReadOnlyStateDir(
            fileSystem,
            baseDir,
            Effect.exit(manager.disable(packageId)),
          );
          expect(disabled._tag).toBe("Failure");
          expect((yield* catalog.list).commands.map((command) => command.id)).toContain(commandId);
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, enabled: true, state: "idle" }],
          });
        }),
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
          // Interrupting waits for the disable to finish its bookkeeping.
          yield* Fiber.join(interrupting);
          expect(yield* fileSystem.exists(`${baseDir}/userdata/plugin-cache/${packageId}/0`)).toBe(
            false,
          );
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
      expect(yield* readEnabledIds(baseDir)).toEqual([]);
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
      encodeManifest({
        ...manifest,
        id,
        contributes: { commands: [{ id: command, title: "Test command" }] },
      }),
    );
    yield* fileSystem.writeFileString(`${packageDirectory}/index.mjs`, source);
    return packageDirectory;
  });

const commandPluginSource = (handlerSource: string, disposalFile: string) => `
import { appendFile } from "node:fs/promises";

export default function activate(api) {
  api.registerCommand("${commandId}", ${handlerSource}
  );
  api.onDispose(() => appendFile(${encodeJsonString(disposalFile)}, "disposed\\n"));
}
`;

const healthySource = `
export default function activate(api) {
  api.registerCommand("${healthyCommandId}", () => ({ message: "still healthy", tone: "success" })
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

const entryPointTimeout = Duration.millis(50);
const expectedMessage = (outcome: string) =>
  outcome === "timed out" ? "did not finish within 50ms" : "boom";

/**
 * A global hook plugin code calls as it enters the entry point under test, so the
 * test advances the clock past the entry point timeout only once it is armed.
 */
const startedHook = (baseDir: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const symbol = `t3.test.plugin.started.${baseDir}`;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      Reflect.set(globalThis, Symbol.for(symbol), markStarted);
      const call = `Reflect.get(globalThis, Symbol.for(${encodeJsonString(symbol)}))();`;
      return { call, started, symbol };
    }),
    ({ symbol }) => Effect.sync(() => Reflect.deleteProperty(globalThis, Symbol.for(symbol))),
  );

/**
 * Runs `effect` and completes with its own result. For an entry point that times
 * out, first lets the entry point timeout elapse once plugin code has started.
 * Other outcomes leave the clock alone, so it cannot time out the cleanup that
 * follows a failure.
 */
const runPastTimeout = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  started: Promise<void>,
  outcome: string = "timed out",
) =>
  Effect.gen(function* () {
    if (outcome !== "timed out") return yield* effect;
    const fiber = yield* Effect.forkChild(effect);
    yield* Effect.promise(() => started);
    yield* TestClock.adjust(entryPointTimeout);
    return yield* Fiber.join(fiber);
  });

/** A command that blocks on a shared gate the first time, so a test can fail it later. */
const gatedCommandSource = (gateSymbol: string, onLoad = "") => `
const gate = globalThis[Symbol.for(${encodeJsonString(gateSymbol)})];
gate.loads += 1;
${onLoad}
export default function activate(api) {
  api.registerCommand("${commandId}", () => gate.calls++ === 0
      ? new Promise((_, reject) => { gate.reject = reject; gate.started(); })
      : { message: "reloaded", tone: "success" }
  );
}
`;

const makeGate = (gateSymbol: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
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
      return { gate, started };
    }),
    () => Effect.sync(() => Reflect.deleteProperty(globalThis, Symbol.for(gateSymbol))),
  );

it.layer(NodeServices.layer)("plugin failure containment", (it) => {
  for (const { outcome, activate } of failureCases) {
    it.effect(`marks only the plugin whose activate ${outcome} as failed`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-plugin-activate-failure-test-",
        });
        const hook = yield* startedHook(baseDir);
        yield* writePackage(
          baseDir,
          packageId,
          commandId,
          `export default function activate() { ${hook.call} ${activate} }`,
        );
        yield* writePackage(baseDir, healthyPackageId, healthyCommandId, healthySource);

        yield* useEnvironment(
          baseDir,
          Effect.gen(function* () {
            const manager = yield* PluginPackageManager.PluginPackageManager;
            const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
            yield* manager.enable(healthyPackageId);
            const enabled = yield* Effect.exit(
              runPastTimeout(manager.enable(packageId), hook.started, outcome),
            );
            expect(enabled._tag).toBe("Failure");

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
          { entryPointTimeout },
        );
      }),
    );
  }

  it.effect("fails the command that triggers a failing activation and keeps the reason", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-lazy-activation-failure-test-",
      });
      yield* writePackage(
        baseDir,
        packageId,
        commandId,
        "export default function activate() { throw new Error('boom') }",
      );
      yield* writePackage(baseDir, healthyPackageId, healthyCommandId, healthySource);
      yield* fileSystem.writeFileString(
        `${baseDir}/userdata/plugins.json`,
        `{"enabled":["${healthyPackageId}","${packageId}"]}\n`,
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          yield* manager.rescan;
          const listed = yield* catalog.list;
          const failure = yield* Effect.flip(
            manager.invokeCommand({ generation: listed.generation, id: commandId }),
          );
          expect(failure._tag).toBe("PluginCommandInvocationError");
          const encoded = encodeInvocationError(failure);
          expect(encoded).toContain("activate threw: boom");
          expect(encoded).not.toContain("index.mjs");

          expect((yield* manager.status).packages).toMatchObject([
            { id: healthyPackageId, state: "idle" },
            { id: packageId, enabled: true, state: "error", error: "activate threw: boom" },
          ]);
          const after = yield* catalog.list;
          expect(after.commands.map((command) => command.id)).toEqual([healthyCommandId]);
          expect(
            yield* manager.invokeCommand({ generation: after.generation, id: healthyCommandId }),
          ).toEqual({ message: "still healthy", tone: "success" });
        }),
      );
    }),
  );

  for (const { outcome, handler } of failureCases) {
    it.effect(`retires the plugin whose command ${outcome} and keeps the reason`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-plugin-command-failure-test-",
        });
        const hook = yield* startedHook(baseDir);
        const disposalFile = `${baseDir}/disposed.log`;
        yield* writePackage(
          baseDir,
          packageId,
          commandId,
          commandPluginSource(`() => { ${hook.call} return (${handler})(); }`, disposalFile),
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
              runPastTimeout(
                manager.invokeCommand({ generation: listed.generation, id: commandId }),
                hook.started,
                outcome,
              ),
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

            // A rescan does not bring the unchanged package back; Reload does.
            expect((yield* manager.rescan).packages).toMatchObject([
              { id: healthyPackageId, state: "active" },
              { id: packageId, state: "error", error: reason },
            ]);
            expect((yield* manager.reload(packageId)).packages).toMatchObject([
              { id: healthyPackageId, state: "active" },
              { id: packageId, state: "active" },
            ]);
          }),
          { entryPointTimeout },
        );
      }),
    );
  }

  it.effect("fails a package whose import does not finish within the entry point timeout", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-import-timeout-test-",
      });
      const hook = yield* startedHook(baseDir);
      // Top-level code that never settles.
      yield* writePackage(
        baseDir,
        packageId,
        commandId,
        `${hook.call}\nawait new Promise(() => {});\nexport default function activate() {}\n`,
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const failure = yield* Effect.flip(
            runPastTimeout(manager.enable(packageId), hook.started),
          );
          const reason = "import timed out: did not finish within 50ms";
          expect(failure.message).toContain(reason);
          expect((yield* manager.status).packages).toMatchObject([
            { id: packageId, enabled: false, state: "error", error: reason },
          ]);
        }),
        { entryPointTimeout },
      );
    }),
  );

  it.effect("answers other plugins' commands while a failed plugin waits to be retired", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-pending-retirement-test-",
      });
      const slowPackageId = "com.acme.slow";
      const hook = yield* startedHook(baseDir);
      const releaseSymbol = `t3.test.plugin.pending-retirement.release.${baseDir}`;
      const releaseSlow = Effect.sync(() => {
        const release = Reflect.get(globalThis, Symbol.for(releaseSymbol));
        if (typeof release === "function") release();
      });
      yield* Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => Reflect.deleteProperty(globalThis, Symbol.for(releaseSymbol))),
      );
      yield* writePackage(
        baseDir,
        packageId,
        commandId,
        commandPluginSource("() => { throw new Error('boom') }", `${baseDir}/disposed.log`),
      );
      yield* writePackage(baseDir, healthyPackageId, healthyCommandId, healthySource);
      // Activation holds the manager lock until the test releases it.
      yield* writePackage(
        baseDir,
        slowPackageId,
        "acme.slow",
        `export default async function activate() {
  ${hook.call}
  await new Promise((resolve) => Reflect.set(globalThis, Symbol.for(${encodeJsonString(releaseSymbol)}), resolve));
}
`,
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          yield* manager.enable(healthyPackageId);
          yield* manager.enable(packageId);
          const listed = yield* catalog.list;

          const enablingSlow = yield* Effect.forkChild(manager.enable(slowPackageId));
          yield* Effect.promise(() => hook.started);
          // The failed command's retirement waits for the lock the slow enable holds.
          const failing = yield* Effect.forkChild(
            manager.invokeCommand({ generation: listed.generation, id: commandId }),
          );
          expect((yield* manager.status).packages).toMatchObject([
            { id: healthyPackageId, state: "active" },
            { id: slowPackageId, state: "idle" },
            { id: packageId, state: "error" },
          ]);
          expect(
            yield* manager.invokeCommand({ generation: listed.generation, id: healthyCommandId }),
          ).toEqual({ message: "still healthy", tone: "success" });

          yield* releaseSlow;
          yield* Fiber.join(enablingSlow);
          expect((yield* Fiber.await(failing))._tag).toBe("Failure");
          expect((yield* catalog.list).commands.map((command) => command.id)).not.toContain(
            commandId,
          );
        }).pipe(Effect.ensuring(releaseSlow)),
      );
    }),
  );

  it.effect("drops a retired plugin from status once its folder is removed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-retired-removal-test-",
      });
      const packageDirectory = yield* writePackage(
        baseDir,
        packageId,
        commandId,
        commandPluginSource("() => { throw new Error('boom') }", `${baseDir}/disposed.log`),
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          yield* manager.enable(packageId);
          const listed = yield* catalog.list;
          yield* Effect.exit(
            manager.invokeCommand({ generation: listed.generation, id: commandId }),
          );
          expect((yield* manager.status).packages).toMatchObject([
            { id: packageId, state: "error" },
          ]);

          yield* fileSystem.remove(packageDirectory, { recursive: true });
          const removed = yield* manager.rescan;
          expect(removed.packages).toEqual([]);
          expect(removed.errors).toContainEqual({ directory: packageId, error: "Not installed" });
        }),
      );
    }),
  );

  it.effect("keeps a reload active when the previous version's command fails during it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-reload-race-test-",
      });
      const gateSymbol = `t3.test.plugin.reload-race.${baseDir}`;
      const { started } = yield* makeGate(gateSymbol);
      // The first call blocks; importing the reloaded version rejects it mid-reload.
      yield* writePackage(
        baseDir,
        packageId,
        commandId,
        gatedCommandSource(gateSymbol, 'if (gate.loads === 2) gate.reject(new Error("late"));'),
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
    }),
  );

  it.effect(
    "retires the previous version after its running command fails, keeping the reload",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-plugin-late-failure-test-",
        });
        const gateSymbol = `t3.test.plugin.late-failure.${baseDir}`;
        const { gate, started } = yield* makeGate(gateSymbol);
        yield* writePackage(baseDir, packageId, commandId, gatedCommandSource(gateSymbol));

        yield* useEnvironment(
          baseDir,
          Effect.gen(function* () {
            const manager = yield* PluginPackageManager.PluginPackageManager;
            const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
            yield* manager.enable(packageId);
            const invoking = yield* Effect.forkChild(
              manager.invokeCommand({
                generation: (yield* catalog.list).generation,
                id: commandId,
              }),
            );
            yield* Effect.promise(() => started);

            // Status does not wait for the slow command. A reload does: it disposes the
            // previous version only once the command running on it finishes.
            expect((yield* manager.status).packages).toMatchObject([
              { id: packageId, state: "active" },
            ]);
            const reloading = yield* Effect.forkChild(manager.reload(packageId));
            yield* Effect.yieldNow;
            gate.reject(new Error("late"));
            expect((yield* Fiber.await(invoking))._tag).toBe("Failure");
            yield* Fiber.join(reloading);

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
              { ...manifest, id: "com.acme.other", requires: [], contributes: {} },
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

          // Reinstalling brings the still-enabled package back, idle until a command runs.
          yield* install(`${baseDir}/sources/v2`);
          expect(yield* manager.rescan).toMatchObject({
            packages: [{ id: "com.acme.other" }, { id: packageId, state: "idle" }],
          });
        }),
      );
    }),
  );

  it.effect("reloads in-place code edits and retries failed loads on rescan", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-edit-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      const failSymbol = `t3.test.plugin.edit.fail.${baseDir}`;
      let editTime = 1_767_225_600; // seconds, as utimes expects for numbers
      // Edits a nested module in place; mtimes are set explicitly so the test never races the clock.
      const writeMessage = Effect.fn(function* (message: string) {
        const file = `${packageDirectory}/message.mjs`;
        yield* fileSystem.writeFileString(
          file,
          `if (Reflect.get(globalThis, Symbol.for(${encodeJsonString(failSymbol)}))) throw new Error("not ready");\nexport const message = ${encodeJsonString(message)};\n`,
        );
        editTime += 60;
        yield* fileSystem.utimes(file, editTime, editTime);
      });
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest(manifest),
      );
      yield* fileSystem.writeFileString(`${packageDirectory}/index.mjs`, pluginSourceWithHelper);
      yield* writeMessage("one");
      // Whole-second times, so a timestamp-preserving copy below matches exactly.
      for (const entry of ["t3-plugin.json", "index.mjs", ""]) {
        yield* fileSystem.utimes(`${packageDirectory}/${entry}`, editTime, editTime);
      }

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
          expect(yield* invoke).toMatchObject({ message: "one" });

          yield* writeMessage("two");
          yield* manager.rescan;
          expect(yield* invoke).toMatchObject({ message: "two" });

          // A failed load keeps the previous code. Rescans do not re-import the
          // unchanged folder (each import stays in memory); Reload tries again.
          Reflect.set(globalThis, Symbol.for(failSymbol), true);
          yield* writeMessage("three");
          yield* manager.rescan;
          expect(yield* invoke).toMatchObject({ message: "two" });
          Reflect.deleteProperty(globalThis, Symbol.for(failSymbol));
          yield* manager.rescan;
          expect(yield* invoke).toMatchObject({ message: "two" });
          yield* manager.reload(packageId);
          expect(yield* invoke).toMatchObject({ message: "three" });

          // A replacement that keeps every size and timestamp, as `cp -a` would.
          const replacement = `${baseDir}/replacement`;
          yield* fileSystem.copy(packageDirectory, replacement);
          const messageSource = yield* fileSystem.readFileString(`${packageDirectory}/message.mjs`);
          yield* fileSystem.writeFileString(
            `${replacement}/message.mjs`,
            messageSource.replace('"three"', '"seven"'),
          );
          for (const entry of ["t3-plugin.json", "index.mjs", "message.mjs", ""]) {
            const original = yield* fileSystem.stat(`${packageDirectory}/${entry}`);
            const mtime = Option.getOrThrow(original.mtime);
            yield* fileSystem.utimes(`${replacement}/${entry}`, mtime, mtime);
          }
          yield* fileSystem.remove(packageDirectory, { recursive: true });
          yield* fileSystem.rename(replacement, packageDirectory);
          yield* manager.rescan;
          expect(yield* invoke).toMatchObject({ message: "seven" });
        }),
      );
    }),
  );

  it.effect("clears a failed update's error once the folder is back to the live version", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-restore-test-",
      });
      const packageDirectory = yield* writePackage(
        baseDir,
        packageId,
        commandId,
        pluginSourceWithHelper,
      );
      const liveTime = 1_767_225_600;
      // Edits in place with explicit mtimes, so restoring the file restores the fingerprint.
      const writeMessage = Effect.fn(function* (source: string, time: number) {
        yield* fileSystem.writeFileString(`${packageDirectory}/message.mjs`, source);
        yield* fileSystem.utimes(`${packageDirectory}/message.mjs`, time, time);
      });
      const liveSource = 'export const message = "live";\n';
      yield* writeMessage(liveSource, liveTime);

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

          yield* writeMessage('throw new Error("broken update");\n', liveTime + 60);
          expect((yield* manager.rescan).packages).toMatchObject([
            { id: packageId, state: "error" },
          ]);
          expect(yield* invoke).toMatchObject({ message: "live" });

          yield* writeMessage(liveSource, liveTime);
          const restored = yield* manager.rescan;
          expect(restored.packages).toMatchObject([{ id: packageId, state: "active" }]);
          expect(restored.packages[0]?.error).toBeUndefined();
          expect(yield* invoke).toMatchObject({ message: "live" });
        }),
      );
    }),
  );

  it.effect("does not record an interrupted reload as a failed load", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-interrupted-reload-test-",
      });
      const gateSymbol = `t3.test.plugin.interrupted-reload.${baseDir}`;
      const { gate, started } = yield* makeGate(gateSymbol);
      const packageDirectory = yield* writePackage(
        baseDir,
        packageId,
        commandId,
        commandPluginSource(
          '() => ({ message: "one", tone: "success" })',
          `${baseDir}/disposed.log`,
        ),
      );

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

          // The first activation of the update blocks until the reload is interrupted.
          yield* fileSystem.writeFileString(
            `${packageDirectory}/index.mjs`,
            `const gate = globalThis[Symbol.for(${encodeJsonString(gateSymbol)})];
export default async function activate(api) {
  if (gate.calls++ === 0) {
    gate.started();
    await new Promise(() => {});
  }
  api.registerCommand("${commandId}", () => ({ message: "two", tone: "success" })
  );
}
`,
          );
          const reloading = yield* Effect.forkChild(manager.reload(packageId));
          yield* Effect.promise(() => started);
          yield* Fiber.interrupt(reloading);

          const status = yield* manager.status;
          expect(status.packages).toMatchObject([{ id: packageId, state: "active" }]);
          expect(status.packages[0]?.error).toBeUndefined();
          expect(yield* invoke).toMatchObject({ message: "one" });

          // A rescan still picks up the changed folder.
          yield* manager.rescan;
          expect(gate.calls).toBe(2);
          expect(yield* invoke).toMatchObject({ message: "two" });
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
        Effect.void,
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

  it.effect("re-establishes a lost watch with a backoff and catches up with a rescan", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<string>();
      const subscriptions = yield* Queue.unbounded<number>();
      const prepares = yield* Queue.unbounded<number>();
      const rescans = yield* Queue.unbounded<number>();
      let subscribed = 0;
      let prepared = 0;
      let rescanned = 0;
      // The folder is gone for the first two attempts, then comes back.
      const watch = Stream.unwrap(
        Effect.suspend(() => {
          const attempt = ++subscribed;
          return Queue.offer(subscriptions, attempt).pipe(Effect.as(attempt));
        }).pipe(
          Effect.map((attempt) =>
            attempt <= 2 ? Stream.fail("plugins/ deleted") : Stream.fromQueue(events),
          ),
        ),
      );
      yield* PluginPackageManager.watchPluginsDirectory(
        watch,
        Effect.suspend(() => Queue.offer(prepares, ++prepared)),
        Effect.suspend(() => Queue.offer(rescans, ++rescanned)),
      ).pipe(Effect.forkScoped);

      // The first loss re-prepares at once; the next attempt waits for the backoff.
      expect(yield* Queue.take(subscriptions)).toBe(1);
      expect(yield* Queue.take(prepares)).toBe(1);
      expect(yield* Queue.take(subscriptions)).toBe(2);
      yield* TestClock.adjust(
        Duration.subtract(PluginPackageManager.WATCH_DEBOUNCE, Duration.millis(1)),
      );
      expect(yield* Queue.size(prepares)).toBe(0);
      yield* TestClock.adjust("1 millis");
      expect(yield* Queue.take(prepares)).toBe(2);
      expect(yield* Queue.take(subscriptions)).toBe(3);
      // Ignore catch-up rescans from the attempts that failed.
      yield* Queue.clear(rescans);

      // The restored watch rescans once for anything missed, then follows events again.
      yield* TestClock.adjust(PluginPackageManager.WATCH_DEBOUNCE);
      yield* Queue.take(rescans);
      expect(yield* Queue.size(rescans)).toBe(0);
      yield* Queue.offer(events, "a");
      yield* Effect.yieldNow;
      yield* TestClock.adjust(PluginPackageManager.WATCH_DEBOUNCE);
      yield* Queue.take(rescans);
      expect(yield* Queue.size(rescans)).toBe(0);
    }),
  );

  it.effect("re-establishes a silently lost watch when the parent reports plugins/", () =>
    Effect.gen(function* () {
      const parentEvents = yield* Queue.unbounded<string>();
      const subscriptions = yield* Queue.unbounded<number>();
      const rescans = yield* Queue.unbounded<number>();
      let subscribed = 0;
      let rescanned = 0;
      let replaced = false;
      // The plugins/ watch itself never reports anything, as when it stays attached
      // to a deleted folder; only the parent directory sees the change.
      const watch = Stream.unwrap(
        Effect.suspend(() => Queue.offer(subscriptions, ++subscribed)).pipe(
          Effect.as(
            PluginPackageManager.untilPluginsDirectoryReplaced(
              Stream.never,
              Stream.fromQueue(parentEvents),
              Effect.sync(() => replaced),
            ),
          ),
        ),
      );
      yield* PluginPackageManager.watchPluginsDirectory(
        watch,
        Effect.sync(() => {
          replaced = false;
        }),
        Effect.suspend(() => Queue.offer(rescans, ++rescanned)),
      ).pipe(Effect.forkScoped);
      expect(yield* Queue.take(subscriptions)).toBe(1);

      // A parent event for an unchanged plugins/ is an ordinary change.
      yield* Queue.offer(parentEvents, "plugins");
      yield* Effect.yieldNow;
      yield* TestClock.adjust(PluginPackageManager.WATCH_DEBOUNCE);
      expect(yield* Queue.take(rescans)).toBe(1);
      expect(yield* Queue.size(subscriptions)).toBe(0);

      // Once plugins/ was replaced, the next parent event re-establishes the watch.
      replaced = true;
      yield* Queue.offer(parentEvents, "plugins");
      expect(yield* Queue.take(subscriptions)).toBe(2);
      yield* TestClock.adjust(PluginPackageManager.WATCH_DEBOUNCE);
      expect(yield* Queue.take(rescans)).toBe(2);
    }),
  );

  it.effect("restarts the backoff after a watch that stayed up", () =>
    Effect.gen(function* () {
      const healthy = yield* Queue.unbounded<string, string>();
      const subscriptions = yield* Queue.unbounded<number>();
      let subscribed = 0;
      // Three quick losses grow the backoff, the fourth watch stays up, then losses resume.
      const watch = Stream.unwrap(
        Effect.suspend(() => {
          const attempt = ++subscribed;
          return Queue.offer(subscriptions, attempt).pipe(Effect.as(attempt));
        }).pipe(
          Effect.map((attempt) =>
            attempt === 4
              ? Stream.fromQueue(healthy)
              : attempt >= 6
                ? Stream.never
                : Stream.fail("plugins/ deleted"),
          ),
        ),
      );
      yield* PluginPackageManager.watchPluginsDirectory(watch, Effect.void, Effect.void).pipe(
        Effect.forkScoped,
      );

      expect(yield* Queue.take(subscriptions)).toBe(1);
      expect(yield* Queue.take(subscriptions)).toBe(2);
      yield* TestClock.adjust("250 millis");
      expect(yield* Queue.take(subscriptions)).toBe(3);
      yield* TestClock.adjust("500 millis");
      expect(yield* Queue.take(subscriptions)).toBe(4);

      // Lost after staying up, the watch comes back at once, and the next loss waits
      // the shortest backoff again instead of the 1s the earlier losses had reached.
      yield* TestClock.adjust(PluginPackageManager.WATCH_HEALTHY_AFTER);
      yield* Queue.fail(healthy, "plugins/ deleted");
      expect(yield* Queue.take(subscriptions)).toBe(5);
      yield* TestClock.adjust("249 millis");
      expect(yield* Queue.size(subscriptions)).toBe(0);
      yield* TestClock.adjust("1 millis");
      expect(yield* Queue.take(subscriptions)).toBe(6);
    }),
  );
});

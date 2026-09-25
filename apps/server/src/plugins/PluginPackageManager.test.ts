import * as NodeServices from "@effect/platform-node/NodeServices";
import { PluginCommandInvocationError } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
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
const decodePluginState = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ enabled: Schema.Array(Schema.String) })),
);
const readEnabledIds = (baseDir: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(`${baseDir}/userdata/plugins.json`)),
    Effect.map((contents) => decodePluginState(contents).enabled),
  );
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
  api.registerCommand(
    {
      id: "${commandId}",
      description: "Report status from an external local plugin package.",
      surfaces: ["web", "desktop", "mobile"]
    },
    () => ({ message: ${encodeJsonString(message)}, tone: "success" })
  );
  api.registerCommand(
    {
      id: "${countCommandId}",
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
      surfaces: ["web", "desktop", "mobile"]
    },
    () => ({ message: "cleanup failure", tone: "success" })
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
    PluginPackageManager.PluginPackageManager | PluginCommandCatalog.PluginCommandCatalog
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

  it.effect("serves status and commands before a slow startup activation finishes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-slow-startup-test-",
      });
      const gateSymbol = `t3.test.plugin.slow-startup.${baseDir}`;
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      yield* Effect.acquireRelease(
        Effect.sync(() => Reflect.set(globalThis, Symbol.for(gateSymbol), released)),
        () => Effect.sync(() => Reflect.deleteProperty(globalThis, Symbol.for(gateSymbol))),
      );
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest(manifest),
      );
      yield* fileSystem.writeFileString(
        `${packageDirectory}/index.mjs`,
        `export default async function activate(api) {
  await globalThis[Symbol.for(${encodeJsonString(gateSymbol)})];
  api.registerCommand(
    { id: "${commandId}", surfaces: ["web", "desktop", "mobile"] },
    () => ({ message: "ready", tone: "success" })
  );
}
`,
      );
      yield* fileSystem.writeFileString(
        `${baseDir}/userdata/plugins.json`,
        `{"enabled":["${packageId}"]}\n`,
      );

      // The environment comes up while activation is still waiting on the gate.
      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          const status = yield* manager.status;
          expect(status.packages).toMatchObject([{ id: packageId, enabled: true, state: "idle" }]);
          expect(status.packages[0]?.error).toBeUndefined();
          const listed = yield* catalog.list;
          expect(listed.commands.map((command) => command.id)).not.toContain(commandId);
          expect(
            yield* manager.invokeCommand({
              generation: listed.generation,
              id: "t3.plugin-runtime.status",
            }),
          ).toMatchObject({ tone: "success" });

          release();
          expect(yield* manager.rescan).toMatchObject({
            packages: [{ id: packageId, enabled: true, state: "active" }],
          });
          expect((yield* catalog.list).commands.map((command) => command.id)).toContain(commandId);
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

          // Rescan queues behind startup activation, so it returns once that finished.
          expect(yield* manager.rescan).toMatchObject({
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

      const afterStartup = PluginPackageManager.PluginPackageManager.pipe(
        Effect.flatMap((manager) => manager.rescan),
        Effect.andThen(count),
      );
      expect(yield* useEnvironment(baseDir, afterStartup)).toBe("Invoked 5 times.");
      expect(yield* fileSystem.exists(`${dataDirectory}/storage.sqlite`)).toBe(true);
      expect(yield* fileSystem.exists(`${baseDir}/userdata/state.sqlite`)).toBe(false);
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
            packages: [{ id: packageId, enabled: true, state: "active" }],
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
  api.registerCommand(
    { id: "${commandId}", surfaces: ["web", "desktop", "mobile"] },
    ${handlerSource}
  );
  api.onDispose(() => appendFile(${encodeJsonString(disposalFile)}, "disposed\\n"));
}
`;

const healthySource = `
export default function activate(api) {
  api.registerCommand(
    { id: "${healthyCommandId}", surfaces: ["web", "desktop", "mobile"] },
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

/** Runs `effect` until plugin code has started, then lets the entry point timeout elapse. */
const runPastTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>, started: Promise<void>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.exit(effect));
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
  api.registerCommand(
    { id: "${commandId}", surfaces: ["web", "desktop", "mobile"] },
    () => gate.calls++ === 0
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
            const enabled = yield* runPastTimeout(manager.enable(packageId), hook.started);
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
              yield* runPastTimeout(
                manager.invokeCommand({ generation: listed.generation, id: commandId }),
                hook.started,
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

  it.effect("ignores a failure from the previous version's command after a reload", () =>
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
            manager.invokeCommand({ generation: (yield* catalog.list).generation, id: commandId }),
          );
          yield* Effect.promise(() => started);

          // Neither status nor a reload waits for the slow command.
          expect((yield* manager.status).packages).toMatchObject([
            { id: packageId, state: "active" },
          ]);
          yield* manager.reload(packageId);
          gate.reject(new Error("late"));
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

          // Reinstalling brings the still-enabled package back.
          yield* install(`${baseDir}/sources/v2`);
          expect(yield* manager.rescan).toMatchObject({
            packages: [{ id: "com.acme.other" }, { id: packageId, state: "active" }],
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
});

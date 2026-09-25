import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import * as PluginRuntime from "../src/runtime.ts";
import type { PluginDefinition, PluginRuntimeSnapshot } from "../src/contract.ts";

describe("plugin runtime live contributions", () => {
  it.effect("invokes the handler from the listed committed generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* PluginRuntime.make();
        yield* runtime.reconcile([
          {
            id: "acme.commands",
            version: "1.0.0",
            activate(context) {
              context.register(
                "commands",
                {
                  id: "acme.hello",
                  label: "Say hello",
                  data: { surfaces: ["web", "desktop", "mobile"] },
                },
                (name: string) => Effect.succeed(`hello ${name}`),
              );
            },
          },
        ]);

        const catalog = yield* runtime.contributions("commands");
        expect(catalog.generation).toBe(1);
        expect(catalog.entries).toEqual([
          {
            id: "acme.hello",
            label: "Say hello",
            data: { surfaces: ["web", "desktop", "mobile"] },
          },
        ]);
        expect(Object.isFrozen(catalog.entries[0]?.data)).toBe(true);

        const greeting = yield* runtime.useContribution(
          "commands",
          "acme.hello",
          catalog.generation,
          (handler: (name: string) => Effect.Effect<string>) => handler("t3"),
        );
        expect(greeting).toBe("hello t3");
      }),
    ),
  );

  it.effect("rejects invocation from a stale catalog generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* PluginRuntime.make();
        const definition = (version: string) => ({
          id: "acme.commands",
          version,
          activate(
            context: Parameters<Parameters<typeof runtime.reconcile>[0][number]["activate"]>[0],
          ) {
            context.register("commands", { id: "acme.hello", label: `Say hello ${version}` }, () =>
              Effect.succeed(version),
            );
          },
        });

        yield* runtime.reconcile([definition("1.0.0")]);
        const firstCatalog = yield* runtime.contributions("commands");
        yield* runtime.reconcile([definition("2.0.0")]);

        const staleExit = yield* Effect.exit(
          runtime.useContribution(
            "commands",
            "acme.hello",
            firstCatalog.generation,
            (handler: () => Effect.Effect<string>) => handler(),
          ),
        );
        expect(Exit.isFailure(staleExit)).toBe(true);
        if (Exit.isFailure(staleExit)) {
          expect(Cause.squash(staleExit.cause)).toMatchObject({
            _tag: "PluginContributionGenerationError",
            actual: 2,
            expected: 1,
          });
        }
      }),
    ),
  );

  it.effect("rejects duplicate contribution ids before publishing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* PluginRuntime.make();
        const plugin = (id: string, label: string) => ({
          id,
          version: "1.0.0",
          activate(
            context: Parameters<Parameters<typeof runtime.reconcile>[0][number]["activate"]>[0],
          ) {
            context.register("commands", { id: "acme.duplicate", label }, () => Effect.void);
          },
        });

        const reconcileExit = yield* Effect.exit(
          runtime.reconcile([
            plugin("acme.first", "First command"),
            plugin("acme.second", "Second command"),
          ]),
        );
        expect(Exit.isFailure(reconcileExit)).toBe(true);
        if (Exit.isFailure(reconcileExit)) {
          expect(Cause.squash(reconcileExit.cause)).toMatchObject({
            _tag: "PluginDuplicateContributionError",
            id: "acme.duplicate",
            slot: "commands",
          });
        }
        expect((yield* runtime.contributions("commands")).entries).toEqual([]);
      }),
    ),
  );

  it.effect("rejects runtime reentrancy from a contribution handler", () =>
    Effect.gen(function* () {
      const runtime = yield* PluginRuntime.make();
      const definition: PluginDefinition = {
        id: "acme.commands",
        version: "1.0.0",
        activate(context) {
          context.register("commands", { id: "status", label: "Status" }, () =>
            runtime.reconcile([]),
          );
        },
      };
      yield* runtime.reconcile([definition]);
      const catalog = yield* runtime.contributions("commands");

      const result = yield* runtime
        .useContribution<
          () => ReturnType<typeof runtime.reconcile>,
          PluginRuntimeSnapshot,
          PluginRuntime.PluginRuntimeReconcileError,
          never
        >("commands", "status", catalog.generation, (handler) => handler())
        .pipe(Effect.exit);

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const error = Cause.squash(result.cause);
        expect(error).toMatchObject({
          _tag: "PluginRuntimeReentrancyError",
          callback: "contribution",
          operation: "reconcile",
        });
      }
    }),
  );

  it.effect("rejects contribution reentrancy through a fresh effect runtime", () =>
    Effect.gen(function* () {
      const runtime = yield* PluginRuntime.make();
      const definition: PluginDefinition = {
        id: "acme.commands",
        version: "1.0.0",
        activate(context) {
          context.register(
            "commands",
            { id: "status", label: "Status" },
            Effect.promise(() =>
              // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- the regression is specifically a fresh-runtime bridge from plugin code
              Effect.runPromiseExit(runtime.reconcile([])),
            ),
          );
        },
      };
      yield* runtime.reconcile([definition]);
      const catalog = yield* runtime.contributions("commands");

      const nested = yield* runtime.useContribution(
        "commands",
        "status",
        catalog.generation,
        (
          handler: Effect.Effect<
            Exit.Exit<PluginRuntimeSnapshot, PluginRuntime.PluginRuntimeReconcileError>
          >,
        ) => handler,
      );

      expect(Exit.isFailure(nested)).toBe(true);
      if (Exit.isFailure(nested)) {
        expect(Cause.squash(nested.cause)).toMatchObject({
          _tag: "PluginRuntimeReentrancyError",
          callback: "contribution",
          operation: "reconcile",
        });
      }
    }),
  );

  it.effect("installs contribution context before calling the host consumer", () =>
    Effect.gen(function* () {
      const runtime = yield* PluginRuntime.make();
      const definition: PluginDefinition = {
        id: "acme.commands",
        version: "1.0.0",
        activate(context) {
          context.register("commands", { id: "status", label: "Status" }, Effect.void);
        },
      };
      yield* runtime.reconcile([definition]);
      const catalog = yield* runtime.contributions("commands");

      const nested = yield* runtime.useContribution(
        "commands",
        "status",
        catalog.generation,
        () => {
          // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- verifies context before the host callback returns its Effect
          const pending = Effect.runPromiseExit(runtime.reconcile([]));
          return Effect.promise(() => pending);
        },
      );

      expect(Exit.isFailure(nested)).toBe(true);
      if (Exit.isFailure(nested)) {
        expect(Cause.squash(nested.cause)).toMatchObject({
          _tag: "PluginRuntimeReentrancyError",
          callback: "contribution",
          operation: "reconcile",
        });
      }
    }),
  );

  it.effect("runs contributions outside the transition lock", () =>
    Effect.gen(function* () {
      const runtime = yield* PluginRuntime.make();
      const release = yield* Deferred.make<void>();
      // A promise, not a Deferred: a fiber woken from inside the contribution would inherit its
      // callback context and be treated as reentrant.
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const definition = (version: string): PluginDefinition => ({
        id: "acme.commands",
        version,
        activate(context) {
          context.register(
            "commands",
            { id: "slow", label: "Slow" },
            Effect.sync(() => markStarted()).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(version),
            ),
          );
          context.register("commands", { id: "fast", label: "Fast" }, Effect.succeed(version));
        },
      });
      yield* runtime.reconcile([definition("1.0.0")]);
      const first = yield* runtime.contributions("commands");
      const use = (id: string, generation: number) =>
        runtime.useContribution(
          "commands",
          id,
          generation,
          (handler: Effect.Effect<string>) => handler,
        );

      const slow = yield* Effect.forkChild(use("slow", first.generation));
      yield* Effect.promise(() => started);
      // Another invocation does not wait for the running one.
      expect(yield* use("fast", first.generation)).toBe("1.0.0");
      // A reconcile retiring the version finishes once the running invocation does.
      const reconciling = yield* Effect.forkChild(runtime.reconcile([definition("2.0.0")]));
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(slow)).toBe("1.0.0");
      yield* Fiber.join(reconciling);
      const second = yield* runtime.contributions("commands");
      expect(yield* use("fast", second.generation)).toBe("2.0.0");

      yield* runtime.dispose;
      const afterDispose = yield* Effect.exit(use("fast", second.generation));
      expect(Exit.isFailure(afterDispose)).toBe(true);
      if (Exit.isFailure(afterDispose)) {
        expect(Cause.squash(afterDispose.cause)).toMatchObject({
          _tag: "PluginRuntimeDisposedError",
        });
      }
    }),
  );

  it.effect("closes a retiring plugin's scope only after its running invocations finish", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const release = yield* Deferred.make<void>();
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      // Reported after the replacement commits, just before the retiring scope closes.
      let markCommitted!: () => void;
      const committed = new Promise<void>((resolve) => {
        markCommitted = resolve;
      });
      let slowActivations = 0;
      const runtime = yield* PluginRuntime.make({
        onLifecycle: ({ phase, pluginId }) => {
          if (phase === "activate" && pluginId === "acme.slow" && ++slowActivations === 2) {
            markCommitted();
          }
        },
      });
      const slowPlugin = (version: string): PluginDefinition => ({
        id: "acme.slow",
        version,
        activate(context) {
          context.onDispose(() => {
            events.push(`disposed ${version}`);
          });
          context.register(
            "commands",
            { id: "slow", label: "Slow" },
            Effect.sync(() => markStarted()).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.sync(() => events.push(`finished ${version}`))),
            ),
          );
        },
      });
      const otherPlugin: PluginDefinition = {
        id: "acme.other",
        version: "1.0.0",
        activate(context) {
          context.register("commands", { id: "other", label: "Other" }, Effect.succeed("other"));
        },
      };
      yield* runtime.reconcile([otherPlugin, slowPlugin("1.0.0")]);
      const first = yield* runtime.contributions("commands");
      const use = <A>(id: string, generation: number) =>
        runtime.useContribution("commands", id, generation, (handler: Effect.Effect<A>) => handler);

      const slow = yield* Effect.forkChild(use("slow", first.generation));
      yield* Effect.promise(() => started);
      const reconciling = yield* Effect.forkChild(
        runtime.reconcile([otherPlugin, slowPlugin("2.0.0")]),
      );
      yield* Effect.promise(() => committed);
      // The retiring version is still serving its invocation, so its disposer waits,
      // while other plugins keep serving invocations from the new generation.
      expect(events).toEqual([]);
      const second = yield* runtime.contributions("commands");
      expect(second.generation).toBe(first.generation + 1);
      expect(yield* use("other", second.generation)).toBe("other");

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(slow);
      yield* Fiber.join(reconciling);
      expect(events).toEqual(["finished 1.0.0", "disposed 1.0.0"]);
    }),
  );

  it.effect("keeps interrupted asynchronous contribution descendants reentrancy guarded", () =>
    Effect.gen(function* () {
      const runtime = yield* PluginRuntime.make();
      let markStarted!: () => void;
      let releaseHandler!: () => void;
      let resolveNested!: (
        exit: Exit.Exit<PluginRuntimeSnapshot, PluginRuntime.PluginRuntimeReconcileError>,
      ) => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const handlerGate = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      const nestedResult = new Promise<
        Exit.Exit<PluginRuntimeSnapshot, PluginRuntime.PluginRuntimeReconcileError>
      >((resolve) => {
        resolveNested = resolve;
      });
      const definition: PluginDefinition = {
        id: "acme.commands",
        version: "1.0.0",
        activate(context) {
          context.register(
            "commands",
            { id: "status", label: "Status" },
            Effect.promise(async () => {
              markStarted();
              await handlerGate;
              // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- verifies an interrupted native promise descendant cannot reenter
              resolveNested(await Effect.runPromiseExit(runtime.reconcile([])));
            }),
          );
        },
      };
      yield* runtime.reconcile([definition]);
      const catalog = yield* runtime.contributions("commands");
      const invocation = yield* Effect.forkChild(
        runtime.useContribution(
          "commands",
          "status",
          catalog.generation,
          (handler: Effect.Effect<void>) => handler,
        ),
      );
      yield* Effect.promise(() => started);
      yield* Fiber.interrupt(invocation);
      releaseHandler();
      const nestedExit = yield* Effect.promise(() => nestedResult);

      expect(Exit.isFailure(nestedExit)).toBe(true);
      if (Exit.isFailure(nestedExit)) {
        expect(Cause.squash(nestedExit.cause)).toMatchObject({
          _tag: "PluginRuntimeReentrancyError",
          callback: "contribution",
          operation: "reconcile",
        });
      }
      expect((yield* runtime.contributions("commands")).generation).toBe(catalog.generation);
    }),
  );

  it.effect("keeps the contribution generation stable for an unchanged composition", () =>
    Effect.gen(function* () {
      const runtime = yield* PluginRuntime.make();
      const definition: PluginDefinition = {
        id: "acme.commands",
        version: "1.0.0",
        activate(context) {
          context.register("commands", { id: "status", label: "Status" }, Effect.void);
        },
      };

      yield* runtime.reconcile([definition]);
      const first = yield* runtime.contributions("commands");
      yield* runtime.reconcile([definition]);
      const second = yield* runtime.contributions("commands");

      expect(second.generation).toBe(first.generation);
      expect(second.entries).toEqual(first.entries);
    }),
  );

  it.effect("rejects non-declarative contribution data without replacing the composition", () =>
    Effect.gen(function* () {
      const runtime = yield* PluginRuntime.make();
      const stable: PluginDefinition = {
        id: "acme.commands",
        version: "1.0.0",
        activate(context) {
          context.register("commands", { id: "status", label: "Status" }, Effect.void);
        },
      };
      yield* runtime.reconcile([stable]);
      const committed = yield* runtime.contributions("commands");
      const circular: { self?: unknown } = {};
      circular.self = circular;
      const invalidValues: ReadonlyArray<unknown> = [
        circular,
        new Map([["status", true]]),
        new Uint8Array([1]),
      ];

      for (const [index, data] of invalidValues.entries()) {
        const failed = yield* Effect.exit(
          runtime.reconcile([
            {
              id: "acme.commands",
              version: `2.0.${index}`,
              activate(context) {
                context.register("commands", {
                  id: "status",
                  label: "Status",
                  data: data as never,
                });
              },
            },
          ]),
        );
        expect(Exit.isFailure(failed)).toBe(true);
        if (Exit.isFailure(failed)) {
          expect(Cause.squash(failed.cause)).toMatchObject({ _tag: "PluginCallbackError" });
        }
        expect((yield* runtime.contributions("commands")).generation).toBe(committed.generation);
      }
    }),
  );

  it.effect("uses detached metadata as the default live contribution value", () =>
    Effect.gen(function* () {
      const runtime = yield* PluginRuntime.make();
      const contribution = { id: "status", label: "Status", data: { source: "original" } };
      const definition: PluginDefinition = {
        id: "acme.commands",
        version: "1.0.0",
        activate(context) {
          context.register("commands", contribution);
        },
      };

      yield* runtime.reconcile([definition]);
      const catalog = yield* runtime.contributions("commands");
      contribution.id = "mutated";
      contribution.label = "Mutated";
      contribution.data.source = "mutated";
      const used = yield* runtime.useContribution(
        "commands",
        "status",
        catalog.generation,
        (value: typeof contribution) => Effect.succeed(value),
      );

      expect(used).toEqual({ id: "status", label: "Status", data: { source: "original" } });
      expect(Object.isFrozen(used)).toBe(true);
      expect(Object.isFrozen(used.data)).toBe(true);
    }),
  );

  it.effect("preserves an explicitly undefined live contribution value", () =>
    Effect.gen(function* () {
      const runtime = yield* PluginRuntime.make();
      const definition: PluginDefinition = {
        id: "acme.commands",
        version: "1.0.0",
        activate(context) {
          context.register("commands", { id: "status", label: "Status" }, undefined);
        },
      };

      yield* runtime.reconcile([definition]);
      const catalog = yield* runtime.contributions("commands");
      const isUndefined = yield* runtime.useContribution(
        "commands",
        "status",
        catalog.generation,
        (value: undefined) => Effect.succeed(value === undefined),
      );

      expect(isUndefined).toBe(true);
    }),
  );
});

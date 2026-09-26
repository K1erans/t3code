import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { PluginCommand } from "@t3tools/contracts";
import type { PluginDefinition } from "@t3tools/plugin-runtime";

import * as PluginCommandCatalog from "./PluginCommandCatalog.ts";

const helloCommand: PluginCommand = {
  id: "acme.hello",
  label: "Say hello",
  description: "Return a greeting from the trusted test plugin.",
  surfaces: ["web", "desktop"],
};

const testPlugin = (input: {
  readonly fail?: boolean;
  readonly id?: string;
  readonly commandId?: string;
  readonly message: string;
  readonly version: string;
}): PluginDefinition => ({
  id: input.id ?? "acme.command-plugin",
  version: input.version,
  activate(context) {
    if (input.fail === true) throw new Error("activation failed");
    PluginCommandCatalog.registerPluginCommand(
      context,
      input.commandId ?? helloCommand.id,
      Effect.succeed({ message: input.message, tone: "success" }),
    );
  },
});

describe("plugin command catalog", () => {
  it("keeps command identity on execution errors", () => {
    const error = new PluginCommandCatalog.PluginCommandExecutionError({
      cause: new Error("handler failed"),
      id: "acme.hello",
    });

    expect(error.message).toBe("Plugin command acme.hello failed during execution.");
  });

  it.effect("lists published commands and invokes them once their plugin is active", () =>
    Effect.gen(function* () {
      const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
      expect((yield* catalog.list).commands).toEqual([]);
      const listed = yield* catalog.publish([helloCommand]);
      const streamed = yield* Stream.runHead(catalog.changes);

      expect(listed.commands).toEqual([helloCommand]);
      expect(Object.isFrozen(listed)).toBe(true);
      expect(Object.isFrozen(listed.commands)).toBe(true);
      expect(Object.isFrozen(listed.commands[0])).toBe(true);
      expect(Object.isFrozen(listed.commands[0]?.surfaces)).toBe(true);
      expect(Option.getOrNull(streamed)).toEqual(listed);

      const input = { generation: listed.generation, id: helloCommand.id };
      // Listed but not active: the caller has to activate the plugin first.
      expect((yield* Effect.flip(catalog.invoke(input)))._tag).toBe("PluginCommandNotFoundError");
      yield* catalog.reconcile([testPlugin({ message: "hello one", version: "1.0.0" })]);
      expect(yield* catalog.invoke(input)).toEqual({ message: "hello one", tone: "success" });
    }).pipe(Effect.provide(PluginCommandCatalog.layer)),
  );

  it.effect("changes the generation only when the listed commands change", () =>
    Effect.gen(function* () {
      const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
      const first = yield* catalog.publish([helloCommand]);
      expect(yield* catalog.publish([{ ...helloCommand, surfaces: ["web", "desktop"] }])).toBe(
        first,
      );

      // Plugins activating and shutting down leave clients' generation valid.
      yield* catalog.reconcile([testPlugin({ message: "hello one", version: "1.0.0" })]);
      yield* catalog.reconcile([
        testPlugin({ message: "hello one", version: "1.0.0" }),
        testPlugin({
          id: "acme.other-plugin",
          commandId: "acme.other",
          message: "other",
          version: "1.0.0",
        }),
      ]);
      expect(yield* catalog.list).toBe(first);
      expect(yield* catalog.invoke({ generation: first.generation, id: helloCommand.id })).toEqual({
        message: "hello one",
        tone: "success",
      });

      const second = yield* catalog.publish([{ ...helloCommand, label: "Say hi" }]);
      expect(second.generation).toBe(first.generation + 1);
      const stale = yield* Effect.flip(
        catalog.invoke({ generation: first.generation, id: helloCommand.id }),
      );
      expect(stale._tag).toBe("PluginCommandCatalogChangedError");
    }).pipe(Effect.provide(PluginCommandCatalog.layer)),
  );

  it.effect("does not run a registered command the catalog does not list", () =>
    Effect.gen(function* () {
      const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
      yield* catalog.reconcile([testPlugin({ message: "hello one", version: "1.0.0" })]);
      const listed = yield* catalog.list;
      const failure = yield* Effect.flip(
        catalog.invoke({ generation: listed.generation, id: helloCommand.id }),
      );
      expect(failure._tag).toBe("PluginCommandNotFoundError");
    }).pipe(Effect.provide(PluginCommandCatalog.layer)),
  );

  it.effect("keeps the committed handler when replacement activation fails", () =>
    Effect.gen(function* () {
      const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
      const listed = yield* catalog.publish([helloCommand]);
      yield* catalog.reconcile([testPlugin({ message: "hello one", version: "1.0.0" })]);
      const committed = yield* catalog.activeGeneration;
      const failed = yield* Effect.exit(
        catalog.reconcile([testPlugin({ fail: true, message: "hello two", version: "2.0.0" })]),
      );

      expect(Exit.isFailure(failed)).toBe(true);
      expect(yield* catalog.activeGeneration).toBe(committed);
      expect(yield* catalog.invoke({ generation: listed.generation, id: helloCommand.id })).toEqual(
        { message: "hello one", tone: "success" },
      );
    }).pipe(Effect.provide(PluginCommandCatalog.layer)),
  );
});

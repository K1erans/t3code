import {
  type PluginCommand,
  type PluginCommandCatalog as PluginCommandCatalogSnapshot,
  PluginCommandCatalogChangedError,
  PluginCommandId,
  type PluginCommandInvocationResult,
  PluginCommandInvocationError,
  type PluginCommandInvokeInput,
  PluginCommandNotFoundError,
} from "@t3tools/contracts";
import type { PluginActivationContext, PluginDefinition } from "@t3tools/plugin-runtime";
import { PluginRuntime } from "@t3tools/plugin-runtime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

const COMMAND_SLOT = "commands";
const isContributionGenerationError = Schema.is(PluginRuntime.PluginContributionGenerationError);
const isContributionNotFoundError = Schema.is(PluginRuntime.PluginContributionNotFoundError);

export class PluginCommandExecutionError extends Schema.TaggedError<PluginCommandExecutionError>()(
  "PluginCommandExecutionError",
  { cause: Schema.Defect(), id: PluginCommandId },
) {
  override get message(): string {
    return `Plugin command ${this.id} failed during execution.`;
  }
}

type PluginCommandHandler = Effect.Effect<
  PluginCommandInvocationResult,
  PluginCommandExecutionError
>;

/** Registers the handler of a command the catalog lists, while its plugin is active. */
export const registerPluginCommand = (
  context: PluginActivationContext,
  id: PluginCommandId,
  handler: PluginCommandHandler,
): void => context.register(COMMAND_SLOT, { id, label: id }, handler);

const freezeCommand = (command: PluginCommand): PluginCommand =>
  Object.freeze({ ...command, surfaces: Object.freeze([...command.surfaces]) });

const sameCommands = (left: ReadonlyArray<PluginCommand>, right: ReadonlyArray<PluginCommand>) =>
  left.length === right.length &&
  left.every((command, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      command.id === other.id &&
      command.label === other.label &&
      command.description === other.description &&
      command.surfaces.length === other.surfaces.length &&
      command.surfaces.every((surface, surfaceIndex) => other.surfaces[surfaceIndex] === surface)
    );
  });

export class PluginCommandCatalog extends Context.Service<
  PluginCommandCatalog,
  {
    /**
     * The commands clients may run: those of every enabled plugin, active or not. The
     * generation changes only when this list does, never when a plugin activates or idles.
     */
    readonly list: Effect.Effect<PluginCommandCatalogSnapshot>;
    readonly changes: Stream.Stream<PluginCommandCatalogSnapshot>;
    readonly publish: (
      commands: ReadonlyArray<PluginCommand>,
    ) => Effect.Effect<PluginCommandCatalogSnapshot>;
    /** Runs a listed command in its plugin, which must already be active. */
    readonly invoke: (
      input: PluginCommandInvokeInput,
    ) => Effect.Effect<
      PluginCommandInvocationResult,
      PluginCommandCatalogChangedError | PluginCommandInvocationError | PluginCommandNotFoundError
    >;
    /** Makes `definitions` the active plugins, activating and disposing as needed. */
    readonly reconcile: (
      definitions: ReadonlyArray<PluginDefinition>,
    ) => Effect.Effect<void, PluginRuntime.PluginRuntimeReconcileError>;
    /** Changes whenever `reconcile` commits, including one that then fails cleaning up. */
    readonly activeGeneration: Effect.Effect<number>;
  }
>()("t3/plugins/PluginCommandCatalog") {}

export const make = Effect.gen(function* () {
  const runtime = yield* PluginRuntime.PluginRuntime;
  const state = yield* SubscriptionRef.make<PluginCommandCatalogSnapshot>(
    Object.freeze({ commands: Object.freeze([]), generation: 0 }),
  );

  const publish = (commands: ReadonlyArray<PluginCommand>) =>
    SubscriptionRef.modify(state, (previous) => {
      if (sameCommands(previous.commands, commands)) return [previous, previous];
      const next = Object.freeze({
        commands: Object.freeze(commands.map(freezeCommand)),
        generation: previous.generation + 1,
      });
      return [next, next];
    });

  const activeGeneration = runtime
    .contributions(COMMAND_SLOT)
    .pipe(Effect.map((snapshot) => snapshot.generation));

  const invoke = Effect.fn("PluginCommandCatalog.invoke")(function* (
    input: PluginCommandInvokeInput,
  ) {
    const listed = yield* SubscriptionRef.get(state);
    if (listed.generation !== input.generation) {
      return yield* new PluginCommandCatalogChangedError({
        actualGeneration: listed.generation,
        expectedGeneration: input.generation,
      });
    }
    if (!listed.commands.some((command) => command.id === input.id)) {
      return yield* new PluginCommandNotFoundError({ id: input.id });
    }
    // The client's generation is the listed one. Another plugin activating between
    // reading the runtime generation and using it is harmless, so that race retries.
    return yield* activeGeneration.pipe(
      Effect.flatMap((generation) =>
        runtime.useContribution<
          PluginCommandHandler,
          PluginCommandInvocationResult,
          PluginCommandExecutionError,
          never
        >(COMMAND_SLOT, input.id, generation, (handler) => handler),
      ),
      Effect.retry({ while: isContributionGenerationError, times: 3 }),
      Effect.mapError((error) =>
        isContributionNotFoundError(error)
          ? new PluginCommandNotFoundError({ id: input.id })
          : new PluginCommandInvocationError({ cause: error, id: input.id }),
      ),
    );
  });

  return PluginCommandCatalog.of({
    changes: SubscriptionRef.changes(state),
    invoke,
    list: SubscriptionRef.get(state),
    publish,
    reconcile: runtime.reconcile,
    activeGeneration,
  });
});

export const layer = Layer.effect(PluginCommandCatalog, make).pipe(
  Layer.provide(PluginRuntime.layer()),
);

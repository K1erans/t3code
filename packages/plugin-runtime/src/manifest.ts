import * as Schema from "effect/Schema";

const NamespacedId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/),
  Schema.isMaxLength(255),
);

const SemanticVersion = Schema.String.check(
  Schema.isPattern(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  ),
);

/** A versioned host capability such as `t3.commands@0`. `@0` is experimental. */
const CapabilityId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9.-]*@(?:0|[1-9]\d*)$/));

const RelativeEntrypoint = Schema.String.check(
  Schema.isPattern(/^\.\/(?!(?:\.\.(?:\/|$)|.*\/\.\.(?:\/|$)))[A-Za-z0-9_./-]+$/),
);

/**
 * A struct that rejects keys it does not declare. Annotations cannot override the
 * decoder's `onExcessProperty`, so the check runs on the raw input instead.
 */
const ClosedStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) => {
  const keys = new Set(Object.keys(fields));
  return Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.check(
      Schema.makeFilter((input: Record<string, unknown>) => {
        const excess = Object.keys(input).find((key) => !keys.has(key));
        return excess === undefined ? undefined : `Unexpected key ${excess}`;
      }),
    ),
    Schema.decodeTo(Schema.Struct(fields)),
  );
};

/**
 * An argument-free palette command; `title` is the label the palette shows. The palette
 * lists it from the manifest, so it appears before its plugin has activated.
 */
const CommandContribution = ClosedStruct({
  // The palette catalog caps command ids at 200 characters.
  id: NamespacedId.check(Schema.isMaxLength(200)),
  title: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(120)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});

const CommandContributions = Schema.Array(CommandContribution).check(
  Schema.makeFilter((commands) => {
    const ids = new Set<string>();
    for (const command of commands) {
      if (ids.has(command.id)) return `Duplicate command id ${command.id}`;
      ids.add(command.id);
    }
    return undefined;
  }),
);

export const PluginManifest = ClosedStruct({
  manifestVersion: Schema.Literal(1),
  id: NamespacedId,
  name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  /** Package-relative SVG or PNG shown next to the name in Settings. */
  icon: Schema.optional(RelativeEntrypoint),
  version: SemanticVersion,
  /** Host capabilities the plugin needs. This is the only compatibility check. */
  requires: Schema.Array(CapabilityId),
  surfaces: Schema.optional(Schema.Array(Schema.Literals(["web", "desktop", "mobile"]))),
  /**
   * Plugins activate when one of their commands runs. `onTurnStateChange` also wakes the
   * plugin when a thread's turn state changes (it needs `t3.threads@0`). `onStartup`
   * activates the plugin with the server and keeps it running; prefer the other triggers.
   */
  activationEvents: Schema.optional(
    Schema.Array(Schema.Literals(["onStartup", "onTurnStateChange"])),
  ),
  entrypoints: Schema.optional(ClosedStruct({ server: Schema.optional(RelativeEntrypoint) })),
  contributes: Schema.optional(ClosedStruct({ commands: Schema.optional(CommandContributions) })),
}).pipe(
  Schema.check(
    Schema.makeFilter((manifest) =>
      manifest.activationEvents?.includes("onTurnStateChange") &&
      !manifest.requires.includes("t3.threads@0")
        ? "activationEvents onTurnStateChange needs t3.threads@0 in requires"
        : undefined,
    ),
  ),
);

export type PluginManifest = typeof PluginManifest.Type;

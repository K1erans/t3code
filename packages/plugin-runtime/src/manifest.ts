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

/** An argument-free palette command; `title` is the label the palette shows. */
const CommandContribution = ClosedStruct({
  id: NamespacedId,
  title: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(120)),
});

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
  entrypoints: Schema.optional(ClosedStruct({ server: Schema.optional(RelativeEntrypoint) })),
  contributes: Schema.optional(
    ClosedStruct({ commands: Schema.optional(Schema.Array(CommandContribution)) }),
  ),
});

export type PluginManifest = typeof PluginManifest.Type;

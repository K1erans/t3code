import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PluginPackageId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/),
  Schema.isMaxLength(255),
);
export type PluginPackageId = typeof PluginPackageId.Type;

/** A versioned host capability such as `t3.commands@0`. `@0` is experimental. */
export const PluginPackageCapability = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9.-]*@(?:0|[1-9]\d*)$/),
);
export type PluginPackageCapability = typeof PluginPackageCapability.Type;

/**
 * `activating` is enabled and loading at startup or activating for a command; `idle`
 * is enabled but not running, and activates when one of its commands runs.
 */
export const PluginPackageState = Schema.Literals([
  "disabled",
  "activating",
  "idle",
  "active",
  "error",
]);
export type PluginPackageState = typeof PluginPackageState.Type;

export const PluginPackageContributions = Schema.Struct({
  commands: Schema.Array(PluginPackageId),
});
export type PluginPackageContributions = typeof PluginPackageContributions.Type;

export const PluginPackageStatus = Schema.Struct({
  id: PluginPackageId,
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  /** A `data:` URL, inlined so remote clients need no extra authenticated fetch. */
  iconUrl: Schema.optional(Schema.String),
  version: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  state: PluginPackageState,
  /** The host capabilities the manifest requires. */
  requires: Schema.Array(PluginPackageCapability),
  contributions: PluginPackageContributions,
  /** The T3 version in which a deprecated capability this plugin requires stops working. */
  olderApiRemovedIn: Schema.optional(TrimmedNonEmptyString),
  error: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
});
export type PluginPackageStatus = typeof PluginPackageStatus.Type;

export const PluginPackageDiscoveryError = Schema.Struct({
  directory: TrimmedNonEmptyString.check(Schema.isMaxLength(255), Schema.isPattern(/^[^/\\]+$/)),
  error: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
});
export type PluginPackageDiscoveryError = typeof PluginPackageDiscoveryError.Type;

export const PluginPackageStatusSnapshot = Schema.Struct({
  errors: Schema.Array(PluginPackageDiscoveryError),
  packages: Schema.Array(PluginPackageStatus),
});
export type PluginPackageStatusSnapshot = typeof PluginPackageStatusSnapshot.Type;

/**
 * One plugin's folder in `plugin-data/`. Data of a plugin that is no longer
 * installed is a leftover, deleted automatically at `deletesAt`.
 */
export const PluginDataEntry = Schema.Struct({
  id: PluginPackageId,
  /** The manifest name, known while the plugin is installed. */
  name: Schema.optional(TrimmedNonEmptyString),
  installed: Schema.Boolean,
  /** Absent until a discovery has noticed the plugin missing. */
  deletesAt: Schema.optional(IsoDateTime),
  /** Present only when sizes were asked for, since measuring walks every file. */
  sizeBytes: Schema.optional(NonNegativeInt),
});
export type PluginDataEntry = typeof PluginDataEntry.Type;

export const PluginDataSnapshot = Schema.Struct({
  entries: Schema.Array(PluginDataEntry),
});
export type PluginDataSnapshot = typeof PluginDataSnapshot.Type;

/**
 * Rejects keys other than `id`. Annotations cannot override the decoder's
 * `onExcessProperty`, so the check runs on the raw input instead.
 */
export const PluginPackageActionInput = Schema.Record(Schema.String, Schema.Unknown).pipe(
  Schema.check(
    Schema.makeFilter((input: Record<string, unknown>) => {
      const excess = Object.keys(input).find((key) => key !== "id");
      return excess === undefined ? undefined : `Unexpected key ${excess}`;
    }),
  ),
  Schema.decodeTo(Schema.Struct({ id: PluginPackageId })),
);
export type PluginPackageActionInput = typeof PluginPackageActionInput.Type;

export const PluginPackageOperation = Schema.Literals([
  "status",
  "enable",
  "disable",
  "reload",
  "rescan",
  "activate",
  "deactivate",
  "data",
  "deleteData",
]);
export type PluginPackageOperation = typeof PluginPackageOperation.Type;

export class PluginPackageNotFoundError extends Schema.TaggedError<PluginPackageNotFoundError>()(
  "PluginPackageNotFoundError",
  { id: PluginPackageId },
) {
  override get message(): string {
    return `Plugin package not found: ${this.id}`;
  }
}

export class PluginPackageOperationError extends Schema.TaggedError<PluginPackageOperationError>()(
  "PluginPackageOperationError",
  {
    id: Schema.optional(PluginPackageId),
    operation: PluginPackageOperation,
    /** A readable reason. The underlying server error stays in the server log, never on the wire. */
    detail: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  },
) {
  override get message(): string {
    const packageName = this.id === undefined ? "plugin packages" : `plugin package ${this.id}`;
    return `${this.operation} failed for ${packageName}: ${this.detail}`;
  }
}

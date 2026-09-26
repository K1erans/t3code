import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PluginPackageId } from "./pluginPackages.ts";

export const PluginCommandId = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export type PluginCommandId = typeof PluginCommandId.Type;

export const PluginCommandSurface = Schema.Literals(["web", "desktop", "mobile"]);
export type PluginCommandSurface = typeof PluginCommandSurface.Type;

export const PluginCommand = Schema.Struct({
  id: PluginCommandId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  description: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  surfaces: Schema.Array(PluginCommandSurface).check(Schema.isMinLength(1)),
});
export type PluginCommand = typeof PluginCommand.Type;

export const PluginScreenId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
  Schema.isMaxLength(64),
);
export type PluginScreenId = typeof PluginScreenId.Type;

/**
 * A screen an enabled plugin declares. `revision` changes whenever the plugin's code is
 * reloaded, so clients rebuild open frames from a fresh URL.
 */
export const PluginScreen = Schema.Struct({
  pluginId: PluginPackageId,
  id: PluginScreenId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  placement: Schema.Literal("panel"),
  /** A project screen needs a current project; an environment screen does not. */
  scope: Schema.Literals(["project", "environment"]),
  surfaces: Schema.Array(PluginCommandSurface).check(Schema.isMinLength(1)),
  revision: NonNegativeInt,
});
export type PluginScreen = typeof PluginScreen.Type;

/** What the palette offers: commands to run and screens to open, from every enabled plugin. */
export const PluginCommandCatalog = Schema.Struct({
  generation: NonNegativeInt,
  commands: Schema.Array(PluginCommand),
  screens: Schema.Array(PluginScreen),
});
export type PluginCommandCatalog = typeof PluginCommandCatalog.Type;

export const PluginCommandInvokeInput = Schema.Struct({
  generation: NonNegativeInt,
  id: PluginCommandId,
});
export type PluginCommandInvokeInput = typeof PluginCommandInvokeInput.Type;

export const PluginCommandInvocationResult = Schema.Struct({
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  tone: Schema.Literals(["info", "success"]),
});
export type PluginCommandInvocationResult = typeof PluginCommandInvocationResult.Type;

export class PluginCommandNotFoundError extends Schema.TaggedError<PluginCommandNotFoundError>()(
  "PluginCommandNotFoundError",
  { id: PluginCommandId },
) {
  override get message(): string {
    return `Plugin command not found: ${this.id}`;
  }
}

export class PluginCommandCatalogChangedError extends Schema.TaggedError<PluginCommandCatalogChangedError>()(
  "PluginCommandCatalogChangedError",
  {
    actualGeneration: NonNegativeInt,
    expectedGeneration: NonNegativeInt,
  },
) {
  override get message(): string {
    return `Plugin command catalog changed from generation ${this.expectedGeneration} to ${this.actualGeneration}`;
  }
}

export class PluginCommandInvocationError extends Schema.TaggedError<PluginCommandInvocationError>()(
  "PluginCommandInvocationError",
  {
    cause: Schema.Defect(),
    id: PluginCommandId,
  },
) {
  override get message(): string {
    return `Plugin command failed: ${this.id}`;
  }
}

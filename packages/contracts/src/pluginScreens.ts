import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PluginScreenId } from "./pluginCommands.ts";
import { PluginPackageId } from "./pluginPackages.ts";

/**
 * The sandbox for plugin screens, used both as the iframe's `sandbox` attribute and in the
 * server's CSP `sandbox` header. Without `allow-same-origin` a screen gets an opaque origin.
 */
export const PLUGIN_SCREEN_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups";

export const PluginScreenUrlInput = Schema.Struct({
  pluginId: PluginPackageId,
  screenId: PluginScreenId,
  /** The catalog revision the client is showing; a stale one is refused. */
  revision: NonNegativeInt,
});
export type PluginScreenUrlInput = typeof PluginScreenUrlInput.Type;

export const PluginScreenUrlResult = Schema.Struct({
  /** Resolve against the environment's HTTP base URL. The token in it is the only credential. */
  relativeUrl: TrimmedNonEmptyString,
  /** Epoch milliseconds after which the URL stops working; fetch a new one before then. */
  expiresAt: Schema.optional(NonNegativeInt),
});
export type PluginScreenUrlResult = typeof PluginScreenUrlResult.Type;

/** The screen is gone: its plugin was disabled, failed, removed or reloaded to another revision. */
export class PluginScreenUnavailableError extends Schema.TaggedError<PluginScreenUnavailableError>()(
  "PluginScreenUnavailableError",
  { pluginId: PluginPackageId, screenId: PluginScreenId },
) {
  override get message(): string {
    return `Plugin screen ${this.pluginId}/${this.screenId} is not available`;
  }
}

import type { PluginCommandSurface, PluginScreen } from "@t3tools/contracts";

/** The plugin surface this client runs as. */
export const currentPluginSurface = (): PluginCommandSurface =>
  typeof window !== "undefined" && window.desktopBridge !== undefined ? "desktop" : "web";

/**
 * The panel screens a thread can open here: those declared for this surface, and
 * project-scoped ones only when the thread has a project.
 */
export const openablePanelScreens = (
  screens: ReadonlyArray<PluginScreen>,
  input: { readonly surface: PluginCommandSurface; readonly projectAvailable: boolean },
): ReadonlyArray<PluginScreen> =>
  screens.filter(
    (screen) =>
      screen.placement === "panel" &&
      screen.surfaces.includes(input.surface) &&
      (screen.scope === "environment" || input.projectAvailable),
  );

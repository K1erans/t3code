import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginScreen } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { PuzzleIcon } from "lucide-react";

import { MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator } from "~/components/ui/menu";
import { serverEnvironment } from "~/state/server";

import { currentPluginSurface, openablePanelScreens } from "./pluginScreens.logic";

/**
 * The plugin screens section of the panel's add-tab menu. It only mounts while the menu is
 * open, so the plugin catalog is subscribed only then.
 */
export function PluginScreenMenuItems(props: {
  readonly environmentId: EnvironmentId;
  readonly projectAvailable: boolean;
  readonly onOpen: (screen: PluginScreen) => void;
}) {
  const catalog = useAtomValue(
    serverEnvironment.pluginCommands({ environmentId: props.environmentId, input: {} }),
  );
  const screens = openablePanelScreens(
    Option.getOrNull(AsyncResult.value(catalog))?.screens ?? [],
    { surface: currentPluginSurface(), projectAvailable: props.projectAvailable },
  );
  if (screens.length === 0) return null;
  return (
    <>
      <MenuSeparator />
      <MenuGroup>
        <MenuGroupLabel>Plugins</MenuGroupLabel>
        {screens.map((screen) => (
          <MenuItem key={`${screen.pluginId}/${screen.id}`} onClick={() => props.onOpen(screen)}>
            <PuzzleIcon />
            {screen.title}
          </MenuItem>
        ))}
      </MenuGroup>
    </>
  );
}

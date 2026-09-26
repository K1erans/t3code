import type { PluginScreen } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { openablePanelScreens } from "./pluginScreens.logic";

const screen = (overrides: Partial<PluginScreen>): PluginScreen => ({
  pluginId: "com.example.board",
  id: "board",
  title: "Board",
  placement: "panel",
  scope: "project",
  surfaces: ["web", "desktop"],
  revision: 0,
  ...overrides,
});

describe("openablePanelScreens", () => {
  const projectScreen = screen({ id: "project" });
  const environmentScreen = screen({ id: "environment", scope: "environment" });
  const desktopOnly = screen({ id: "desktop-only", surfaces: ["desktop"] });
  const screens = [projectScreen, environmentScreen, desktopOnly];

  it("offers project screens only when the thread has a project", () => {
    expect(openablePanelScreens(screens, { surface: "web", projectAvailable: true })).toEqual([
      projectScreen,
      environmentScreen,
    ]);
    expect(openablePanelScreens(screens, { surface: "web", projectAvailable: false })).toEqual([
      environmentScreen,
    ]);
  });

  it("offers only screens declared for this surface", () => {
    expect(
      openablePanelScreens(screens, { surface: "desktop", projectAvailable: true }),
    ).toContainEqual(desktopOnly);
    expect(openablePanelScreens(screens, { surface: "mobile", projectAvailable: true })).toEqual(
      [],
    );
  });
});

import { describe, expect, it } from "vite-plus/test";

import { PluginPackageOperationError } from "@t3tools/contracts";

import {
  filterPluginPackages,
  pluginActionErrorText,
  pluginStatusBadges,
} from "./PluginsSettings.logic";

describe("pluginStatusBadges", () => {
  it("labels each lifecycle state", () => {
    const label = (state: "active" | "idle" | "disabled" | "error") =>
      pluginStatusBadges({ state, capabilities: [] }).map((badge) => badge.label);
    expect(label("active")).toEqual(["Active"]);
    expect(label("idle")).toEqual(["Idle"]);
    expect(label("disabled")).toEqual(["Disabled"]);
    expect(label("error")).toEqual(["Error"]);
  });

  it("flags experimental and older capabilities", () => {
    expect(
      pluginStatusBadges({
        state: "active",
        capabilities: ["t3.commands@0", "t3.screens@10"],
        olderApiRemovedIn: "1.4",
      }).map((badge) => badge.label),
    ).toEqual(["Active", "Experimental API", "Older API, stops working in T3 1.4"]);
    expect(
      pluginStatusBadges({ state: "active", capabilities: ["t3.commands@10"] }).map(
        (badge) => badge.label,
      ),
    ).toEqual(["Active"]);
  });
});

describe("filterPluginPackages", () => {
  const packages = [
    { id: "com.acme.task-board", name: "Task board", description: "Plan work in columns" },
    { id: "com.acme.runtime-status", name: "Runtime status" },
  ];

  it("matches name, id and description case-insensitively", () => {
    const ids = (query: string) => filterPluginPackages(packages, query).map((entry) => entry.id);
    expect(ids("TASK")).toEqual(["com.acme.task-board"]);
    expect(ids("runtime-status")).toEqual(["com.acme.runtime-status"]);
    expect(ids("columns")).toEqual(["com.acme.task-board"]);
    expect(ids("acme")).toEqual(["com.acme.task-board", "com.acme.runtime-status"]);
  });

  it("requires every term and ignores blank queries", () => {
    expect(filterPluginPackages(packages, "   ")).toBe(packages);
    expect(filterPluginPackages(packages, "acme columns").map((entry) => entry.id)).toEqual([
      "com.acme.task-board",
    ]);
    expect(filterPluginPackages(packages, "acme missing")).toEqual([]);
  });
});

describe("pluginActionErrorText", () => {
  it("prefers the operation detail over the generic message", () => {
    const error = new PluginPackageOperationError({
      id: "acme.tools",
      operation: "enable",
      detail: "activate() threw: missing API key",
      cause: new Error("stack-bearing cause"),
    });
    expect(pluginActionErrorText(error)).toBe("activate() threw: missing API key");
  });

  it("falls back to the message, then to nothing", () => {
    expect(pluginActionErrorText(new PluginPackageOperationError({ operation: "rescan" }))).toBe(
      "rescan failed for plugin packages",
    );
    expect(pluginActionErrorText(new Error("  "))).toBeNull();
    expect(pluginActionErrorText("boom")).toBeNull();
  });
});

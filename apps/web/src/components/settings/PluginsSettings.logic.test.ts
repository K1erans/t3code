import { describe, expect, it } from "vite-plus/test";

import { PluginPackageOperationError } from "@t3tools/contracts";

import {
  filterPluginPackages,
  pluginActionErrorText,
  pluginDataDeletionLabel,
  pluginStatusBadges,
} from "./PluginsSettings.logic";

describe("pluginStatusBadges", () => {
  it("labels each lifecycle state", () => {
    const label = (state: "active" | "activating" | "idle" | "disabled" | "error") =>
      pluginStatusBadges({ state, requires: [] }).map((badge) => badge.label);
    expect(label("active")).toEqual(["Active"]);
    expect(label("activating")).toEqual(["Starting…"]);
    expect(label("idle")).toEqual(["Idle"]);
    expect(label("disabled")).toEqual(["Disabled"]);
    expect(label("error")).toEqual(["Error"]);
  });

  it("flags experimental and older capabilities", () => {
    expect(
      pluginStatusBadges({
        state: "active",
        requires: ["t3.commands@0", "t3.screens@10"],
        olderApiRemovedIn: "1.4",
      }).map((badge) => badge.label),
    ).toEqual(["Active", "Experimental API", "Older API, stops working in T3 1.4"]);
    expect(
      pluginStatusBadges({ state: "active", requires: ["t3.commands@10"] }).map(
        (badge) => badge.label,
      ),
    ).toEqual(["Active"]);
  });
});

describe("filterPluginPackages", () => {
  const packages = [
    { id: "com.acme.task-board", name: "Task board", description: "Plan work in columns" },
    { id: "com.acme.hello", name: "Hello" },
  ];

  it("matches name, id and description case-insensitively", () => {
    const ids = (query: string) => filterPluginPackages(packages, query).map((entry) => entry.id);
    expect(ids("TASK")).toEqual(["com.acme.task-board"]);
    expect(ids("hello")).toEqual(["com.acme.hello"]);
    expect(ids("columns")).toEqual(["com.acme.task-board"]);
    expect(ids("acme")).toEqual(["com.acme.task-board", "com.acme.hello"]);
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
    });
    expect(pluginActionErrorText(error)).toBe("activate() threw: missing API key");
  });

  it("falls back to the message, then to nothing", () => {
    expect(pluginActionErrorText(new Error("rescan failed for plugin packages"))).toBe(
      "rescan failed for plugin packages",
    );
    expect(pluginActionErrorText(new Error("  "))).toBeNull();
    expect(pluginActionErrorText("boom")).toBeNull();
  });
});

describe("pluginDataDeletionLabel", () => {
  const now = Date.parse("2026-09-01T12:00:00.000Z");
  const inDays = (days: number) => new Date(now + days * 24 * 60 * 60 * 1000).toISOString();

  it("counts whole days, rounding a partial day up", () => {
    expect(pluginDataDeletionLabel(inDays(30), now)).toBe("Deletes in 30 days");
    expect(pluginDataDeletionLabel(inDays(1.5), now)).toBe("Deletes in 2 days");
    expect(pluginDataDeletionLabel(inDays(0.25), now)).toBe("Deletes in 1 day");
  });

  it("says an expired countdown waits for the next rescan", () => {
    expect(pluginDataDeletionLabel(inDays(0), now)).toBe("Deletes on the next rescan");
    expect(pluginDataDeletionLabel(inDays(-2), now)).toBe("Deletes on the next rescan");
  });
});

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  PluginPackageActionInput,
  PluginPackageOperationError,
  PluginPackageStatusSnapshot,
} from "./pluginPackages.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const decodeStatus = Schema.decodeUnknownSync(PluginPackageStatusSnapshot);
const decodeAction = Schema.decodeUnknownSync(PluginPackageActionInput);

describe("plugin package contracts", () => {
  it("decodes environment package status", () => {
    expect(
      decodeStatus({
        errors: [],
        packages: [
          {
            id: "com.example.fixture",
            name: "Fixture",
            version: "1.0.0",
            enabled: true,
            state: "active",
            requires: ["t3.commands@0"],
            contributions: { commands: ["fixture.say-hello"] },
          },
        ],
      }),
    ).toEqual({
      errors: [],
      packages: [
        {
          id: "com.example.fixture",
          name: "Fixture",
          version: "1.0.0",
          enabled: true,
          state: "active",
          requires: ["t3.commands@0"],
          contributions: { commands: ["fixture.say-hello"] },
        },
      ],
    });
  });

  it("reports invalid discovered package directories without inventing an id", () => {
    expect(
      decodeStatus({
        errors: [{ directory: "broken-package", error: "manifest version is unsupported" }],
        packages: [],
      }),
    ).toEqual({
      errors: [{ directory: "broken-package", error: "manifest version is unsupported" }],
      packages: [],
    });
  });

  it("rejects malformed package ids and action payloads", () => {
    expect(() => decodeAction({ id: "fixture" })).toThrow();
    expect(() => decodeAction({ id: `com.${"a".repeat(252)}` })).toThrow();
    expect(() => decodeAction({ id: "com.example.fixture", extra: true })).toThrow();
  });

  it("preserves operation causes without putting failure text in the stable message", () => {
    const cause = new Error("disk exploded");
    const error = new PluginPackageOperationError({ cause, operation: "enable" });
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("enable failed for plugin packages");
    expect(
      new PluginPackageOperationError({
        detail: "package is not enabled",
        id: "com.example.fixture",
        operation: "reload",
      }).message,
    ).toBe("reload failed for plugin package com.example.fixture: package is not enabled");
  });

  it("registers fixed status and lifecycle rpc methods", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.pluginPackagesStatus)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.pluginPackagesEnable)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.pluginPackagesDisable)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.pluginPackagesReload)).toBe(true);
  });
});

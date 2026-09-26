import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { PluginManifest } from "../src/manifest.ts";

const decodeManifest = Schema.decodeUnknownSync(PluginManifest);

const validManifest = {
  manifestVersion: 1,
  id: "com.acme.linear",
  name: "Linear",
  version: "1.2.0",
  requires: ["t3.commands@0", "t3.storage@0"],
  surfaces: ["web", "desktop"],
  activationEvents: ["onStartup"],
  entrypoints: { server: "./dist/server.js" },
  contributes: {
    commands: [
      {
        id: "linear.create-issue",
        title: "Linear: create issue",
        description: "Opens a new issue.",
      },
    ],
  },
};

describe("PluginManifest", () => {
  it("decodes a versioned namespaced plugin manifest", () => {
    expect(decodeManifest(validManifest)).toEqual(validManifest);
  });

  it("requires only the identity, name, version and requirements", () => {
    const minimal = {
      manifestVersion: 1,
      id: "com.acme.minimal",
      name: "Minimal",
      version: "0.1.0",
      requires: [],
    };
    expect(decodeManifest(minimal)).toEqual(minimal);
    const { name: _name, ...withoutName } = minimal;
    expect(() => decodeManifest(withoutName)).toThrow();
    const { requires: _requires, ...withoutRequires } = minimal;
    expect(() => decodeManifest(withoutRequires)).toThrow();
  });

  it("accepts only onStartup as an explicit activation event", () => {
    expect(() =>
      decodeManifest({ ...validManifest, activationEvents: ["onTurnStateChange"] }),
    ).toThrow();
  });

  it("rejects unsupported manifest versions and fields outside the manifest", () => {
    expect(() => decodeManifest({ ...validManifest, manifestVersion: 2 })).toThrow();
    for (const field of ["apiVersion", "capabilities", "permissions", "provides", "engines"]) {
      expect(() => decodeManifest({ ...validManifest, [field]: [] })).toThrow();
    }
    for (const contribution of ["mobileCards", "views", "settings"]) {
      expect(() =>
        decodeManifest({
          ...validManifest,
          contributes: { ...validManifest.contributes, [contribution]: [] },
        }),
      ).toThrow();
    }
  });

  it("rejects unnamespaced plugin and command ids and untitled commands", () => {
    expect(() => decodeManifest({ ...validManifest, id: "linear" })).toThrow();
    expect(() => decodeManifest({ ...validManifest, id: `com.${"a".repeat(252)}` })).toThrow();
    expect(() =>
      decodeManifest({
        ...validManifest,
        contributes: { commands: [{ id: "create-issue", title: "Create issue" }] },
      }),
    ).toThrow();
    expect(() =>
      decodeManifest({ ...validManifest, contributes: { commands: ["linear.create-issue"] } }),
    ).toThrow();
    expect(() =>
      decodeManifest({ ...validManifest, contributes: { commands: [{ id: "linear.x" }] } }),
    ).toThrow();
  });

  it("rejects commands the palette cannot list", () => {
    const withCommands = (commands: ReadonlyArray<unknown>) =>
      decodeManifest({ ...validManifest, contributes: { commands } });
    expect(() => withCommands([{ id: `linear.${"a".repeat(194)}`, title: "Long" }])).toThrow();
    expect(withCommands([{ id: `linear.${"a".repeat(193)}`, title: "Long" }])).toBeDefined();
    expect(() => withCommands([{ id: "linear.blank", title: "   " }])).toThrow();
    expect(() =>
      withCommands([
        { id: "linear.twice", title: "One" },
        { id: "linear.twice", title: "Two" },
      ]),
    ).toThrow();
  });

  it("rejects malformed versions and capability ids", () => {
    expect(() => decodeManifest({ ...validManifest, version: "next" })).toThrow();
    expect(() => decodeManifest({ ...validManifest, version: "01.2.3" })).toThrow();
    expect(() => decodeManifest({ ...validManifest, version: "1.2.3-.." })).toThrow();
    expect(decodeManifest({ ...validManifest, version: "1.2.3+build.7" }).version).toBe(
      "1.2.3+build.7",
    );
    expect(() => decodeManifest({ ...validManifest, requires: ["t3.commands"] })).toThrow();
    expect(() => decodeManifest({ ...validManifest, requires: ["t3.storage@00"] })).toThrow();
    expect(decodeManifest({ ...validManifest, requires: ["t3.storage@0"] }).requires).toEqual([
      "t3.storage@0",
    ]);
  });

  it("allows only a server entrypoint, inside the plugin directory", () => {
    for (const server of ["./../outside.js", "./dist/../../outside.js"]) {
      expect(() => decodeManifest({ ...validManifest, entrypoints: { server } })).toThrow();
    }
    for (const surface of ["web", "desktop", "mobile"]) {
      expect(() =>
        decodeManifest({
          ...validManifest,
          entrypoints: { ...validManifest.entrypoints, [surface]: "./dist/client.js" },
        }),
      ).toThrow();
    }
    const { entrypoints: _entrypoints, ...withoutEntrypoints } = validManifest;
    expect(decodeManifest(withoutEntrypoints).entrypoints).toBeUndefined();
  });
});

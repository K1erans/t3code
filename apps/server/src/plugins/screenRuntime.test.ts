import { afterEach, describe, expect, it } from "vite-plus/test";

import { SCREEN_RUNTIME_SOURCE } from "./screenRuntime.ts";

interface Runtime {
  readonly connect: () => Promise<{ readonly context: unknown }>;
}

let loads = 0;

/** Loads a fresh copy of the runtime into a stand-in frame whose parent is T3. */
const loadFramedRuntime = async () => {
  const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const posted: Array<unknown> = [];
  const parent = { postMessage: (message: unknown) => posted.push(message) };
  const tokens = new Map<string, string>();
  const root = {
    style: {
      colorScheme: "",
      setProperty: (name: string, value: string) => tokens.set(name, value),
      removeProperty: (name: string) => tokens.delete(name),
    },
    dataset: {} as Record<string, string>,
  };
  Object.assign(globalThis, {
    window: {
      parent,
      addEventListener: (_type: string, listener: (typeof listeners)[number]) =>
        listeners.push(listener),
    },
    document: { documentElement: root },
  });
  // A unique suffix gives every test its own module instance.
  loads += 1;
  const source = `${SCREEN_RUNTIME_SOURCE}\n// ${loads}`;
  const runtime = (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  )) as Runtime;
  const fromHost = (data: unknown) => {
    for (const listener of listeners) listener({ source: parent, data });
  };
  return { runtime, posted, tokens, root, fromHost };
};

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
});

describe("screen runtime", () => {
  it("greets the host on load and themes the page before the screen connects", async () => {
    const frame = await loadFramedRuntime();
    expect(frame.posted).toEqual([{ type: "t3-screen:hello" }]);

    const context = { placement: "panel", projectId: null, theme: { appearance: "dark" } };
    frame.fromHost({
      type: "t3-screen:init",
      context,
      tokens: { "--t3-color-canvas": "#000", "--app-theme-canvas": "#111" },
    });
    expect(Object.fromEntries(frame.tokens)).toEqual({ "--t3-color-canvas": "#000" });
    expect(frame.root.style.colorScheme).toBe("dark");
    expect(frame.root.dataset.t3Appearance).toBe("dark");
    expect((await frame.runtime.connect()).context).toEqual(context);
    expect(frame.posted).toHaveLength(1);
  });

  it("follows theme changes and drops tokens the host no longer sends", async () => {
    const frame = await loadFramedRuntime();
    frame.fromHost({
      type: "t3-screen:init",
      context: { placement: "panel", projectId: null, theme: { appearance: "dark" } },
      tokens: { "--t3-color-canvas": "#000", "--t3-font-size": "14px" },
    });
    frame.fromHost({
      type: "t3-screen:theme",
      appearance: "light",
      tokens: { "--t3-color-canvas": "#fff" },
    });
    expect(Object.fromEntries(frame.tokens)).toEqual({ "--t3-color-canvas": "#fff" });
    expect(frame.root.style.colorScheme).toBe("light");
    expect(frame.root.dataset.t3Appearance).toBe("light");
  });
});

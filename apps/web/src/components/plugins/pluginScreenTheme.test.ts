import { describe, expect, it } from "vite-plus/test";

import { screenThemeTokens } from "./pluginScreenTheme";

const T3_VALUES: Readonly<Record<string, string>> = {
  "--background": "#101010",
  "--card": "#141414",
  "--surface-raised": "#181818",
  "--popover": "#1c1c1c",
  "--foreground": "#f5f5f5",
  "--muted-foreground": "#a3a3a3",
  "--border": "#262626",
  "--input": "#303030",
  "--ring": "#4f46e5",
  "--primary": "#4f46e5",
  "--primary-foreground": "#ffffff",
  "--secondary": "#1f1f1f",
  "--secondary-foreground": "#f5f5f5",
  "--muted": "#1a1a1a",
  "--error": "#ef4444",
  "--error-foreground": "#fca5a5",
  "--error-surface": "#2a1414",
  "--warning": "#f59e0b",
  "--warning-foreground": "#fcd34d",
  "--warning-surface": "#2a2214",
  "--code-background": "#121212",
  "--code-foreground": "#e5e5e5",
  "--font-sans": "Inter, sans-serif",
  "--font-mono": "JetBrains Mono, monospace",
  "--radius": " 0.625rem",
  "--font-size-code": "13px",
  // T3-layout roles never reach a screen.
  "--sidebar": "#0c0c0c",
  "--toolbar-background": "#0d0d0d",
  "--terminal-background": "#000000",
  "--message-action": "#6366f1",
};

const read = (variable: string) => T3_VALUES[variable] ?? "";

describe("screenThemeTokens", () => {
  it("exposes the public t3.screens@0 token set and nothing layout-specific", () => {
    expect(screenThemeTokens(read, "15px")).toEqual({
      "--t3-color-canvas": "#101010",
      "--t3-color-surface": "#141414",
      "--t3-color-surface-raised": "#181818",
      "--t3-color-surface-overlay": "#1c1c1c",
      "--t3-color-text": "#f5f5f5",
      "--t3-color-text-muted": "#a3a3a3",
      "--t3-color-border": "#262626",
      "--t3-color-input": "#303030",
      "--t3-color-focus": "#4f46e5",
      "--t3-color-accent": "#4f46e5",
      "--t3-color-accent-foreground": "#ffffff",
      "--t3-color-secondary": "#1f1f1f",
      "--t3-color-secondary-foreground": "#f5f5f5",
      "--t3-color-muted": "#1a1a1a",
      "--t3-color-muted-foreground": "#a3a3a3",
      "--t3-color-error": "#ef4444",
      "--t3-color-error-foreground": "#fca5a5",
      "--t3-color-error-surface": "#2a1414",
      "--t3-color-warning": "#f59e0b",
      "--t3-color-warning-foreground": "#fcd34d",
      "--t3-color-warning-surface": "#2a2214",
      "--t3-color-code-background": "#121212",
      "--t3-color-code-foreground": "#e5e5e5",
      "--t3-font-sans": "Inter, sans-serif",
      "--t3-font-mono": "JetBrains Mono, monospace",
      "--t3-radius-sm": "calc(0.625rem - 4px)",
      "--t3-radius-md": "calc(0.625rem - 2px)",
      "--t3-radius-lg": "0.625rem",
      "--t3-font-size": "15px",
      "--t3-font-size-code": "13px",
    });
  });

  it("leaves out values T3 has not set, so base.css falls back instead of breaking", () => {
    const tokens = screenThemeTokens(() => "", "16px");
    expect(tokens).toEqual({ "--t3-font-size": "16px" });
  });
});

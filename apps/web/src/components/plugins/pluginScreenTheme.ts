/**
 * The theme a plugin screen wears: T3's resolved design variables, renamed to the public
 * `--t3-*` tokens that the screen runtime sets on the frame root and `_t3/base.css` uses.
 *
 * Tokens are part of `t3.screens@0`: they can be added, never removed or renamed. T3-layout
 * roles (sidebar, toolbar, terminal, message actions) stay internal.
 */

/**
 * Public token → the T3 variable it mirrors, read where the frame sits. Text, border and
 * input colors use the `--contrast-*` variants T3 paints with, so the contrast setting applies.
 */
const MIRRORED_TOKENS: ReadonlyArray<readonly [token: string, variable: string]> = [
  ["--t3-color-canvas", "--background"],
  ["--t3-color-surface", "--card"],
  ["--t3-color-surface-raised", "--surface-raised"],
  ["--t3-color-surface-overlay", "--popover"],
  ["--t3-color-text", "--contrast-foreground"],
  ["--t3-color-text-muted", "--contrast-muted-foreground"],
  ["--t3-color-border", "--contrast-border"],
  ["--t3-color-input", "--contrast-input"],
  ["--t3-color-focus", "--ring"],
  // T3's solid "act now" color, shared by its buttons, switches and send button.
  ["--t3-color-accent", "--primary"],
  ["--t3-color-accent-foreground", "--primary-foreground"],
  ["--t3-color-secondary", "--secondary"],
  ["--t3-color-secondary-foreground", "--contrast-secondary-foreground"],
  ["--t3-color-muted", "--muted"],
  ["--t3-color-muted-foreground", "--contrast-muted-foreground"],
  ["--t3-color-error", "--error"],
  ["--t3-color-error-foreground", "--error-foreground"],
  ["--t3-color-error-surface", "--error-surface"],
  ["--t3-color-warning", "--warning"],
  ["--t3-color-warning-foreground", "--warning-foreground"],
  ["--t3-color-warning-surface", "--warning-surface"],
  ["--t3-color-code-background", "--code-background"],
  ["--t3-color-code-foreground", "--code-foreground"],
  ["--t3-font-sans", "--font-sans"],
  ["--t3-font-mono", "--font-mono"],
  ["--t3-font-size-code", "--font-size-code"],
];

export type ScreenThemeTokens = Readonly<Record<string, string>>;

export interface ScreenTheme {
  readonly appearance: "light" | "dark";
  readonly tokens: ScreenThemeTokens;
}

/**
 * The tokens from T3's variables. `rootFontSize` is the interface text size, which the
 * screen's root takes too, so rem-based values mean the same inside the frame.
 */
export function screenThemeTokens(
  read: (variable: string) => string,
  rootFontSize: string,
): ScreenThemeTokens {
  const tokens: Record<string, string> = {};
  for (const [token, variable] of MIRRORED_TOKENS) {
    const value = read(variable).trim();
    if (value !== "") tokens[token] = value;
  }
  // Tailwind inlines T3's radius scale, so only its base is a variable.
  const radius = read("--radius").trim();
  if (radius !== "") {
    tokens["--t3-radius-sm"] = `calc(${radius} - 4px)`;
    tokens["--t3-radius-md"] = `calc(${radius} - 2px)`;
    tokens["--t3-radius-lg"] = radius;
  }
  tokens["--t3-font-size"] = rootFontSize;
  return tokens;
}

/** The theme at `frame`'s place in the page, so an environment's theme reaches its screens. */
export function readScreenTheme(frame: Element): ScreenTheme {
  const root = document.documentElement;
  const style = getComputedStyle(frame);
  return {
    appearance: root.classList.contains("dark") ? "dark" : "light",
    tokens: screenThemeTokens(
      (variable) => style.getPropertyValue(variable),
      getComputedStyle(root).fontSize,
    ),
  };
}

export function sameScreenTheme(a: ScreenTheme, b: ScreenTheme): boolean {
  if (a.appearance !== b.appearance) return false;
  const keys = Object.keys(a.tokens);
  return (
    keys.length === Object.keys(b.tokens).length &&
    keys.every((key) => a.tokens[key] === b.tokens[key])
  );
}

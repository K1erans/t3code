/**
 * Connects a plugin screen to T3 Code.
 *
 * This is only a loader: T3 serves the real runtime beside every screen at `./_t3/screen.js`,
 * so the bridge always matches the T3 that framed the screen. Outside T3 there is no
 * runtime to load, and `connect()` rejects.
 */

/** Where and for what the screen is shown. */
export interface ScreenContext {
  /** A `panel` screen is a right-panel tab beside a thread. */
  readonly placement: "panel";
  /** The project beside the screen, or null for an environment-scoped screen. */
  readonly projectId: string | null;
  /**
   * The appearance when the screen connected. T3 keeps the live theme on the page root
   * itself: `--t3-*` tokens, `color-scheme` and `data-t3-appearance`.
   */
  readonly theme: { readonly appearance: "light" | "dark" };
}

export interface T3Screen {
  readonly context: ScreenContext;
}

interface ScreenRuntime {
  readonly connect: () => Promise<T3Screen>;
}

export const NOT_IN_T3_MESSAGE = "This screen must run inside T3 Code";

// Screens are served from `/api/plugins/<token>/…`; the runtime sits at the token's root,
// so pages in subfolders find it too.
const SCREEN_ROUTE = /^(.*\/api\/plugins\/[^/]+\/)/;

let runtime: Promise<ScreenRuntime> | undefined;

const loadRuntime = async (): Promise<ScreenRuntime> => {
  const root =
    typeof window === "undefined" || window.parent === window
      ? undefined
      : SCREEN_ROUTE.exec(window.location.pathname)?.[1];
  if (root === undefined) throw new Error(NOT_IN_T3_MESSAGE);
  try {
    return (await import(
      /* @vite-ignore */ new URL(`${root}_t3/screen.js`, window.location.href).href
    )) as ScreenRuntime;
  } catch {
    throw new Error(NOT_IN_T3_MESSAGE);
  }
};

/** Resolves once T3 has handed the screen its context. Every call returns the same screen. */
export const connect = (): Promise<T3Screen> => {
  runtime ??= loadRuntime();
  return runtime.then((loaded) => loaded.connect());
};

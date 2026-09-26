/**
 * The screen SDK runtime, served to every screen at `./_t3/screen.js` under its signed
 * route. `@t3tools/plugin-sdk/screen` only loads this module and delegates to it, so the
 * bridge format stays private to T3 and ships with the host that speaks it.
 *
 * The server links it into every page, so it greets the host as soon as it loads and keeps
 * the host's theme on the root (`--t3-*` tokens, `color-scheme`, `data-t3-appearance`)
 * whether or not the screen calls `connect()`.
 *
 * The frame has an opaque origin, so it identifies its host by `event.source`, never by
 * `origin`. The host side is `PluginScreenFrame` in
 * `apps/web/src/components/plugins/PluginScreenPanel.tsx`.
 * Kept as plain JavaScript source so the server bundler never rewrites it.
 */
export const SCREEN_RUNTIME_SOURCE = `const NOT_IN_T3 = "This screen must run inside T3 Code";
const CONNECT_TIMEOUT_MS = 10000;
const framed = window.parent !== window;
let connection;
let resolveConnection;
let applied = [];

function applyTheme(appearance, tokens) {
  if (appearance !== "light" && appearance !== "dark") return;
  if (tokens === null || typeof tokens !== "object") return;
  const style = document.documentElement.style;
  const names = Object.keys(tokens).filter(
    (name) => name.startsWith("--t3-") && typeof tokens[name] === "string",
  );
  for (const name of applied) if (!names.includes(name)) style.removeProperty(name);
  for (const name of names) style.setProperty(name, tokens[name]);
  applied = names;
  style.colorScheme = appearance;
  document.documentElement.dataset.t3Appearance = appearance;
}

if (framed) {
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (data === null || typeof data !== "object") return;
    if (data.type === "t3-screen:theme") {
      applyTheme(data.appearance, data.tokens);
    } else if (data.type === "t3-screen:init") {
      // The host answers the greeting and the frame's load event, so init can come twice.
      applyTheme(data.context?.theme?.appearance, data.tokens);
      resolveConnection?.(Object.freeze({ context: Object.freeze(data.context) }));
      resolveConnection = undefined;
    }
  });
}

export function connect() {
  connection ??= new Promise((resolve, reject) => {
    if (!framed) {
      reject(new Error(NOT_IN_T3));
      return;
    }
    const timeout = setTimeout(() => {
      // Not cached: a later connect() greets the host again.
      resolveConnection = undefined;
      connection = undefined;
      reject(new Error(NOT_IN_T3));
    }, CONNECT_TIMEOUT_MS);
    resolveConnection = (screen) => {
      clearTimeout(timeout);
      resolve(screen);
    };
    window.parent.postMessage({ type: "t3-screen:hello" }, "*");
  });
  return connection;
}

// Theme the page straight away; a screen that never connects still looks like T3.
if (framed) connect().catch(() => {});
`;

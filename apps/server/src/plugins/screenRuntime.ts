/**
 * The screen SDK runtime, served to every screen at `./_t3/screen.js` under its signed
 * route. `@t3tools/plugin-sdk/screen` only loads this module and delegates to it, so the
 * bridge format stays private to T3 and ships with the host that speaks it.
 *
 * The frame has an opaque origin, so it identifies its host by `event.source`, never by
 * `origin`. The host side is `apps/web/src/components/plugins/PluginScreenFrame.tsx`.
 * Kept as plain JavaScript source so the server bundler never rewrites it.
 */
export const SCREEN_RUNTIME_SOURCE = `const NOT_IN_T3 = "This screen must run inside T3 Code";
const CONNECT_TIMEOUT_MS = 10000;
let connection;

export function connect() {
  connection ??= new Promise((resolve, reject) => {
    if (window.parent === window) {
      reject(new Error(NOT_IN_T3));
      return;
    }
    const onMessage = (event) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (data === null || typeof data !== "object" || data.type !== "t3-screen:init") return;
      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      resolve(Object.freeze({ context: Object.freeze(data.context) }));
    };
    const timeout = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error(NOT_IN_T3));
    }, CONNECT_TIMEOUT_MS);
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "t3-screen:hello" }, "*");
  });
  return connection;
}
`;

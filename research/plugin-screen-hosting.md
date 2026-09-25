# Hosting sandboxed plugin screens in every T3 connection mode

Ticket: https://github.com/K1erans/t3code/issues/4 (map: https://github.com/K1erans/t3code/issues/1)

Research only. Repo citations are against `main` at `d06f0ff104`. The upstream plugin stack (`feat/plugin-management-ui` and below) has no screen hosting. It touches Settings and the command palette, but has no iframe, HTTP route, or asset serving for plugin UI.

## TL;DR

- **The hard constraint is cross-origin auth.** From app.t3.codes (and desktop) a remote environment is authenticated by Bearer/DPoP headers attached per request. No cookie exists on the environment origin, and an `<iframe src>` navigation can't carry headers. Even if we set a cookie, Safari blocks third-party cookies in iframes and other browsers partition them. **An iframe's document and sub-resources must therefore be authorized by the URL itself** (a capability token in the path).
- **T3 already does exactly this for HTML previews.** Signed `/api/assets/<token>/<file>` URLs are loaded in `<iframe sandbox="allow-scripts …">` with a server-side `CSP: sandbox` header. They already work in every mode, including over the T3 Connect tunnel and inside desktop.
- **Recommendation:** serve plugin screen bundles from a new signed, directory-scoped route on the environment. Frame them with `sandbox` without `allow-same-origin`, which gives them an opaque origin. Carry every privileged call over a `postMessage`/`MessageChannel` bridge that the host proxies through its existing authenticated connection. No new origins, cookies, or relay changes are needed.

## How each mode reaches the environment today

| Mode                                                     | Client origin → env origin                                                                                                                                                                                                                             | HTTP auth                                                                                                                                                                                                                                                                              | WS auth                                                                                                    | Can an iframe load env URLs today?                                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vite dev                                                 | Same origin; Vite proxies `/api`, `/ws`, `/oauth`, `/.well-known` to the server (`apps/web/vite.config.ts:88-99, 240-257`)                                                                                                                             | Reusable dev cookie `t3_dev_session_<sha>` (`apps/server/src/auth/ReusableDevAuth.ts:12-31`) or the session cookie                                                                                                                                                                     | Cookie on upgrade                                                                                          | Yes, same origin. `/api/*` is proxied.                                                                                                                                                       |
| `npx t3` self-hosted                                     | Same origin; the server serves the web build (`apps/server/src/http.ts:650-653`)                                                                                                                                                                       | httpOnly `SameSite=Lax` session cookie (`apps/server/src/auth/http.ts:174-186`). The primary connection uses `credentials: include` with no auth header (`packages/client-runtime/src/connection/resolver.ts:80-88`, `state/environmentHttpAuth.ts:30-36`)                             | Cookie                                                                                                     | Yes, same origin.                                                                                                                                                                            |
| app.t3.codes → remote env (LAN https, Tailscale, tunnel) | Cross-origin                                                                                                                                                                                                                                           | Bearer (pairing) or DPoP (relay) tokens kept in IndexedDB `t3code:connection-runtime` (`apps/web/src/connection/storage.ts`). Headers are attached per request (`packages/client-runtime/src/authorization/service.ts:284-334`, `state/environmentHttpAuth.ts:42-79`). **No cookies.** | `POST /api/auth/websocket-ticket`, then `?wsTicket=` (`apps/server/src/auth/EnvironmentAuth.ts:1076-1095`) | Only token-in-URL resources. Signed assets already load this way.                                                                                                                            |
| Desktop (Electron)                                       | Renderer at `t3code://app` (`t3code-dev://app` in dev, which proxies to Vite) (`apps/desktop/src/electron/ElectronProtocol.ts:15-29, 153-196`). Local backend at `http://127.0.0.1:<port>`; remotes cross-origin                                       | Bearer token over IPC for local (`apps/web/src/environments/primary/desktopAuth.ts:3-17`). Bearer/DPoP for remotes (`apps/web/src/connection/platform.ts:220, 333-365`)                                                                                                                | wsTicket                                                                                                   | Yes. The CSP has `frame-src 'self' blob: http: https:` (`ElectronProtocol.ts:101`), with a comment that it exists for signed environment assets.                                             |
| Tailscale share                                          | `tailscale serve --https=<port>` (`packages/tailscale/src/tailscale.ts:275-360`). Dev `--share` maps only the web port and stays single-origin (`scripts/lib/dev-share.ts:164-181`)                                                                    | Same as Vite dev/self-hosted when opened directly. Same as the cross-origin row when added to app.t3.codes                                                                                                                                                                             | as left                                                                                                    | Yes                                                                                                                                                                                          |
| T3 Connect tunnel                                        | Each environment gets its own Cloudflare Tunnel hostname `<stage>-<16hex>.<zone>` (`infra/relay/src/deploymentConfig.ts:96-99`), with `httpBaseUrl https://host/` and `wsBaseUrl wss://host/ws` (`:112-118`). The relay Worker is a control plane only | DPoP headers; no cookies on the tunnel host                                                                                                                                                                                                                                            | wsTicket                                                                                                   | Yes. Ingress is catch-all to the env server (`infra/relay/src/environments/ManagedEndpointProvider.ts:566-572, 1049-1055`), so every path/method reaches it. The relay adds no header rules. |
| Mobile (out of scope for v0)                             | Native                                                                                                                                                                                                                                                 | Bearer/DPoP                                                                                                                                                                                                                                                                            | wsTicket                                                                                                   | Already renders env URLs in a WebView (`apps/mobile/src/features/files/WorkspaceFileWebPreview.tsx:26-28`), so the same URL scheme would carry over later.                                   |

Other relevant facts:

- **Mixed content.** Plain-http endpoints are classed `mixed-content-blocked` for the hosted web app (`packages/shared/src/advertisedEndpoint.ts:48-57`; `docs/user/remote-access.md:111-119`). Any environment app.t3.codes can reach is already https, so iframes from it are too. There's no extra constraint.
- **Nothing forbids framing.** No `X-Frame-Options` or `frame-ancestors` is set anywhere (server, relay, `apps/web/index.html`, Vercel config). The web app has no CSP, so `frame-src` is unrestricted on web. Desktop's CSP already allows http/https/blob frames.
- **The precedent: signed assets.**
  - `issueAssetUrl` mints HMAC-signed claims with a 1h TTL (`apps/server/src/assets/AssetAccess.ts:57-60, 700-718`).
  - `resolveAsset` verifies them with no session at all (`:723+`). `GET /api/assets/*` is routed at `apps/server/src/http.ts:375-420`.
  - The `workspace-file` claim is **directory-scoped** (`baseRelativePath`, `AssetAccess.ts:86-91, 404-410, 846-860`), so an HTML file's relative `./app.js`, `./style.css` and fonts resolve under the same token. Extensions are allow-listed (`:72-83`) and dot-segments rejected.
  - The client resolves URLs with `new URL(relativeUrl, httpBaseUrl)` (`packages/client-runtime/src/state/assets.ts:57-59`).
  - HTML responses get `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals` (`http.ts:55-59, 115-128`). The web frames them with the same sandbox tokens (`apps/web/src/components/files/BrowserDocumentFrame.tsx:12-38`).
- **CORS.** Production uses Effect's default wildcard origin with no credentials. With `devUrl` set, it uses an explicit allow-list: dev origin, desktop origins and `T3CODE_DEV_ALLOWED_ORIGINS`, with credentials (`apps/server/src/http.ts:234-257`, `httpCors.ts`).

## Web platform rules that decide the design

- **Opaque origin.** Omitting `allow-same-origin` puts the frame in "a special origin that always fails the same-origin policy", which blocks cookies/storage and some APIs. `allow-scripts` together with `allow-same-origin` on a same-origin frame "lets the embedded document remove the sandbox attribute". ([MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe))
  - This matters in Vite dev and `npx t3`, where environment URLs **are** the app's origin. There, a plugin frame with `allow-same-origin` could read the session cookie's effects, call `/api` with the user's cookie, and touch the app's storage.
- **CSP `sandbox` response header.** It applies the same sandbox to a document served directly, even if it's framed without the attribute or opened top-level. It is ignored in `<meta>`. ([MDN CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)) So the server, not the client, is the backstop.
- **Third-party cookies.** WebKit ITP "blocks all third-party cookies. There are no exceptions" except via the Storage Access API ([WebKit](https://webkit.org/tracking-prevention/)). Firefox and others partition cookies and storage by top-level site ([MDN state partitioning](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/State_Partitioning)). A cookie on the environment origin is therefore not a portable way to authorize an iframe embedded by app.t3.codes or `t3code://app`.
- **srcdoc/blob inherit the embedder's policy container (CSP)**, since they are local-scheme documents ([policy container explainer](https://github.com/antosart/policy-container-explained)). On desktop, `script-src` lacks `http:`/`https:`, so a srcdoc/blob screen could not load scripts from the environment and would have to inline everything.
- **postMessage from an opaque origin** arrives with `event.origin === "null"`. The host must identify the frame by `event.source` (its own `iframe.contentWindow`) and reply with `"*"`. Better: hand over a `MessageChannel` port once and talk only over the port. ([MDN postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage))
- **Electron custom schemes.** Web storage is disabled for non-standard schemes. `t3code` is registered `standard, secure, supportFetchAPI, corsEnabled, stream` (`ElectronProtocol.ts:119-145`; [Electron protocol](https://www.electronjs.org/docs/latest/api/protocol)). A plugin-specific custom scheme would be desktop-only, so it doesn't meet "every mode".

## Hard constraints

1. **Authorization must travel in the URL** (a path-embedded capability), not cookies or headers. This is forced by the cross-origin Bearer/DPoP modes plus third-party-cookie blocking.
2. **Plugin documents must run in an opaque origin.** Use both the iframe `sandbox` attribute without `allow-same-origin` and a server `CSP: sandbox …` header. This is forced by the same-origin modes (Vite dev, `npx t3`, Tailscale-direct), where the env origin _is_ the app origin.
   - Consequence: screens get no cookies, `localStorage`/`IndexedDB` (they throw or are unusable), or service workers. Persistent state goes through the SDK bridge to the plugin's backend.
3. **One origin per environment.** The tunnel gives each environment one hostname. `npx t3` and Tailscale serve one host:port. There is no per-plugin subdomain to hand out in all modes without relay/DNS/TLS work.
4. **Screens can't call the environment's API themselves.** They hold no credential, and must not be given the session's Bearer/DPoP key. Every privileged call is proxied by the host over its existing authenticated WS/RPC. Only static screen assets are fetched directly.
5. **The environment must be https for hosted web.** This is already enforced by `mixed-content-blocked`.

## Candidate approaches

### A. Signed plugin asset route plus a sandboxed iframe (recommended)

- The server mints a directory-scoped signed URL for a plugin's screen bundle root, e.g. `/api/plugins/<token>/<screenId>/index.html`.
  - Reuse the `AssetAccess` signing key and the `workspace-file` directory-scope and dot-segment rules, rooted at the installed plugin's screen `dist` directory.
  - Minting happens over the authenticated RPC, like `assetEnvironment.createUrl`.
- The client frames it with `new URL(rel, httpBaseUrl)` and `sandbox="allow-scripts allow-forms allow-modals"` (plus `allow-popups` only if needed; no `allow-same-origin`). This is the same as `BrowserDocumentFrame`.
- The server sends HTML with a stricter CSP than agent previews:
  - `sandbox allow-scripts …`
  - `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'`
  - `Referrer-Policy: no-referrer`, so the token doesn't leak.
  - `connect-src 'none'` makes the bridge the only way out. Whether plugins may `fetch` third-party URLs directly is an SDK decision, not a hosting one.
- The bridge: the host posts one `MessageChannel` port to `iframe.contentWindow` and accepts messages only from that window/port. The SDK in the frame speaks only over the port.
- **Works in every mode:**
  - Vite dev and `npx t3`: same origin, but opaque by sandbox.
  - app.t3.codes → LAN https, Tailscale or tunnel: the catch-all ingress already serves `/api/*`.
  - Desktop: `frame-src http: https:` already allows it.
  - Mobile later: the WebView loads the same URL.
- **Traps to verify in the prototype:**
  - **Module scripts and fonts are CORS-mode fetches.** From an opaque origin they send `Origin: null`. Production's wildcard CORS covers this, but **dev CORS uses an explicit allow-list with credentials and would not match `null`** (`http.ts:244-252`). The plugin route should set its own `Access-Control-Allow-Origin: *` without credentials. That's safe because the URL is the capability. Alternatively, ship classic (non-module) bundles.
    - Inference from the Fetch spec plus the code. Verify first.
  - **Token TTL.** Assets expire after 1h. A long-open screen that lazy-loads chunks later needs either a longer screen TTL or a host-driven re-mint and reload. Plugin versions are immutable per install, so a longer TTL plus a version in the claims is reasonable.
  - **Revocation.** A signed URL outlives a disabled plugin. The resolver should check that the plugin is still enabled and matches the installed version at request time.
  - **The Vite dev proxy** only forwards the four prefixes, so the route must live under `/api` (as proposed).
- **Tradeoffs:**
  - Plus: no new origins, cookies, relay changes or desktop CSP changes. Reuses a pattern already shipping in all modes. Normal browser caching and relative imports work. The dev loop is just rebuild and reload the frame.
  - Minus: a bearer capability sits in the URL (mitigated by short scope, no-referrer, and enabled-check). Opaque origin means no web storage for screens.

### B. The host fetches the bundle over RPC and injects it (`srcdoc` or `blob:` with `sandbox`)

- The host pulls the screen's HTML/JS/CSS over the authenticated WS and renders `<iframe sandbox="allow-scripts" srcdoc=…>` (or a blob URL).
- Plus: no HTTP route, no token in any URL, no CORS questions. Works anywhere the WS works.
- Minus:
  - The frame inherits the **app's** CSP. On desktop that allows only inline scripts, so plugins must ship one fully inlined bundle.
  - On web there's no app CSP, so the host can't tighten the policy per plugin.
  - Relative asset URLs don't work (the base URL is the embedder's). Images and fonts must be data URIs.
  - The whole bundle crosses the WebSocket on every open, which works against the performance rule on remote links.
  - Poor dev loop.
- A reasonable fallback only if a route is rejected.

### C. Separate origin per plugin or for plugins (subdomain/port)

- A real separate origin would let screens keep `allow-same-origin` and have their own storage.
- Not available in all modes:
  - The tunnel issues one hostname per environment, and a second one needs relay, DNS and TLS work.
  - `npx t3` on a LAN and Tailscale serve expose one host:port. A second port needs another `tailscale serve` mapping and TLS name.
  - Vite dev is single-origin by rule.
- Also brings cookie/partitioning questions back. **Rejected for v0.** Revisit only if a plugin truly needs origin-scoped web storage or service workers, and even then the bridge-backed storage from A likely suffices.

## What this means for the SDK (hosting-level only)

- The screen SDK is a thin client over a single `MessagePort`. The host owns auth, reconnection and environment routing, and forwards to the plugin's backend and allowed T3 operations.
- Theme and tokens (an open map item) cross the same port, e.g. as CSS variables on init. The frame cannot read the host's stylesheets.
- Manifest needs: a screen entry path relative to the plugin's screen build directory. Nothing mode-specific.
- Per-mode code paths: none beyond what `httpBaseUrl` already abstracts.

## Sources

- Repo files as cited inline (`main` @ `d06f0ff104`).
- MDN `<iframe>` sandbox: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe
- MDN CSP `sandbox`: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox
- MDN CSP `frame-src`: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-src
- MDN `postMessage`: https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage
- MDN state partitioning: https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/State_Partitioning
- WebKit tracking prevention: https://webkit.org/tracking-prevention/
- Policy container explainer (srcdoc/blob CSP inheritance): https://github.com/antosart/policy-container-explained
- Electron `protocol`: https://www.electronjs.org/docs/latest/api/protocol

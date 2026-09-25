# T3 plugin SDK v0 spec

Status: complete and ready to build. Compiled from the wayfinder map [Wayfinder: T3 plugin SDK v0 spec](https://github.com/K1erans/t3code/issues/1). Each section links the ticket that holds the full decision and its reasoning. If this document and a ticket disagree, the ticket wins; later tickets supersede earlier ones where noted.

Reference plugin: **task board.** It saves cards through its backend, creates threads from cards, and shows turn progress. Prototype: [`prototype/task-board-plugin`](https://github.com/K1erans/t3code/tree/prototype/task-board-plugin/prototypes/task-board-plugin) (note that some details were revised by later tickets, as below).

## 0. Principles

- **Trust model follows VS Code.** Plugin server code is fully trusted, so enabling a plugin means trusting it. Screens run in isolated frames and reach T3 only through the SDK. T3 internals (React components, stores) are never exposed.
- **Performance first.** Users without plugins pay nothing, and plugins can't flood the WebSocket that carries agent turns.
- **Every connection mode.** Local, `npx t3`, LAN, Tailscale and T3 Connect all work the same way. Mobile only declares supported surfaces in v0.
- **Experimental until proven.** Capabilities are `@0` until a separate host process exists and a second, different plugin validates the SDK.

## 1. Foundation: port, don't rebase

Decision: [Build on the existing plugin branch stack or restart?](https://github.com/K1erans/t3code/issues/5), with evidence from [What does the existing plugin branch stack give us?](https://github.com/K1erans/t3code/issues/2).

- Port `upstream/feat/plugin-management-ui` onto a fresh branch from `main`:
  - **Keep:** `packages/plugin-runtime` (the Effect-scope reconciler with rollback), `PluginPackageManager` (discovery, cache-copy reload, one-at-a-time enable with rollback), the fixed plugin RPCs, the client-runtime atoms, Settings → Plugins, and the palette helpers.
  - **Re-apply by hand** the ~8 wiring points against current `main`.
- **Repurpose `requires`/`provides` as versioned host capabilities** (`t3.commands@N`, `t3.screens@N`, `t3.threads@N`, `t3.storage@N`). They serve as both the compatibility check and the gate on what the SDK exposes to each plugin. Plugin-to-plugin dependencies stay unexposed.
- **Manifest trim:** remove `mobileCards`, `permissions`, and the `views`/`settings` placeholders. `entrypoints.server` becomes optional. Drop the `runtime-status` example.
- **Land as small PRs, foundation first.** Upstream closed pingdotgg/t3code#8014 (>16k lines) for size.

## 2. Where plugin code runs

Decision: [Run plugin server code in-process or in a separate plugin host process?](https://github.com/K1erans/t3code/issues/6)

- **v0 runs in-process** in the existing Effect runtime, with one scope per plugin.
- **Process-ready contract:** every SDK call is async, and everything that crosses the boundary is JSON. No shared references and no synchronous callbacks into T3.
- **A separate host process is required before the SDK leaves experimental.**
- **Per-plugin containment:** one wrapper around every entry point (activate, commands, backend handlers, dispose). A throw, a rejection or a timeout marks only that plugin `error` and disposes its scope.
- **Failure reason** is stored in `PluginPackageStatus.error` as `<entry point> <threw|rejected|timed out>: <message>`. Stack traces go to the server log only.
- **Accepted until the host process exists:** a synchronous infinite loop freezes the server, and errors from a plugin's detached timers or promises may not be attributed to it.

## 3. Manifest (`t3-plugin.json`)

Decisions: [Write the task-board plugin as its author would](https://github.com/K1erans/t3code/issues/7), [Which contribution points and T3 operations does SDK v0 expose?](https://github.com/K1erans/t3code/issues/9), [What is the lifecycle, versioning and compatibility policy?](https://github.com/K1erans/t3code/issues/11)

```json
{
  "manifestVersion": 1,
  "id": "com.example.task-board",
  "name": "Task board",
  "icon": "./icon.svg",
  "version": "0.1.0",
  "requires": ["t3.screens@0", "t3.storage@0", "t3.threads@0"],
  "surfaces": ["web", "desktop"],
  "activationEvents": ["onTurnStateChange"],
  "entrypoints": { "server": "./dist/server.js" },
  "contributes": {
    "commands": [{ "id": "taskBoard.something", "title": "Task board: something" }],
    "screens": [
      { "id": "board", "title": "Task board", "entry": "./dist/screen/index.html",
        "placement": "panel", "scope": "project" }
    ]
  }
}
```

- **`apiVersion` is dropped.** `manifestVersion` covers the file format, and `requires` is the only compatibility check.
- **`placement`:** `panel` | `page` | `settings`. **`scope`:** `project` | `environment`.
- **`activationEvents`:** `onTurnStateChange` | `onStartup` (discouraged). Opening a screen and running a command are implicit triggers.

## 4. Contributions and T3 operations

Decision: [Which contribution points and T3 operations does SDK v0 expose?](https://github.com/K1erans/t3code/issues/9), building on [Write the task-board plugin as its author would](https://github.com/K1erans/t3code/issues/7).

**Contributions**
- **Commands:** argument-free palette commands that return a toast, with the current project in the call context. No command input and no `when` clauses.
- **Screens:**
  - `panel`: a new right-panel surface kind, `plugin:<pluginId>/<screenId>`, in the panel's tab menu. Its project is the thread or draft beside it.
  - `page`: the route `_chat.plugins.$environmentId.$pluginId.$screenId?project=<projectId>`, with a host-owned project picker for `scope: "project"` that defaults to the last active thread's project.
  - `settings`: under Settings → Plugins → \<plugin\>.
  - Every screen gets a host-generated **"Open \<title\>"** palette entry that follows its placement. Labels are static; state-dependent wording ("Start task board") belongs in the screen's own empty state.
- **Sidebar:** one **"Plugins"** item in the utility row (`SidebarChrome.tsx`), shown only when an enabled plugin has a page screen. It opens a menu of plugin pages.

**Server operations** (`activate(t3)`)
- `projects.list()`, `projects.get(id)`: id, name, folder.
- `threads.create({ projectId, title, prompt, model?, runtimeMode?, interactionMode?, worktree? })`. Anything left out falls back to the project's effective defaults (`defaultModelSelection`, `defaultRuntimeMode`, `defaultThreadEnvMode`). With no model given and no project default, it fails with a clear error.
- `threads.get(id)`: title, project, turn state.
- `threads.onTurnStateChange(listener)`: `idle | running | completed | interrupted | error`.
- `backend.define({...})` / `backend.emit(topic, payload, { projectId? })`; see §5.
- `commands.register`, `storage`, `dataDir`, `log`, `onDispose`.

**Screen UI actions:** `ui.openThread(threadId)`, `ui.toast(message, tone)`, and `ui.pickThreadOptions({ projectId })`, which opens T3's own model and mode picker prefilled with the project's defaults and returns the choice as JSON for the backend's `threads.create`.

**Excluded from v0:**
- keybindings; command input; `when` clauses;
- context menus, the thread header, status indicators, and message or sidebar decorations;
- reading transcripts or messages, sending follow-ups, interrupting or stopping turns, archiving or deleting;
- diffs, terminals, the file system through T3, git;
- changing project or T3 settings;
- agent tools / MCP servers; new providers;
- plugin-to-plugin dependencies;
- mobile screens.

## 5. Screens: hosting and bridge

Decisions: [How can sandboxed plugin screens be served in every T3 connection mode?](https://github.com/K1erans/t3code/issues/4), [How do screens talk to their plugin server and to T3?](https://github.com/K1erans/t3code/issues/8), [Which contribution points and T3 operations does SDK v0 expose?](https://github.com/K1erans/t3code/issues/9)

**Hosting**
- Screens are served from **signed, directory-scoped `/api/plugins/<token>/…` URLs**, mirroring the existing HTML-preview asset path, which works in every mode.
- The iframe is sandboxed **without `allow-same-origin`**, and the server adds a `CSP: sandbox` header. That gives the screen an opaque origin, with no T3 cookies, storage or credentials.
- One **`MessageChannel` port** per frame. The host identifies the frame by its window, never by `origin`.
- The route sets its own `Access-Control-Allow-Origin: *` without credentials, because module scripts from opaque origins send `Origin: null`. The resolver checks at request time that the plugin is still enabled and at the right version.
- **Screen CSP:**
  - `script-src 'self' 'wasm-unsafe-eval'`;
  - `connect-src 'self' https: wss:`;
  - `img-src` / `media-src` / `font-src` add `https: data: blob:`;
  - `Referrer-Policy: no-referrer`.

  This matches T3's own CSPs and HTML previews. Docs recommend going through the backend for anything on the environment's network.

**Data model**
- **Screens only talk to their own plugin's backend,** plus the UI actions. They never read T3 data directly.

**Typing**
- **Every backend method declares required [Standard Schema](https://standardschema.dev) `input` and `output` schemas,** and every event topic declares a payload schema. Any library works (Zod, Valibot, ArkType, Effect Schema).
- The host validates input before the handler runs and returns `PluginInputInvalid` otherwise.
- Screens get inferred types with `connect<typeof backend>()` from a type-only import.

**Transport:** two fixed RPCs in `packages/contracts`:
- `plugins.call { pluginId, screenId, method, input, context }` needs `orchestration:operate`. It returns JSON, or one of `PluginNotActive`, `PluginInputInvalid`, `PluginHandlerFailed`, `PluginHandlerTimedOut`, `PluginPayloadTooLarge`, `PluginConnectionLost`.
- `plugins.subscribe { pluginId, screenId, topic, context, afterSequence? }` needs `orchestration:read`, and is filtered on the server by `context.projectId`.
- **The host fills in `context`, never the frame.** The server checks that the project exists.

**Reconnects: resubscribe transparently, plus bounded replay**
- Streams resubscribe automatically through the existing client-runtime session and wake-up machinery.
- Every event gets a sequence number. The server keeps a buffer per plugin × topic × scope: the last 256 events or 60 s, whichever is smaller, in memory. On resubscribe, the server replays the gap.
- If the gap is out of the buffer, the server restarted, or the plugin reloaded, `t3.onResync(cb)` fires and the screen refetches.
- Dropped calls fail with `PluginConnectionLost` and are **never retried**.

**Environment**
- A screen belongs to exactly one environment: a panel's comes from its thread, a page's from the URL. All its traffic goes over that environment's session.
- The same plugin on two environments is two independent plugins.

**Screen SDK**
- **T3 serves the only runtime** at `./_t3/screen.js` under the screen's signed route. The bridge format is private to T3.
- `@t3tools/plugin-sdk/screen` on npm is a **thin loader** that only loads and delegates, with no protocol logic. Outside T3 it fails with *"This screen must run inside T3 Code"*.
- Screen API:
  - `connect()` returns `context` (placement, projectId, theme);
  - `call`, `on`, `onResync`, `onContextChange`, `getState`/`setState`;
  - `ui.*`.

**Limits and performance rules**
- **Size caps:** 1 MB per `call` input or output, and 256 KB per `emit`. Anything bigger fails with `PluginPayloadTooLarge`.
- **Event batching:** events are **batched about every 50 ms, in order, with nothing dropped** (no coalescing).
- **No cost without plugins:**
  - the bridge, frame host and plugin route are **code-split**, so users without plugins pay nothing;
  - there's no plugin traffic unless a screen is open;
  - a test pins this "no plugins = no subscriptions or messages" behaviour.
- **Hidden screens and timeouts:** hidden screens pause their subscriptions, and calls time out after about 30 s (`PluginHandlerTimedOut`).
- **Client side:**
  - frame chrome has no continuous animations;
  - messages are structured-cloned JSON, never base64;
  - assets are immutable and long-cached per plugin version.
- **Observability:** spans on every `plugins.call` and emit batch (plugin id, method or topic, bytes, duration).
- **Not doing:** SIMD, and per-plugin CPU or memory measurement (that needs the host process).

## 6. Screen look and feel

Decision: [How do screens get T3's theme and design tokens?](https://github.com/K1erans/t3code/issues/13)

- **Screens look like T3 Code by default.** The host injects `./_t3/base.css` automatically. It styles plain HTML using only variables, with no animations.
- **About 25 live `--t3-*` tokens,** inherited from T3's current theme (built-in, custom or environment; light or dark):
  - `--t3-color-canvas`, `surface`, `surface-raised`, `surface-overlay`, `text`, `text-muted`, `border`, `input`, `focus`, `accent`/`-foreground`, `secondary`/`-foreground`, `muted`/`-foreground`, `error`/`-foreground`/`-surface`, `warning`/`-foreground`/`-surface`, `code-background`, `code-foreground`;
  - `--t3-font-sans`, `--t3-font-mono`, `--t3-radius-sm/md/lg`;
  - `--t3-font-size` (interface) and `--t3-font-size-code`. `base.css` sets the root font size, so `rem` units scale.
- The SDK also sets `color-scheme` and `data-t3-appearance`.
- **T3-layout roles stay internal:** sidebar, toolbar, terminal and message actions. Tokens can be added later but not removed within a major version.
- **No UI kit in v0.**

## 7. Storage

Decision: [Who owns plugin data persistence?](https://github.com/K1erans/t3code/issues/10)

- Each plugin gets **`<stateDir>/plugin-data/<pluginId>/`**, never `state.sqlite`:
  - a key-value store, `storage.get/set/delete/update`, with JSON values up to 1 MB each, backed by `storage.sqlite` in that folder;
  - `t3.dataDir` (that same folder), for files or the plugin's own SQLite database.
- **`storage.update(key, fn)`** runs updates to the same key one after another inside the plugin's process. Keep `fn` quick and pure.
- **Disable and reload keep data** (reload replaces the `plugin-cache/` copy only).
- **Uninstall:** the first discovery that notices the plugin missing starts a **30-day countdown**, then the folder is deleted. Reinstalling clears the countdown.
- **Settings → Storage → "Plugin data"** lists every plugin, shows "Deletes in N days" and a **Delete data** button for leftovers, and calculates sizes **only when "Calculate sizes" is pressed**.
- **Migrations are the plugin's own job.** The same plugin on two environments has two stores.

## 8. Lifecycle and compatibility

Decision: [What is the lifecycle, versioning and compatibility policy?](https://github.com/K1erans/t3code/issues/11)

**Versioning and compatibility**
- **`@0` means experimental:** it may break between T3 releases, and Settings labels such plugins "Experimental API". Leaving experimental (host process plus second-plugin validation) means moving to **`@1`**, and after that nothing breaks within a major.
- **A missing capability** fails activation with: *"Needs t3.screens@2; this T3 provides t3.screens@1. Update T3 or use an older version of the plugin."*
- **When a breaking `@N+1` ships,** `@N` keeps working for **at least 6 months**, with an *"Older API, stops working in T3 X.Y"* warning.

**Activation and shutdown**
- **Lazy activation:** implicit on the first screen call or subscription, or the first command, plus `onTurnStateChange` (the host holds the triggering event and delivers it after `activate`) and `onStartup`. Triggering calls wait for activation.
- **Idle shutdown after 10 minutes** with no calls, subscriptions, commands or trigger events. An open screen counts as activity. Shutdown disposes the scope, and module code stays loaded while plugins run in-process.

**Screens across state changes**
- **Reload rebuilds open frames** with fresh URLs.
- **Stopped states show a placeholder with a way back:** disabled shows **Enable**, removed shows "not installed", and failed shows the reason and **Reload**.
- **Hidden frames are destroyed** and recreated when shown. `getState`/`setState` (per frame session, cleared on reload) restores UI state instantly. There's no `retainWhenHidden`.

## 9. Install and Settings

Decision: [What are the install scope and the local install flow?](https://github.com/K1erans/t3code/issues/12)

**Installing**
- **Install and enable state belongs to the environment,** shared by every client connected to it.
- **Local install only.** Copy a folder into `<stateDir>/plugins/`, or use:
  - `t3 plugin install <folder | file.tgz>`: validates, then installs atomically (temporary folder, then rename), replacing on update;
  - `t3 plugin remove <id>`: starts the 30-day data countdown.

  No npm package names and no browser upload.

**Noticing changes**
- The server **watches the top level of `plugins/`** (debounced):
  - new plugins appear disabled;
  - an enabled plugin whose folder changed reloads automatically;
  - a removed plugin shows "not installed".
- **Rescan** is the fallback.

**Settings → Plugins**
- Covers every environment, using the machine selector that Settings → Projects already has.
- **Each row:** name, icon, version and id; status (Active, Idle, Disabled, Error with its reason, plus Experimental or Older API); Enable, Reload, "Manage data" (links to Storage).
- **The page:** search; Rescan; a discovery-errors section; an empty state showing the CLI command.
- **`enabledPluginIds` moves out of `ServerSettings`** into the plugin status RPC and subscription.

## 10. Authoring

Decisions: [What is the plugin author's build and dev loop?](https://github.com/K1erans/t3code/issues/14), [Where do plugin author docs live, and what is the minimum?](https://github.com/K1erans/t3code/issues/15)

**Build and dev loop**
- **Build output** is a plain folder: the manifest, an ESM server entry, and static screen files. There's no T3 build command.
- **`@t3tools/plugin-sdk`:** types, `definePlugin` (a typed identity function) and the thin screen loader.
- **The template is `examples/plugins/task-board`:** Vite for screens and esbuild for the server, with `npm run build` and `npm run dev`. Authors copy it. It's also the reference plugin and a test fixture.
- **The dev loop is rebuild, then `t3 plugin install ./dist`.** T3's folder watch reloads the plugin and refreshes open screens.
- **Not in v0:** a dev-folder link, symlinks, a scaffolder, or a mock host. Screens are developed inside T3.

**Docs**
- **Author docs:** the template README plus the SDK README. TSDoc on the types is the API reference.
- **User docs:** `docs/user/plugins.md`.
- **Maintainer docs:** a short `docs/internals/plugins.md` covering only the cross-component *why*.

The required content for each is listed in the docs ticket.

## 11. Suggested PR sequence

Each PR makes one more piece of the task board work (see §1):

1. **Foundation port.** Runtime, package manager, capabilities as `@0`, trimmed manifest, `apiVersion` dropped, containment wrapper with failure reasons, lazy activation and idle shutdown, commands, Settings → Plugins (every environment, names, search), `enabledPluginIds` moved out of `ServerSettings`.
2. **Install flow.** `t3 plugin install/remove`, the folder watch with auto-reload, and Rescan.
3. **Storage.** `plugin-data/`, the key-value store with `update`, `dataDir`, the 30-day countdown, and Settings → Storage → Plugin data.
4. **Screen hosting.** The signed route, sandboxed frame, CSP, host-served `screen.js` and `base.css`, theme tokens, the three placements, the sidebar "Plugins" item, "Open …" palette entries, and placeholders.
5. **Bridge.** `plugins.call` and `plugins.subscribe`, Standard Schema validation, scoped emit, batching, caps, replay and `onResync`, `getState`/`setState`, spans, and the no-plugin-cost test.
6. **Thread access.** `projects.*`, `threads.*`, `onTurnStateChange` activation, and `ui.pickThreadOptions`.
7. **Task-board example and docs.** Template, SDK package, and the user and internals docs.

## Out of scope for v0

- plugin catalog, marketplace, registry, remote install;
- mobile screen hosting;
- sandboxing plugin server code;
- keybindings;
- actually validating the SDK with a second plugin, which is the exit criterion for `@1`, not part of v0.

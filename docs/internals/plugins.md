# Plugins

Local plugin packages are managed by
[`PluginPackageManager`](../../apps/server/src/plugins/PluginPackageManager.ts) on top of the
[plugin runtime](../../packages/plugin-runtime/src/runtime.ts). The product decisions live in the
plugin SDK v0 spec; this page records the constraints a maintainer would otherwise get wrong.

## Trusted and in-process until @1

Plugin server code runs inside the server process, one Effect scope per plugin. Every call into
plugin code (activate, commands, dispose) goes through one guard that turns a throw, rejection or
timeout into a readable reason and marks only that plugin failed. The guard cannot stop a
synchronous infinite loop, attribute errors from a plugin's detached timers, or unload code: Node
never unloads ES modules, so every load of a package stays in memory until restart. That is why
rescans skip a folder whose fingerprint has not changed since its last load or failed load.

A separate plugin host process is required before any capability leaves `@0`. Until then keep the
contract process-ready: every SDK call async, and only JSON crossing the boundary.

## Capabilities are the compatibility check

A manifest's `requires` lists versioned host capabilities such as `t3.commands@0`. A plugin that
requires one this T3 does not provide fails activation with a reason naming both sides; there is no
separate API version. `@0` means experimental and may break between releases. After `@1`, a breaking
change means a new major, and the old one stays working until the version recorded in
`DEPRECATED_CAPABILITIES`, which Settings shows as "Older API".

## Commands run outside every lock

The runtime serializes reconcile and dispose, and the manager serializes enable, disable, reload
and rescan. Command invocations and `pluginPackages.status` take neither lock. A command can run for
up to the entry point timeout, and holding a lock that long would stall every other command, every
lifecycle action and every client's Settings, including remote and mobile ones.

The consequence is that a reload or disable can commit while a command of the retiring version is
still running. The new version serves invocations at once, but the old version's scope, and so its
`onDispose` handlers, closes only after its running commands finish, so a command never resumes
with closed resources. That wait holds the lifecycle locks for at most the entry point timeout;
other plugins' commands and status are unaffected. A command's failure is attributed by definition
identity: only a failure from the version that is still active marks the package failed or retires
it. A disposed runtime starts no new invocations.

For the same reason, plugins never delay server startup. Enabled packages load in a background
rescan and show as Starting until they do.

## Loaded is not active

An enabled package is imported once per version and stays loaded; activation only creates and
disposes its scope. Startup and rescans load packages without activating them, except `onStartup`
ones. Running a command activates its plugin first, under the manager lock, so concurrent callers
wait for one activation. After ten minutes with no command running or finishing, the plugin's scope
is disposed and the next command activates the same loaded code again, since re-importing would
leak a module copy each time. Enable and Reload activate at once so a broken `activate` shows
immediately and a failed reload keeps the previous version live.

The palette lists commands and screens from manifests, not from registrations, so an idle plugin's
commands appear and the catalog generation clients hold changes only when the listed commands or
screens do. A screen carries its load revision, so a reload changes the generation too.
Activation and idle shutdown never invalidate an open palette. The runtime's own generation is
internal, and command ids must be unique across enabled plugins because nothing is registered yet
when they are listed.

## Screens are authorized by their URL

A remote client authenticates each request with headers an `<iframe src>` cannot send, and a cookie
on the environment would be a blocked third-party cookie there. So a screen loads from a signed
`/api/plugins/<token>/…` URL minted over the WebSocket, like HTML previews in
[`AssetAccess`](../../apps/server/src/assets/AssetAccess.ts). The token names a plugin screen and
the load revision it was minted for; every request re-checks both against the loaded plugin, so a
disable or reload revokes URLs already handed out. In Vite dev and `npx t3` the environment is the
app's own origin, which is why screens must never get `allow-same-origin`: the CSP `sandbox` header
and the iframe attribute both give them an opaque origin. Screens are static files and never
activate their plugin.

## Mobile in v0

Commands declare `surfaces`, which may include `mobile`, but the mobile app has no command palette
or plugin UI yet. The field is declarative only; plugin UI on mobile is later work in the spec.

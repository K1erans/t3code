# Plugins

Plugins are trusted local code that runs inside an environment's server. They are installed per
environment, on the machine that runs it, and every client connected to that environment sees the
same plugins.

## Installing and removing

Run these on the environment's machine, locally or over SSH:

```bash
t3 plugin install ./dist            # a plugin folder containing t3-plugin.json
t3 plugin install ./my-plugin.tgz   # or a packed .tgz, such as npm pack output
t3 plugin remove com.acme.tasks     # by plugin id
```

Installing a plugin that is already installed replaces it. Pass `--base-dir` to target an
environment with a custom data directory. npm package names and uploads from a browser are not
supported.

A running server picks up changes without a restart. New plugins appear disabled in
**Settings → Plugins**; enable them there. An enabled plugin reloads when you reinstall it, and if
you remove it, it shows as not installed until you install it again. A removed disabled plugin
simply leaves the list. If a change does not show up, use **Rescan** in Settings → Plugins.

## Plugin data

Data a plugin saves survives disabling, reloading and reinstalling. When you remove a plugin, its
data is kept for 30 days in case you install it again, then deleted automatically.
**Settings → Storage → Plugin data** lists every plugin's data on the environment, shows when
leftovers will be deleted, and lets you delete them sooner. Sizes are measured only when you press
**Calculate sizes**.

## Active and idle

An enabled plugin starts when you run one of its commands and stops again after ten minutes
without use, so plugins do not run in the background while you are not using them. **Settings → Plugins**
shows each one as **Active** or **Idle**; an idle plugin's commands stay in the command palette.

## Screens

Some plugins add screens. Open one beside a thread from the **+** menu in the right panel, under
**Plugins**, or run **Open** followed by the screen's name from the command palette. A screen shows the thread's
project, and works the same whether you are on this machine or connected remotely.

If a screen's plugin is disabled, fails or is removed, its tab shows why instead, with **Enable** or
**Reload** where that fixes it. Reinstalling or reloading a plugin refreshes its open screens.

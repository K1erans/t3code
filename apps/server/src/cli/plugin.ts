/**
 * `t3 plugin` - install and remove local plugin packages in the environment's
 * `plugins/` folder. A running server watches that folder, so changes land
 * without a restart. Only local folders and `.tgz` files are accepted.
 */
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Argument, Command } from "effect/unstable/cli";

import * as ServerConfig from "../config.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { installPlugin, removePlugin } from "../plugins/PluginInstall.ts";
import { authLocationFlags, type CliAuthLocationFlags } from "./config.ts";

const envT3Home = Config.String("T3CODE_HOME").pipe(Config.option);
const envDevUrl = Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option);

/**
 * Resolves the `plugins/` folder the matching server watches: --base-dir, then
 * T3CODE_HOME, then the default home; a dev URL (--dev-url or
 * VITE_DEV_SERVER_URL) without an explicit home selects the dev state, as it
 * does for the server.
 */
export const resolvePluginsDirectory = Effect.fn(function* (flags: CliAuthLocationFlags) {
  const path = yield* Path.Path;
  const envHome = Option.filter(yield* envT3Home, (value) => value.trim().length > 0);
  const configuredBaseDir = Option.orElse(flags.baseDir, () => envHome);
  const flagDevUrl = flags.devUrl ?? Option.none();
  const devUrl = Option.isSome(flagDevUrl) ? flagDevUrl : yield* envDevUrl;
  const baseDir = yield* resolveBaseDir(Option.getOrUndefined(configuredBaseDir));
  const derivedPaths = yield* ServerConfig.deriveServerPaths(
    baseDir,
    Option.getOrUndefined(devUrl),
    { baseDirIsExplicit: Option.isSome(configuredBaseDir) },
  );
  return path.join(derivedPaths.stateDir, "plugins");
});

const pluginInstallCommand = Command.make("install", {
  ...authLocationFlags,
  source: Argument.String("source").pipe(
    Argument.withDescription("A plugin folder (containing t3-plugin.json) or a .tgz file."),
  ),
}).pipe(
  Command.withDescription("Install or update a plugin from a local folder or .tgz file."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const pluginsDirectory = yield* resolvePluginsDirectory(flags);
      const source = yield* expandHomePath(flags.source.trim());
      const installed = yield* installPlugin({ pluginsDirectory, source });
      const { id, version } = installed.manifest;
      yield* Console.log(
        installed.replaced
          ? `Updated ${id} to ${version}. A running T3 server reloads it if it is enabled.\n`
          : `Installed ${id} ${version} into ${installed.directory}. Enable it in Settings → Plugins.\n`,
      );
    }),
  ),
);

const pluginRemoveCommand = Command.make("remove", {
  ...authLocationFlags,
  id: Argument.String("id").pipe(Argument.withDescription("The plugin id, e.g. com.acme.tasks.")),
}).pipe(
  Command.withDescription("Remove an installed plugin's code."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const pluginsDirectory = yield* resolvePluginsDirectory(flags);
      yield* removePlugin({ pluginsDirectory, id: flags.id.trim() });
      yield* Console.log(`Removed ${flags.id.trim()}.\n`);
    }),
  ),
);

export const pluginCommand = Command.make("plugin").pipe(
  Command.withDescription("Install and remove local plugins."),
  Command.withSubcommands([pluginInstallCommand, pluginRemoveCommand]),
);

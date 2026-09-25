import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { resolvePluginsDirectory } from "./plugin.ts";

const devUrl = new URL("http://localhost:5733");

const resolveWith = (env: Record<string, string>, flags: { baseDir?: string; devUrl?: URL } = {}) =>
  resolvePluginsDirectory({
    baseDir: Option.fromUndefinedOr(flags.baseDir),
    devUrl: Option.fromUndefinedOr(flags.devUrl),
  }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

// The CLI must write where the matching server watches, or installs never land.
describe("t3 plugin directory", () => {
  it.effect("uses the installed server's folder by default", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.equal(
        yield* resolveWith({}),
        path.join(NodeOS.homedir(), ".t3", "userdata", "plugins"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("follows a dev server without an explicit home into dev state", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const devPlugins = path.join(NodeOS.homedir(), ".t3", "dev", "plugins");
      assert.equal(yield* resolveWith({}, { devUrl }), devPlugins);
      assert.equal(yield* resolveWith({ VITE_DEV_SERVER_URL: devUrl.href }), devPlugins);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps an explicit home in userdata even with a dev URL", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = path.join(NodeOS.tmpdir(), "t3code-plugin-cli-home");
      const expected = path.join(home, "userdata", "plugins");
      assert.equal(yield* resolveWith({ T3CODE_HOME: home }, { devUrl }), expected);
      assert.equal(yield* resolveWith({}, { baseDir: home, devUrl }), expected);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

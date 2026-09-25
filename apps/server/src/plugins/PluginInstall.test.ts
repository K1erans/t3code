import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { PluginManifest } from "@t3tools/plugin-runtime/manifest";
import { expect } from "vite-plus/test";

import { installPlugin, removePlugin } from "./PluginInstall.ts";

const pluginId = "com.acme.tasks";

const encodeManifest = Schema.encodeSync(Schema.fromJsonString(PluginManifest));
const decodeVersion = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

const manifestJson = (version: string, id = pluginId) =>
  encodeManifest({
    manifestVersion: 1,
    id,
    name: "Tasks",
    version,
    requires: [],
    entrypoints: { server: "./index.mjs" },
  });

/** A minimal ustar archive, gzipped, with the `package/` prefix `npm pack` uses. */
const makeTgz = (files: Record<string, string>) => {
  const blocks: Array<Uint8Array> = [];
  const encoder = new TextEncoder();
  for (const [name, contents] of Object.entries(files)) {
    const data = encoder.encode(contents);
    const header = new Uint8Array(512);
    header.set(encoder.encode(name), 0);
    header.set(encoder.encode("0000644\0"), 100);
    header.set(encoder.encode(`${data.length.toString(8).padStart(11, "0")}\0`), 124);
    header[156] = "0".charCodeAt(0);
    header.set(encoder.encode("ustar\0"), 257);
    blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return NodeZlib.gzipSync(Buffer.concat(blocks));
};

const setup = Effect.fn(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-plugin-install-" });
  const pluginsDirectory = path.join(root, "plugins");
  const writePackage = Effect.fn(function* (name: string, version: string, id = pluginId) {
    const directory = path.join(root, name);
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(directory, "t3-plugin.json"),
      manifestJson(version, id),
    );
    yield* fileSystem.writeFileString(
      path.join(directory, "index.mjs"),
      `export default () => {};\n`,
    );
    return directory;
  });
  const installedVersions = Effect.gen(function* () {
    const entries = (yield* fileSystem.readDirectory(pluginsDirectory)).toSorted();
    const versions: Record<string, string> = {};
    for (const entry of entries) {
      const manifest = yield* fileSystem.readFileString(
        path.join(pluginsDirectory, entry, "t3-plugin.json"),
      );
      versions[entry] = decodeVersion(manifest).version;
    }
    return versions;
  });
  return { root, pluginsDirectory, writePackage, installedVersions };
});

it.layer(NodeServices.layer)("plugin install", (it) => {
  it.effect("installs a folder under its id without leaving staging folders behind", () =>
    Effect.gen(function* () {
      const { pluginsDirectory, writePackage, installedVersions } = yield* setup();
      const source = yield* writePackage("dist", "1.0.0");

      const installed = yield* installPlugin({ pluginsDirectory, source });

      expect(installed).toMatchObject({ replaced: false, manifest: { id: pluginId } });
      // Only the final folder exists: no `.install-` or `.trash-` leftovers.
      expect(yield* installedVersions).toEqual({ [pluginId]: "1.0.0" });
    }),
  );

  it.effect("installs an npm-packed .tgz", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, pluginsDirectory, installedVersions } = yield* setup();
      const archive = path.join(root, "tasks-1.0.0.tgz");
      yield* fileSystem.writeFile(
        archive,
        makeTgz({
          "package/t3-plugin.json": manifestJson("1.0.0"),
          "package/index.mjs": "export default () => {};\n",
        }),
      );

      yield* installPlugin({ pluginsDirectory, source: archive });

      expect(yield* installedVersions).toEqual({ [pluginId]: "1.0.0" });
      expect(
        yield* fileSystem.readFileString(path.join(pluginsDirectory, pluginId, "index.mjs")),
      ).toBe("export default () => {};\n");
    }),
  );

  it.effect("replaces an installed package with the same id, whatever its folder name", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { pluginsDirectory, writePackage, installedVersions } = yield* setup();
      // A hand-copied install under a different folder name.
      yield* fileSystem.makeDirectory(pluginsDirectory, { recursive: true });
      yield* fileSystem.copy(
        yield* writePackage("v1", "1.0.0"),
        path.join(pluginsDirectory, "tasks-by-hand"),
      );

      const installed = yield* installPlugin({
        pluginsDirectory,
        source: yield* writePackage("v2", "2.0.0"),
      });

      expect(installed.replaced).toBe(true);
      expect(yield* installedVersions).toEqual({ [pluginId]: "2.0.0" });
    }),
  );

  it.effect("leaves the installed package untouched when the update is invalid", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { pluginsDirectory, writePackage, installedVersions } = yield* setup();
      yield* installPlugin({ pluginsDirectory, source: yield* writePackage("v1", "1.0.0") });
      const broken = yield* writePackage("v2", "2.0.0");
      yield* fileSystem.remove(path.join(broken, "index.mjs"));

      const exit = yield* Effect.exit(installPlugin({ pluginsDirectory, source: broken }));

      expect(exit._tag).toBe("Failure");
      expect(yield* installedVersions).toEqual({ [pluginId]: "1.0.0" });
    }),
  );

  it.effect("keeps the previous copy when an update and its rollback both fail", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { pluginsDirectory, writePackage } = yield* setup();
      yield* installPlugin({ pluginsDirectory, source: yield* writePackage("v1", "1.0.0") });
      const destination = path.join(pluginsDirectory, pluginId);
      // Something else holds the destination, so neither the new nor the old copy can land there.
      const blockedFileSystem: FileSystem.FileSystem = {
        ...fileSystem,
        rename: (from, to) =>
          to === destination
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "AlreadyExists",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: to,
                }),
              )
            : fileSystem.rename(from, to),
      };

      const error = yield* Effect.flip(
        installPlugin({ pluginsDirectory, source: yield* writePackage("v2", "2.0.0") }).pipe(
          Effect.provideService(FileSystem.FileSystem, blockedFileSystem),
        ),
      );

      expect(error.detail).toContain("the previous copy is kept in");
      const trash = (yield* fileSystem.readDirectory(pluginsDirectory)).filter((entry) =>
        entry.startsWith(".trash-"),
      );
      expect(trash).toHaveLength(1);
      const kept = yield* fileSystem.readFileString(
        path.join(pluginsDirectory, trash[0] ?? "", pluginId, "t3-plugin.json"),
      );
      expect(decodeVersion(kept).version).toBe("1.0.0");
    }),
  );

  it.effect("refuses sources that are not a local folder or archive", () =>
    Effect.gen(function* () {
      const { pluginsDirectory } = yield* setup();

      const error = yield* Effect.flip(
        installPlugin({ pluginsDirectory, source: "@acme/t3-tasks" }),
      );

      expect(error.message).toContain("npm package names are not supported");
    }),
  );

  it.effect("removes every folder for the id and fails for an id that is not installed", () =>
    Effect.gen(function* () {
      const { pluginsDirectory, writePackage, installedVersions } = yield* setup();
      yield* installPlugin({ pluginsDirectory, source: yield* writePackage("a", "1.0.0") });
      yield* installPlugin({
        pluginsDirectory,
        source: yield* writePackage("b", "1.0.0", "com.acme.other"),
      });

      yield* removePlugin({ pluginsDirectory, id: pluginId });

      expect(yield* installedVersions).toEqual({ "com.acme.other": "1.0.0" });
      const error = yield* Effect.flip(removePlugin({ pluginsDirectory, id: pluginId }));
      expect(error.message).toBe(`Plugin ${pluginId} is not installed.`);
    }),
  );
});

/**
 * Installs and removes local plugin packages in `<stateDir>/plugins/`.
 *
 * Both run from the CLI while a server may be watching the same directory, so
 * every visible change is a single rename: a package is fully staged in a
 * dot-prefixed folder next to its destination (discovery skips dot entries),
 * and replaced or removed packages are renamed aside before they are deleted.
 * The server never observes a half-copied package.
 */
import * as NodeZlib from "node:zlib";

import {
  PluginManifest,
  type PluginManifest as PluginManifestType,
} from "@t3tools/plugin-runtime/manifest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const MANIFEST_FILE_NAME = "t3-plugin.json";

export class PluginInstallError extends Schema.TaggedError<PluginInstallError>()(
  "PluginInstallError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

const isPluginInstallError = Schema.is(PluginInstallError);
const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));

/** Staging and trash folders; discovery ignores them. */
export const isHiddenPluginEntry = (entry: string) => entry.startsWith(".");

/** Reads and validates the manifest at the root of a package folder. */
const readPluginManifest = Effect.fn("PluginInstall.readPluginManifest")(function* (
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(directory, MANIFEST_FILE_NAME);
  if (!(yield* fileSystem.exists(manifestPath).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new PluginInstallError({ detail: `${directory} has no ${MANIFEST_FILE_NAME}` });
  }
  const manifest = yield* fileSystem.readFileString(manifestPath).pipe(
    Effect.flatMap(decodeManifestJson),
    Effect.mapError(
      (cause) =>
        new PluginInstallError({
          detail: `${MANIFEST_FILE_NAME} is invalid: ${cause.message}`,
          cause,
        }),
    ),
  );
  if (manifest.entrypoints.server === undefined) {
    return yield* new PluginInstallError({ detail: "manifest must define entrypoints.server" });
  }
  return manifest;
});

const fail = (detail: string) => (cause: unknown) => new PluginInstallError({ detail, cause });

const validatePackage = Effect.fn("PluginInstall.validatePackage")(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = yield* readPluginManifest(root);
  const entrypoint = path.resolve(root, manifest.entrypoints.server ?? "");
  const relative = path.relative(root, entrypoint);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return yield* new PluginInstallError({ detail: "entrypoints.server escapes the package" });
  }
  const exists = yield* fileSystem.exists(entrypoint).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return yield* new PluginInstallError({
      detail: `entrypoints.server ${manifest.entrypoints.server} does not exist`,
    });
  }
  return manifest;
});

// == .tgz

const readString = (block: Uint8Array, start: number, length: number) => {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
};

const readOctal = (block: Uint8Array, start: number, length: number) => {
  const text = readString(block, start, length).trim();
  return text.length === 0 ? 0 : Number.parseInt(text, 8);
};

const parsePaxPath = (data: Uint8Array): string | undefined => {
  // Records are "<length> <key>=<value>\n".
  let path: string | undefined;
  for (const record of new TextDecoder().decode(data).split("\n")) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match?.[1] !== undefined) path = match[1];
  }
  return path;
};

interface TarEntry {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly data: Uint8Array;
}

/**
 * Reads a gzipped tarball as produced by `npm pack` or `tar czf`. Only files
 * and directories are accepted; links would let an archive point outside the
 * package, and plugin packages must not contain them anyway.
 */
export const parseTgz = (archive: Uint8Array): ReadonlyArray<TarEntry> => {
  const tar = NodeZlib.gunzipSync(archive);
  const entries: Array<TarEntry> = [];
  let longPath: string | undefined;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = readOctal(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("archive has an invalid entry");
    const type = String.fromCharCode(header[156] ?? 0);
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "x" || type === "L") {
      longPath = type === "x" ? parsePaxPath(data) : readString(data, 0, data.length);
      continue;
    }
    if (type === "g") continue;
    const prefix = readString(header, 345, 155);
    const name = readString(header, 0, 100);
    const path = longPath ?? (prefix.length > 0 ? `${prefix}/${name}` : name);
    longPath = undefined;
    if (type === "0" || type === "\0" || type === "7") {
      entries.push({ path, type: "file", data });
    } else if (type === "5") {
      entries.push({ path, type: "directory", data });
    } else {
      throw new Error(`archive entry ${path} is a link or special file`);
    }
  }
  return entries;
};

const extractTgz = Effect.fn("PluginInstall.extractTgz")(function* (
  archivePath: string,
  destination: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const archive = yield* fileSystem
    .readFile(archivePath)
    .pipe(Effect.mapError(fail(`Could not read ${archivePath}`)));
  const entries = yield* Effect.try({
    try: () => parseTgz(archive),
    catch: (cause) =>
      new PluginInstallError({
        detail: `${archivePath} is not a valid .tgz: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });
  for (const entry of entries) {
    // macOS tar stores extended attributes as `._name` AppleDouble files.
    if (path.basename(entry.path).startsWith("._")) continue;
    const target = path.resolve(destination, entry.path);
    const relative = path.relative(destination, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* new PluginInstallError({
        detail: `archive entry ${entry.path} escapes the package`,
      });
    }
    if (relative.length === 0) continue;
    if (entry.type === "directory") {
      yield* fileSystem
        .makeDirectory(target, { recursive: true })
        .pipe(Effect.mapError(fail(`Could not extract ${entry.path}`)));
      continue;
    }
    yield* fileSystem
      .makeDirectory(path.dirname(target), { recursive: true })
      .pipe(Effect.mapError(fail(`Could not extract ${entry.path}`)));
    yield* fileSystem
      .writeFile(target, entry.data)
      .pipe(Effect.mapError(fail(`Could not extract ${entry.path}`)));
  }
});

/** `npm pack` nests everything under `package/`; a flat archive is fine too. */
const findPackageRoot = Effect.fn("PluginInstall.findPackageRoot")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (yield* fileSystem.exists(path.join(directory, MANIFEST_FILE_NAME))) return directory;
  const entries = (yield* fileSystem.readDirectory(directory)).filter(
    (entry) => !isHiddenPluginEntry(entry),
  );
  if (entries.length === 1 && entries[0] !== undefined) {
    const nested = path.join(directory, entries[0]);
    if (yield* fileSystem.exists(path.join(nested, MANIFEST_FILE_NAME))) return nested;
  }
  return yield* new PluginInstallError({ detail: `archive has no ${MANIFEST_FILE_NAME}` });
});

// == install / remove

/** Top-level package folders whose name or manifest id is `id`. */
const findInstalled = Effect.fn("PluginInstall.findInstalled")(function* (
  pluginsDirectory: string,
  id: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem
    .readDirectory(pluginsDirectory)
    .pipe(Effect.orElseSucceed((): Array<string> => []));
  const matches: Array<string> = [];
  for (const entry of entries) {
    if (isHiddenPluginEntry(entry)) continue;
    const directory = path.join(pluginsDirectory, entry);
    const manifest = yield* readPluginManifest(directory).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (entry === id || manifest?.id === id) matches.push(entry);
  }
  return matches;
});

/**
 * Renames every folder holding `id` into a hidden trash folder. `restore` puts
 * them back and `discard` deletes them. If a restore fails the trash is kept,
 * and the error names it, so a failed update never loses the old copy.
 */
const moveAside = Effect.fn("PluginInstall.moveAside")(function* (
  pluginsDirectory: string,
  id: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const existing = yield* findInstalled(pluginsDirectory, id);
  if (existing.length === 0) {
    return { moved: [] as ReadonlyArray<string>, restore: Effect.void, discard: Effect.void };
  }
  const trash = yield* fileSystem
    .makeTempDirectory({ directory: pluginsDirectory, prefix: ".trash-" })
    .pipe(Effect.mapError(fail(`Could not write to ${pluginsDirectory}`)));
  const moved: Array<string> = [];
  const discard = fileSystem.remove(trash, { recursive: true }).pipe(Effect.ignore);
  const restore = Effect.gen(function* () {
    const stranded: Array<string> = [];
    for (const entry of moved) {
      const restored = yield* Effect.exit(
        fileSystem.rename(path.join(trash, entry), path.join(pluginsDirectory, entry)),
      );
      if (restored._tag === "Failure") stranded.push(entry);
    }
    if (stranded.length > 0) {
      return yield* new PluginInstallError({
        detail: `Could not restore ${stranded.join(", ")}; the previous copy is kept in ${trash}`,
      });
    }
    yield* discard;
  });
  for (const entry of existing) {
    yield* fileSystem.rename(path.join(pluginsDirectory, entry), path.join(trash, entry)).pipe(
      Effect.mapError(fail(`Could not move ${entry} out of ${pluginsDirectory}`)),
      Effect.catch((error) => restore.pipe(Effect.andThen(Effect.fail(error)))),
    );
    moved.push(entry);
  }
  return { moved, restore, discard };
});

export interface InstalledPlugin {
  readonly manifest: PluginManifestType;
  readonly directory: string;
  readonly replaced: boolean;
}

/**
 * Installs a package folder or `.tgz` into `pluginsDirectory/<id>`,
 * replacing any installed package with the same id.
 */
export const installPlugin = Effect.fn("PluginInstall.installPlugin")(function* (input: {
  readonly pluginsDirectory: string;
  readonly source: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = path.resolve(input.source);
  const info = yield* fileSystem
    .stat(source)
    .pipe(
      Effect.mapError(
        fail(
          `${input.source} does not exist. Pass a plugin folder or .tgz file; npm package names are not supported.`,
        ),
      ),
    );
  yield* fileSystem
    .makeDirectory(input.pluginsDirectory, { recursive: true })
    .pipe(Effect.mapError(fail(`Could not create ${input.pluginsDirectory}`)));

  return yield* Effect.scoped(
    Effect.gen(function* () {
      // Staged next to the destination so the final rename stays on one
      // filesystem and is atomic.
      const staging = yield* fileSystem
        .makeTempDirectoryScoped({ directory: input.pluginsDirectory, prefix: ".install-" })
        .pipe(Effect.mapError(fail(`Could not write to ${input.pluginsDirectory}`)));
      let root: string;
      if (info.type === "Directory") {
        yield* validatePackage(source);
        root = path.join(staging, "package");
        yield* fileSystem
          .copy(source, root)
          .pipe(Effect.mapError(fail(`Could not copy ${input.source}`)));
      } else if (info.type === "File") {
        // Extracted one level down so the package root is never the staging
        // folder itself, which the scope deletes afterwards.
        const extracted = path.join(staging, "archive");
        yield* extractTgz(source, extracted);
        root = yield* findPackageRoot(extracted).pipe(
          Effect.mapError((cause) =>
            isPluginInstallError(cause)
              ? cause
              : new PluginInstallError({ detail: `Could not read ${input.source}`, cause }),
          ),
        );
      } else {
        return yield* new PluginInstallError({
          detail: `${input.source} is not a folder or .tgz file`,
        });
      }
      const manifest = yield* validatePackage(root);

      const destination = path.join(input.pluginsDirectory, manifest.id);
      const aside = yield* moveAside(input.pluginsDirectory, manifest.id);
      yield* fileSystem.rename(root, destination).pipe(
        Effect.mapError(fail(`Could not install into ${destination}`)),
        Effect.catch((error) => aside.restore.pipe(Effect.andThen(Effect.fail(error)))),
      );
      yield* aside.discard;
      return {
        manifest,
        directory: destination,
        replaced: aside.moved.length > 0,
      } satisfies InstalledPlugin;
    }),
  );
});

/** Removes every installed folder for `id`. Fails when none is installed. */
export const removePlugin = Effect.fn("PluginInstall.removePlugin")(function* (input: {
  readonly pluginsDirectory: string;
  readonly id: string;
}) {
  const removed = yield* moveAside(input.pluginsDirectory, input.id);
  if (removed.moved.length === 0) {
    return yield* new PluginInstallError({ detail: `Plugin ${input.id} is not installed.` });
  }
  yield* removed.discard;
  return removed.moved;
});

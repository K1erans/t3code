import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const STORAGE_FILE_NAME = "storage.sqlite";
export const MAX_VALUE_BYTES = 1024 * 1024;

/**
 * The key-value store a plugin sees as `api.storage`. Values are JSON, at most
 * 1 MB each once serialized. `update` runs one at a time per key (together with
 * `set` and `delete` on that key), so a load-modify-save never loses a write.
 * Returning `undefined` from an update deletes the key.
 */
export interface PluginStorage {
  readonly get: (key: string) => Promise<unknown>;
  readonly set: (key: string, value: unknown) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
  readonly update: (
    key: string,
    fn: (current: unknown) => unknown | Promise<unknown>,
  ) => Promise<unknown>;
}

const assertKey = (key: unknown): string => {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("Plugin storage keys must be non-empty strings");
  }
  return key;
};

const encodeValue = (value: unknown): string => {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError("Plugin storage values must be JSON-serializable");
  }
  if (Buffer.byteLength(json, "utf8") > MAX_VALUE_BYTES) {
    throw new RangeError(`Plugin storage values must be at most ${MAX_VALUE_BYTES} bytes`);
  }
  return json;
};

/**
 * Opens `<dataDir>/storage.sqlite`, creating the folder if needed. The database
 * stays open until the surrounding scope closes.
 */
export const open = Effect.fn("PluginStorage.open")(function* (dataDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(dataDir, { recursive: true });
  const filename = path.join(dataDir, STORAGE_FILE_NAME);
  const sql = Context.get(
    yield* Layer.build(
      NodeSqliteClient.layer({
        filename,
        spanAttributes: { "db.name": STORAGE_FILE_NAME, "service.name": "t3-plugin-storage" },
      }),
    ),
    SqlClient.SqlClient,
  );
  yield* sql`PRAGMA busy_timeout = 5000;`;
  yield* sql`PRAGMA journal_mode = WAL;`;
  yield* sql`CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT;`;

  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  const read = async (key: string) => {
    const rows = await run(
      sql<{ readonly value: string }>`SELECT value FROM entries WHERE key = ${key}`,
    );
    const row = rows[0];
    return row === undefined ? undefined : (JSON.parse(row.value) as unknown);
  };
  const write = async (key: string, json: string | undefined) => {
    if (json === undefined) {
      await run(sql`DELETE FROM entries WHERE key = ${key}`);
      return;
    }
    await run(
      sql`INSERT INTO entries (key, value) VALUES (${key}, ${json})
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
  };

  // Tail of the pending writes for each key. Writes chain onto it, so they run in call order.
  const pendingWrites = new Map<string, Promise<unknown>>();
  const serialize = <A>(key: string, task: () => Promise<A>): Promise<A> => {
    const result = (pendingWrites.get(key) ?? Promise.resolve()).then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    pendingWrites.set(key, tail);
    void tail.then(() => {
      if (pendingWrites.get(key) === tail) pendingWrites.delete(key);
    });
    return result;
  };

  return {
    get: async (key) => read(assertKey(key)),
    set: async (key, value) => {
      const json = encodeValue(value);
      return serialize(assertKey(key), () => write(key, json));
    },
    delete: async (key) => serialize(assertKey(key), () => write(key, undefined)),
    update: async (key, fn) =>
      serialize(assertKey(key), async () => {
        const next = await fn(await read(key));
        await write(key, next === undefined ? undefined : encodeValue(next));
        return next;
      }),
  } satisfies PluginStorage;
});

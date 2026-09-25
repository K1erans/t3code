import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as PluginStorage from "./PluginStorage.ts";

const withStorage = <A>(
  dataDir: string,
  use: (storage: PluginStorage.PluginStorage) => Promise<A>,
) =>
  Effect.scoped(
    PluginStorage.open(dataDir).pipe(
      Effect.flatMap((storage) => Effect.promise(() => use(storage))),
    ),
  );

const makeDataDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-plugin-storage-" });
  return `${baseDir}/plugin-data/com.acme.test`;
});

const outcome = (promise: Promise<unknown>) =>
  promise.then(
    () => "stored",
    (error: Error) => error.name,
  );

it.layer(NodeServices.layer)("plugin storage", (it) => {
  it.effect("keeps JSON values after the store is reopened", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dataDir = yield* makeDataDir;

      yield* withStorage(dataDir, async (storage) => {
        await storage.set("board", { columns: ["todo", "done"], count: 2 });
        await storage.set("gone", true);
        await storage.delete("gone");
      });

      expect(
        yield* withStorage(dataDir, async (storage) => [
          await storage.get("board"),
          await storage.get("gone"),
        ]),
      ).toEqual([{ columns: ["todo", "done"], count: 2 }, undefined]);
      expect(yield* fileSystem.exists(`${dataDir}/${PluginStorage.STORAGE_FILE_NAME}`)).toBe(true);
    }),
  );

  it.effect("runs concurrent updates to the same key one after another", () =>
    Effect.gen(function* () {
      const dataDir = yield* makeDataDir;

      const [results, final] = yield* withStorage(dataDir, async (storage) => {
        const results = await Promise.all(
          Array.from({ length: 50 }, () =>
            storage.update("count", async (current) => {
              // Yield between load and save; without serialization this loses writes.
              await Promise.resolve();
              return (typeof current === "number" ? current : 0) + 1;
            }),
          ),
        );
        return [results, await storage.get("count")] as const;
      });

      expect(final).toBe(50);
      expect(results).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    }),
  );

  it.effect("keeps serving a key after a failed update", () =>
    Effect.gen(function* () {
      const dataDir = yield* makeDataDir;

      const results = yield* withStorage(dataDir, async (storage) => {
        await storage.set("key", 1);
        const failed = outcome(
          storage.update("key", () => {
            throw new Error("boom");
          }),
        );
        const next = storage.update("key", (current) => Number(current) + 1);
        const removed = storage.update("other", () => undefined);
        return [await failed, await next, await removed, await storage.get("other")];
      });

      expect(results).toEqual(["Error", 2, undefined, undefined]);
    }),
  );

  it.effect("rejects values over 1 MB and values that are not JSON", () =>
    Effect.gen(function* () {
      const dataDir = yield* makeDataDir;
      const limit = PluginStorage.MAX_VALUE_BYTES;

      const results = yield* withStorage(dataDir, async (storage) => [
        await outcome(storage.set("big", "x".repeat(limit))),
        // Two quote characters bring this to exactly the limit.
        await outcome(storage.set("fits", "x".repeat(limit - 2))),
        await outcome(storage.set("function", () => 1)),
        await outcome(storage.update("big", () => "x".repeat(limit))),
        await storage.get("big"),
      ]);

      expect(results).toEqual(["RangeError", "stored", "TypeError", "RangeError", undefined]);
    }),
  );
});

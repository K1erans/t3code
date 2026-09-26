import { describe, expect, it } from "vite-plus/test";

import { connect, NOT_IN_T3_MESSAGE } from "../src/screen.ts";

describe("screen loader", () => {
  it("fails with a clear message outside T3 Code", async () => {
    await expect(connect()).rejects.toThrow(NOT_IN_T3_MESSAGE);
  });
});

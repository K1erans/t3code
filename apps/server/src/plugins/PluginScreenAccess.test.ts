import { describe, expect, it } from "vite-plus/test";

import { injectScreenHost } from "./PluginScreenAccess.ts";

const HOST_TAGS =
  '<link rel="stylesheet" href="_t3/base.css"><script type="module" src="_t3/screen.js"></script>';

describe("injectScreenHost", () => {
  it("adds the base stylesheet and runtime first in the head, so the screen's own styles win", () => {
    expect(
      injectScreenHost(
        '<!doctype html><html lang="en"><HEAD><link rel="stylesheet" href="app.css"></HEAD></html>',
        0,
      ),
    ).toBe(
      `<!doctype html><html lang="en"><HEAD>${HOST_TAGS}<link rel="stylesheet" href="app.css"></HEAD></html>`,
    );
  });

  it("keeps the doctype first when there is no head, so the page stays in standards mode", () => {
    expect(injectScreenHost("<!DOCTYPE html>\n<p>board</p>", 0)).toBe(
      `<!DOCTYPE html>${HOST_TAGS}\n<p>board</p>`,
    );
    expect(injectScreenHost("<html><body>board</body></html>", 0)).toBe(
      `<html>${HOST_TAGS}<body>board</body></html>`,
    );
    expect(injectScreenHost("<p>board</p>", 0)).toBe(`${HOST_TAGS}<p>board</p>`);
  });

  it("reaches the token's root from pages in subfolders", () => {
    expect(injectScreenHost("<p>settings</p>", 2)).toBe(
      '<link rel="stylesheet" href="../../_t3/base.css"><script type="module" src="../../_t3/screen.js"></script><p>settings</p>',
    );
  });

  it("does not mistake a header element for the head", () => {
    expect(injectScreenHost("<header>board</header>", 0)).toBe(
      `${HOST_TAGS}<header>board</header>`,
    );
  });
});

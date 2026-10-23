import { describe, expect, test } from "bun:test";

import { stableExecutable } from "./self.ts";

describe("this program's command", () => {
  test("a Homebrew binary is named by its opt path, which survives an upgrade", () => {
    expect(stableExecutable("/opt/homebrew/Cellar/chernabog/0.3.0/bin/chernabog")).toBe(
      "/opt/homebrew/opt/chernabog/bin/chernabog",
    );
    expect(
      stableExecutable("/home/linuxbrew/.linuxbrew/Cellar/chernabog/0.4.0_1/bin/chernabog"),
    ).toBe("/home/linuxbrew/.linuxbrew/opt/chernabog/bin/chernabog");
    expect(stableExecutable("/Users/dev/.local/bin/chernabog")).toBe(
      "/Users/dev/.local/bin/chernabog",
    );
  });
});

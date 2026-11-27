import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { type SandboxedSession, sandboxRefusal } from "./sandboxes.ts";

const DOCKER = { name: "docker", from: "repo config" } as const;

const session: SandboxedSession = {
  adapter: "claude",
  interactive: true,
  platform: "darwin",
  host: { CHERNABOG_SANDBOX_IMAGE: "sandbox:test" },
};

const refusal = (overrides: Partial<SandboxedSession>) =>
  Option.getOrElse(sandboxRefusal(DOCKER, { ...session, ...overrides }), () => "");

describe("whether a session's sandbox can hold it", () => {
  test("holds an interactive claude session with an image to run in", () => {
    expect(sandboxRefusal(DOCKER, session)).toEqual(Option.none());
  });

  test("never refuses a session with no sandbox", () => {
    expect(
      sandboxRefusal({ name: "none", from: "default" }, { ...session, adapter: "codex" }),
    ).toEqual(Option.none());
  });

  test("refuses another agent, which runs in no container yet, rather than running it on the host", () => {
    for (const adapter of ["codex", "opencode", "mine"]) {
      expect(refusal({ adapter })).toContain(`can't run a ${adapter} session in a container yet`);
    }
  });

  test("refuses headless claude, which __launch doesn't start", () => {
    expect(refusal({ interactive: false })).toContain("only under a launcher");
  });

  test("refuses a session with no image, naming the variable that gives one", () => {
    expect(refusal({ host: {} })).toContain("set CHERNABOG_SANDBOX_IMAGE");
    expect(refusal({ host: { CHERNABOG_SANDBOX_IMAGE: "" } })).toContain("no image");
  });

  test("refuses on Windows, where a worktree can't be mounted at its own path", () => {
    expect(refusal({ platform: "win32" })).toContain("isn't supported on Windows");
  });
});

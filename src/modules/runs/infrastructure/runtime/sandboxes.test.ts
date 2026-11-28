import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { type SandboxedSession, sandboxRefusal } from "./sandboxes.ts";

const DOCKER = { name: "docker", from: "repo config" } as const;

const session: SandboxedSession = {
  adapter: "claude",
  interactive: true,
  platform: "darwin",
};

const refusal = (overrides: Partial<SandboxedSession>) =>
  Option.getOrElse(sandboxRefusal(DOCKER, { ...session, ...overrides }), () => "");

describe("whether a session's sandbox can hold it", () => {
  test("holds an interactive claude session", () => {
    expect(sandboxRefusal(DOCKER, session)).toEqual(Option.none());
  });

  test("never refuses a session with no sandbox", () => {
    expect(
      sandboxRefusal({ name: "none", from: "default" }, { ...session, adapter: "codex" }),
    ).toEqual(Option.none());
  });

  test("refuses another agent, which runs in no container yet, rather than running it on the host", () => {
    for (const adapter of ["opencode", "mine"]) {
      expect(refusal({ adapter })).toContain(`can't run a ${adapter} session in a container yet`);
    }
  });

  // Codex runs headless (`codex exec`) under any launcher, so its container
  // is started by its adapter, not by __launch.
  test("holds a codex session, headless or under a launcher", () => {
    expect(sandboxRefusal(DOCKER, { ...session, adapter: "codex" })).toEqual(Option.none());
    expect(sandboxRefusal(DOCKER, { ...session, adapter: "codex", interactive: false })).toEqual(
      Option.none(),
    );
  });

  test("refuses headless claude, which __launch doesn't start", () => {
    expect(refusal({ interactive: false })).toContain("only under a launcher");
  });

  test("refuses on Windows, where a worktree can't be mounted at its own path", () => {
    expect(refusal({ platform: "win32" })).toContain("isn't supported on Windows");
  });
});

import { printJson } from "@chernabog/core";
import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { codexArgs } from "./codex.ts";
import { CODEX_LOGIN_ENV, refreshedLogin, sandboxedCodexEnvironment } from "./codex-sandbox.ts";

const login = (accountId: string, lastRefresh: string, access = "access-1") =>
  printJson({
    auth_mode: "chatgpt",
    tokens: { access_token: access, refresh_token: "refresh", account_id: accountId },
    last_refresh: lastRefresh,
  });

describe("codex's arguments", () => {
  const run = {
    thread: Option.none<string>(),
    schemaFile: Option.none<string>(),
    lastFile: "/tmp/last.txt",
    writableRoots: ["/repo/.git"],
  };

  test("on the host, codex runs in its own workspace sandbox, which may write the common git dir", () => {
    const args = codexArgs({ ...run, inContainer: false });

    expect(args).toContain('sandbox_mode="workspace-write"');
    expect(args).toContain('sandbox_workspace_write.writable_roots=["/repo/.git"]');
  });

  // Codex's own sandbox needs kernel features a container's default profile
  // denies, and the container is the sandbox (ADR 24, decision 4).
  test("in a container, codex's own sandbox is off", () => {
    const args = codexArgs({ ...run, inContainer: true });

    expect(args).toContain('sandbox_mode="danger-full-access"');
    expect(args.join(" ")).not.toContain("workspace-write");
    expect(args.join(" ")).not.toContain("writable_roots");
  });
});

describe("a sandboxed codex session's environment", () => {
  test("holds its own CODEX_HOME, the account's login and the persona's GH_TOKEN, and nothing else", () => {
    const env = sandboxedCodexEnvironment(
      {
        GH_TOKEN: "token-alice",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
        GIT_CONFIG_VALUE_0: "!f() { echo password=$GH_TOKEN; }; f",
        GITHUB_TOKEN: "token-alice",
        OPENAI_API_KEY: "sk-host",
        PATH: "/opt/host/bin",
        HOME: "/Users/someone",
        REPO_VARIABLE: "x",
      },
      "/home/chernabog/sessions/interactive/s1/codex",
      login("acct", "2026-11-01T00:00:00Z"),
    );

    expect(Object.keys(env).sort()).toEqual(
      [
        CODEX_LOGIN_ENV,
        "CODEX_HOME",
        "GH_TOKEN",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_VALUE_0",
      ].sort(),
    );
    expect(env.CODEX_HOME).toBe("/home/chernabog/sessions/interactive/s1/codex");
  });
});

describe("the login a session leaves", () => {
  const given = login("acct", "2026-11-01T00:00:00Z");

  // Codex refreshes a login it finds old, and the refresh token it used
  // stops working, so the host's login takes the refreshed one.
  test("is kept on the host when codex refreshed it for the same account", () => {
    const refreshed = login("acct", "2026-11-20T00:00:00Z", "access-2");

    expect(refreshedLogin(given, refreshed)).toEqual(Option.some(refreshed));
  });

  test("is not when it is the login it was given", () => {
    expect(refreshedLogin(given, given)).toEqual(Option.none());
  });

  test("is not when it is another account's, isn't newer, or isn't a login at all", () => {
    expect(refreshedLogin(given, login("other", "2026-11-20T00:00:00Z"))).toEqual(Option.none());
    expect(refreshedLogin(given, login("acct", "2026-10-01T00:00:00Z", "access-2"))).toEqual(
      Option.none(),
    );
    expect(refreshedLogin(given, "not json")).toEqual(Option.none());
    expect(refreshedLogin(given, printJson({ OPENAI_API_KEY: "sk-x" }))).toEqual(Option.none());
  });
});

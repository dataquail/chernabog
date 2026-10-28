import { type Account, HEADLESS } from "@chernabog/core";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import { expandHome } from "../../../../platform/home.ts";
import { pickNodeVersion } from "../../../../platform/node-version.ts";
import { transcriptDirectoryFor } from "./agents/claude.ts";
import { claudeEnvironment } from "./agents/claude-events.ts";
import { accountEnv, keychainServiceFor } from "./usage-gate.ts";

const work = {
  name: "work",
  configDir: Option.none(),
  expectedEmail: Option.none(),
  oauthTokenEnv: Option.none<string>(),
  usageGate: "usage" as const,
};

const personal = {
  name: "personal",
  configDir: Option.some("/Users/dev/.claude-personal"),
  expectedEmail: Option.some("dev@example.com"),
  oauthTokenEnv: Option.none<string>(),
  usageGate: "usage" as const,
};

test("each account's usage is read from its own keychain item", () => {
  expect(keychainServiceFor(Option.none())).toBe("Claude Code-credentials");
  expect(keychainServiceFor(Option.some("/Users/dev/.claude-personal"))).toBe(
    "Claude Code-credentials-402de754",
  );
});

test("the work account clears CLAUDE_CONFIG_DIR; the personal one sets it", () => {
  expect(
    Record.get(
      accountEnv(work, { CLAUDE_CONFIG_DIR: "/Users/dev/.claude-personal" }),
      "CLAUDE_CONFIG_DIR",
    ),
  ).toEqual(Option.none());
  expect(Record.get(accountEnv(personal, {}), "CLAUDE_CONFIG_DIR")).toEqual(
    Option.some("/Users/dev/.claude-personal"),
  );
});

const ci = {
  name: "ci",
  configDir: Option.none<string>(),
  expectedEmail: Option.none<string>(),
  oauthTokenEnv: Option.some("CI_CLAUDE_TOKEN"),
  usageGate: "usage" as const,
};

test("a token left in the shell never logs in an account without one", () => {
  expect(
    Record.get(
      accountEnv(work, { CLAUDE_CODE_OAUTH_TOKEN: "shell-token" }),
      "CLAUDE_CODE_OAUTH_TOKEN",
    ),
  ).toEqual(Option.none());
  expect(
    Record.get(
      accountEnv(personal, { CLAUDE_CODE_OAUTH_TOKEN: "shell-token" }),
      "CLAUDE_CODE_OAUTH_TOKEN",
    ),
  ).toEqual(Option.none());
});

test("an account with oauthTokenEnv logs claude in with the token from that variable", () => {
  const env = accountEnv(ci, {
    CI_CLAUDE_TOKEN: "ci-token",
    CLAUDE_CODE_OAUTH_TOKEN: "shell-token",
  });

  expect(Record.get(env, "CLAUDE_CODE_OAUTH_TOKEN")).toEqual(Option.some("ci-token"));
  expect(Record.get(accountEnv(ci, {}), "CLAUDE_CODE_OAUTH_TOKEN")).toEqual(Option.none());
});

const sessionEnv = (account: Account, host: Record<string, string>) =>
  claudeEnvironment({
    account,
    host,
    env: { CLAUDE_CODE_OAUTH_TOKEN: "committed-token" },
    launcher: { ...HEADLESS, name: "headless", from: "machine config" },
    log: () => Effect.void,
  });

test("an agent session gets the token only for an account with its own, from the host and never the repo's env", () => {
  expect(
    Record.get(
      sessionEnv(work, { CLAUDE_CODE_OAUTH_TOKEN: "shell-token" }),
      "CLAUDE_CODE_OAUTH_TOKEN",
    ),
  ).toEqual(Option.none());
  expect(
    Record.get(sessionEnv(ci, { CI_CLAUDE_TOKEN: "ci-token" }), "CLAUDE_CODE_OAUTH_TOKEN"),
  ).toEqual(Option.some("ci-token"));
  expect(Record.get(sessionEnv(ci, {}), "CLAUDE_CODE_OAUTH_TOKEN")).toEqual(Option.none());
});

test("node: the pinned version when installed, else the newest of its major at or above it", () => {
  const installed = ["v20.5.1", "v22.14.0", "v22.21.1", "v24.21.0"];
  expect(pickNodeVersion("v24.21.0\n", installed)).toEqual(Option.some("v24.21.0"));
  expect(pickNodeVersion("22.13.1", installed)).toEqual(Option.some("v22.21.1"));
  expect(pickNodeVersion("22.30.0", installed)).toEqual(Option.some("v22.21.1"));
  expect(pickNodeVersion("18", installed)).toEqual(Option.none());
  expect(pickNodeVersion("lts/*", installed)).toEqual(Option.none());
});

test("a session transcript lives under the worktree path with every non-alphanumeric replaced by a dash", () => {
  expect(transcriptDirectoryFor("/Users/dev/orca/workspaces/goodbones/lusca")).toBe(
    "-Users-dev-orca-workspaces-goodbones-lusca",
  );
});

test("only a leading ~ is expanded", () => {
  expect(expandHome("~/x", "/Users/dev")).toBe("/Users/dev/x");
  expect(expandHome("/tmp/~x", "/Users/dev")).toBe("/tmp/~x");
});

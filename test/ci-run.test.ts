// What `chernabog ci run` (#460) decides before it starts a run: when it
// refuses to, the machine config a job's home starts from, what a runner's
// ~/.claude.json needs, and where claude keeps a worktree's transcripts.

import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ciMachineConfig,
  claudeSeed,
  OAUTH_TOKEN_ENV,
  refusalOf,
  transcriptDirName,
} from "../src/interface/cli/ci-run.main.ts";
import { MachineConfigFile, normalizeMachineConfig } from "../src/repo-config.ts";

describe("refusalOf", () => {
  test("refuses ANTHROPIC_API_KEY, which bills per token over the subscription", () => {
    const refused = refusalOf({ ANTHROPIC_API_KEY: "sk-ant-api", [OAUTH_TOKEN_ENV]: "t" }, false);

    expect(Option.getOrElse(refused, () => "")).toContain("ANTHROPIC_API_KEY");
  });

  test("refuses a home that already holds runs", () => {
    expect(Option.getOrElse(refusalOf({}, true), () => "")).toContain("a home of its own");
  });

  test("starts with a fresh home and the subscription's token", () => {
    expect(refusalOf({ [OAUTH_TOKEN_ENV]: "t" }, false)).toEqual(Option.none());
  });
});

describe("ciMachineConfig", () => {
  test("enrolls the checkout for the one flow, on the subscription token with no usage gate, which a token cannot read, under tmux", () => {
    expect(
      ciMachineConfig({
        slug: "dataquail/chernabog-rehearsal",
        checkout: "/home/runner/work/r/r",
        flows: ["review"],
      }),
    ).toEqual({
      accounts: { ci: { oauthTokenEnv: OAUTH_TOKEN_ENV, usageGate: "none" } },
      launcher: "tmux",
      repos: [
        {
          path: "/home/runner/work/r/r",
          repo: "dataquail/chernabog-rehearsal",
          name: "chernabog-rehearsal",
          account: "ci",
          flows: { review: {} },
        },
      ],
    });
  });
});

describe("ciMachineConfig, as machine config reads it", () => {
  // A setup-token token can't read usage, and the gate refuses to read it from
  // a token account: without usageGate none, every plan holds every flow back.
  test("is one account, on the subscription token, that launches without the usage gate", () => {
    const file = Schema.decodeUnknownSync(MachineConfigFile)(
      ciMachineConfig({
        slug: "dataquail/chernabog-rehearsal",
        checkout: "/w",
        flows: ["implement"],
      }),
    );

    const accounts = normalizeMachineConfig(file, "/home/runner").accounts.map((account) => ({
      name: account.name,
      usageGate: account.usageGate,
      oauthTokenEnv: account.oauthTokenEnv,
    }));

    expect(accounts).toEqual([
      { name: "ci", usageGate: "none", oauthTokenEnv: Option.some(OAUTH_TOKEN_ENV) },
    ]);
  });
});

describe("ciMachineConfig for the plan job", () => {
  test("enrolls the checkout for every CI flow", () => {
    expect(
      ciMachineConfig({
        slug: "dataquail/chernabog-rehearsal",
        checkout: "/w",
        flows: ["implement", "review"],
      }).repos[0]?.flows,
    ).toEqual({ implement: {}, review: {} });
  });
});

describe("claudeSeed", () => {
  test("has onboarding done and each path trusted, so claude starts at its prompt", () => {
    expect(claudeSeed(["/w/checkout", "/tmp/home/worktrees"])).toEqual({
      hasCompletedOnboarding: true,
      theme: "dark",
      projects: {
        "/w/checkout": { hasTrustDialogAccepted: true },
        "/tmp/home/worktrees": { hasTrustDialogAccepted: true },
      },
    });
  });
});

describe("transcriptDirName", () => {
  test("is the working directory with everything but letters and digits as -", () => {
    expect(transcriptDirName("/tmp/w3")).toBe("-tmp-w3");
    expect(transcriptDirName("/home/runner/work/a.b/c_d")).toBe("-home-runner-work-a-b-c-d");
  });
});

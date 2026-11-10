// What `chernabog ci run` (#460) decides before it starts a run: when it
// refuses to, the machine config a job's home starts from, what a runner's
// ~/.claude.json needs, and where claude keeps a worktree's transcripts.

import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import {
  ciMachineConfig,
  claudeSeed,
  OAUTH_TOKEN_ENV,
  refusalOf,
  transcriptDirName,
} from "../src/interface/cli/ci-run.main.ts";

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
  test("enrolls the checkout for the one flow, on the subscription token, under tmux", () => {
    expect(
      ciMachineConfig({
        slug: "dataquail/chernabog-rehearsal",
        checkout: "/home/runner/work/r/r",
        flows: ["review"],
      }),
    ).toEqual({
      accounts: { ci: { oauthTokenEnv: OAUTH_TOKEN_ENV } },
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

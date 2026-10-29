// The GitHub service's CI reads behind the fake GitHub: a pull request's, a
// commit's and a branch's, and what a failed run's log says.

import { GitHub, type RepoSettings } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { IMPLICIT } from "../src/kernel/persona.value-object.ts";
import { GitHubLive } from "../src/modules/runs/infrastructure/runtime/sdk-live.ts";
import { Exec, execOk } from "../src/platform/exec.ts";
import { GitHubApi } from "../src/platform/github-api.ts";
import { GitHubTokens } from "../src/platform/github-auth.ts";
import { type FakeWorkflowRun, startFakeGitHub } from "./acceptance/fake-github.ts";
import { effectAtHomeWith } from "./effect-test.ts";
import { settings } from "./sdk-fakes.ts";

const SLUG = "dataquail/demo";

const atHome = effectAtHomeWith(Exec.layer);

// The fake GitHub over an empty bare repo, a commit on main and one on a
// pull request's branch, and the GitHub service reading it.
const ciRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-ci-" }));
  const bare = `${root}/origin.git`;
  yield* execOk("git", ["init", "--quiet", "--bare", "--initial-branch", "main", bare]);

  const github = yield* Effect.acquireRelease(
    Effect.sync(() => startFakeGitHub({ slug: SLUG, bare })),
    (started) => Effect.promise(() => started.stop()),
  );

  const mainSha = github.commit("main");
  github.setRef("refs/heads/main", mainSha);
  const featureSha = github.commit("feature", [mainSha]);
  github.setRef("refs/heads/feature", featureSha);

  const api = GitHubApi.layerFor(IMPLICIT).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ CHERNABOG_GITHUB_API: github.url })),
    ),
  );

  const repoSettings: RepoSettings = { ...settings, slug: SLUG, path: root };
  const host = yield* Effect.context<Exec | FileSystem.FileSystem>();

  const live = GitHubLive(repoSettings).pipe(
    Layer.provide(api),
    Layer.provide(Layer.merge(GitHubTokens.fixed("test-token"), Layer.succeedContext(host))),
  );

  const service = Context.get(yield* Layer.build(live), GitHub);

  return { github, service, mainSha, featureSha };
});

let nextRun = 100;

const workflowRun = (overrides: Partial<FakeWorkflowRun>): FakeWorkflowRun => {
  nextRun += 1;

  return {
    id: nextRun,
    name: "CI",
    workflowId: 1,
    event: "push",
    headSha: "",
    branch: "main",
    status: "completed",
    conclusion: Option.some("success"),
    log: "all good\n",
    ...overrides,
  };
};

describe("commitCiState", () => {
  atHome("is pending with nothing to wait on for a sha with no CI yet", () =>
    Effect.gen(function* () {
      const { github, mainSha, service } = yield* ciRepo;
      github.setChecks("none");

      const reading = yield* service.commitCiState(mainSha);
      expect(reading).toMatchObject({ state: "pending", waitingOn: [] });
      expect(reading.failedRuns).toEqual([]);
    }),
  );

  atHome("is red, with a link to the failed run, when a check run on the sha failed", () =>
    Effect.gen(function* () {
      const { github, mainSha, service } = yield* ciRepo;
      const failed = workflowRun({ headSha: mainSha, conclusion: Option.some("failure") });
      github.workflowRuns.push(failed);

      const reading = yield* service.commitCiState(mainSha);
      expect(reading).toMatchObject({ state: "red", failedChecks: ["CI"] });
      expect(reading.failedRuns).toHaveLength(1);
      expect(reading.failedRuns[0]?.url).toContain(`/actions/runs/${failed.id}`);
    }),
  );

  atHome("counts commit statuses as checks", () =>
    Effect.gen(function* () {
      const { github, mainSha, service } = yield* ciRepo;
      github.workflowRuns.push(workflowRun({ headSha: mainSha }));
      github.setStatus(mainSha, {
        id: 7,
        context: "ci/outside",
        state: "pending",
        targetUrl: "https://ci.example.com/7",
      });

      expect(yield* service.commitCiState(mainSha)).toMatchObject({
        state: "pending",
        waitingOn: ["ci/outside"],
      });

      github.setStatus(mainSha, {
        id: 8,
        context: "ci/outside",
        state: "failure",
        targetUrl: "https://ci.example.com/8",
      });

      const reading = yield* service.commitCiState(mainSha);
      expect(reading).toMatchObject({ state: "red", failedChecks: ["ci/outside"] });
      expect(reading.failedRuns.map((run) => run.url)).toEqual(["https://ci.example.com/8"]);
    }),
  );

  atHome("with event push, ignores a failed run on the sha that another event triggered", () =>
    Effect.gen(function* () {
      const { github, mainSha, service } = yield* ciRepo;
      github.workflowRuns.push(workflowRun({ headSha: mainSha, name: "CI" }));
      github.workflowRuns.push(
        workflowRun({
          headSha: mainSha,
          name: "Dependabot Updates",
          workflowId: 2,
          event: "dynamic",
          conclusion: Option.some("failure"),
        }),
      );

      expect(yield* service.commitCiState(mainSha)).toMatchObject({
        state: "red",
        failedChecks: ["Dependabot Updates"],
      });
      expect(yield* service.commitCiState(mainSha, { event: "push" })).toMatchObject({
        state: "green",
        failedRuns: [],
      });
    }),
  );

  atHome("doesn't read the branch-rules endpoint, so a 403 from it changes nothing", () =>
    Effect.gen(function* () {
      const { github, mainSha, service } = yield* ciRepo;
      github.refuseBranchRules();
      github.workflowRuns.push(workflowRun({ headSha: mainSha }));

      expect(yield* service.commitCiState(mainSha, { event: "push" })).toMatchObject({
        state: "green",
      });
    }),
  );
});

describe("branchCiState", () => {
  atHome("is red when the newest completed push run failed, though a later one runs", () =>
    Effect.gen(function* () {
      const { github, mainSha, service } = yield* ciRepo;
      github.workflowRuns.push(workflowRun({ headSha: "older" }));
      const failed = workflowRun({ headSha: "old", conclusion: Option.some("failure") });
      github.workflowRuns.push(failed);
      github.workflowRuns.push(
        workflowRun({ headSha: mainSha, status: "in_progress", conclusion: Option.none() }),
      );

      const reading = yield* service.branchCiState("main");
      expect(reading).toMatchObject({ state: "red", failedChecks: ["CI"] });
      expect(reading.failedRuns.map((run) => run.url)).toEqual([
        `https://github.com/${SLUG}/actions/runs/${failed.id}`,
      ]);
    }),
  );

  atHome("is green when each workflow's newest completed push run passed", () =>
    Effect.gen(function* () {
      const { github, mainSha, service } = yield* ciRepo;
      github.workflowRuns.push(workflowRun({ headSha: "old", conclusion: Option.some("failure") }));
      github.workflowRuns.push(workflowRun({ headSha: mainSha }));
      github.workflowRuns.push(workflowRun({ headSha: mainSha, name: "Docs", workflowId: 2 }));
      // Neither another branch's runs nor another event's count.
      github.workflowRuns.push(
        workflowRun({ branch: "feature", conclusion: Option.some("failure") }),
      );
      github.workflowRuns.push(
        workflowRun({ event: "schedule", conclusion: Option.some("failure") }),
      );

      expect(yield* service.branchCiState("main")).toMatchObject({
        state: "green",
        failedRuns: [],
      });
    }),
  );

  atHome("is pending while a workflow has no completed push run yet", () =>
    Effect.gen(function* () {
      const { github, mainSha, service } = yield* ciRepo;
      github.workflowRuns.push(
        workflowRun({ headSha: mainSha, status: "in_progress", conclusion: Option.none() }),
      );

      expect(yield* service.branchCiState("main")).toMatchObject({
        state: "pending",
        waitingOn: ["CI"],
      });
    }),
  );

  atHome("doesn't fail on a repo whose branch-rules endpoint answers 403", () =>
    Effect.gen(function* () {
      const { github, mainSha, service } = yield* ciRepo;
      github.refuseBranchRules();
      github.workflowRuns.push(workflowRun({ headSha: mainSha }));

      expect(yield* service.branchCiState("main")).toMatchObject({ state: "green" });
    }),
  );
});

describe("ciFailureDetails", () => {
  atHome("gives a failed run's link and the tail of its failing log", () =>
    Effect.gen(function* () {
      const { github, mainSha, service } = yield* ciRepo;
      const lines = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`);

      github.workflowRuns.push(
        workflowRun({
          headSha: mainSha,
          conclusion: Option.some("failure"),
          log: `${lines.join("\n")}\nError: the test failed\n`,
        }),
      );

      for (const reading of [
        yield* service.commitCiState(mainSha),
        yield* service.branchCiState("main"),
      ]) {
        const failed = Option.getOrThrow(Arr.head(reading.failedRuns));
        const details = yield* service.ciFailureDetails(failed);
        expect(details.url).toBe(failed.url);

        const tail = Option.getOrThrow(details.logTail);
        expect(tail).toContain("Error: the test failed");
        expect(tail).not.toContain("line 1\n");
      }
    }),
  );

  atHome("has no log for a commit status", () =>
    Effect.gen(function* () {
      const { github, mainSha, service } = yield* ciRepo;
      github.setChecks("none");
      github.setStatus(mainSha, {
        id: 9,
        context: "ci/outside",
        state: "error",
        targetUrl: "https://ci.example.com/9",
      });

      const failed = Option.getOrThrow(
        Arr.head((yield* service.commitCiState(mainSha)).failedRuns),
      );

      const details = yield* service.ciFailureDetails(failed);
      expect(details).toEqual({ url: "https://ci.example.com/9", logTail: Option.none() });
    }),
  );
});

describe("ciState on a repo whose branch-rules endpoint answers 403", () => {
  atHome("counts every check, and says so", () =>
    Effect.gen(function* () {
      const { github, service } = yield* ciRepo;
      github.refuseBranchRules();
      expect(github.addPull("A change", "feature", "alice", [])).toBe(1);

      const reading = yield* service.ciState(1);
      expect(reading).toMatchObject({ state: "green" });
      expect(reading.caveat).toContain("every check counts");

      github.setChecks("red");
      expect(yield* service.ciState(1)).toMatchObject({ state: "red", failedChecks: ["test"] });
    }),
  );

  atHome("says nothing extra when the endpoint answers", () =>
    Effect.gen(function* () {
      const { github, service } = yield* ciRepo;
      github.addPull("A change", "feature", "alice", []);

      expect(yield* service.ciState(1)).toEqual({ state: "green" });
    }),
  );
});

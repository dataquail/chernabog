// The epic recipe carrying a lower layer's change up its stack, on real git
// history behind the fake GitHub: a fix pushed on the bottom layer of a
// three-layer stack is merged into the layer above, then that one's new head
// into the layer above it, bottom to top. A layer whose refresh is a clean
// merge of its base keeps its approval, and no review round is counted. A
// refresh that needs a person holds that layer and the ones above it until
// the person hands it back, and then carries them.

import {
  Agent,
  type AgentRequest,
  type AgentResult,
  DEFAULT_LABELS,
  Epic,
  Plan,
  Repo,
  reviewMarker,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import epic from "../packages/recipes/flows/epic.ts";
import { IMPLICIT } from "../src/kernel/persona.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import {
  GitHubLive,
  GitLive,
  WorktreeLive,
} from "../src/modules/runs/infrastructure/runtime/sdk-live.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import type { HostEnvironment } from "../src/platform/environment.ts";
import { Exec, execOk } from "../src/platform/exec.ts";
import { GitHubApi } from "../src/platform/github-api.ts";
import { GitHubTokens } from "../src/platform/github-auth.ts";
import type { Home } from "../src/platform/home.ts";
import { startFakeGitHub } from "./acceptance/fake-github.ts";
import { effectAtHomeWith } from "./effect-test.ts";
import {
  deliverSignals,
  item,
  makeFake,
  repoAs,
  runUntil,
  settings,
  triggered,
} from "./sdk-fakes.ts";

const SLUG = "dataquail/demo";

// Each case runs three layers through real git and the fake GitHub, which
// takes about five seconds alone: more than bun's default timeout.
const STACK_TIMEOUT = 30_000;

// Polling for the next park goes on as long as the case may run, rather than
// runUntil's five seconds, which a busy machine's git outlasts.
const STACK_POLLS = STACK_TIMEOUT / 25;

// git runs for real.
const atHome = effectAtHomeWith(Exec.layer);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execOk("git", ["-C", cwd, ...args]).pipe(Effect.map((said) => said.trim()));

// Whether `ancestor` is in the history of `commit`.
const contains = (cwd: string, ancestor: string, commit: string) =>
  execOk("git", ["-C", cwd, "merge-base", "--is-ancestor", ancestor, commit]).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

// A bare origin, the repo's checkout and a person's clone: main with a.txt,
// and a stack of three layers, each a branch on the one below adding a file
// of its own, all pushed. Each layer's branch is its task's work branch.
// conflicting: the middle layer and the bottom layer's fix both change a.txt.
const history = (tasks: readonly [number, number, number], conflicting = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-epic-stack-" });
    const root = yield* fs.realPath(temporary);

    const origin = `${root}/origin.git`;
    const clone = `${root}/clone`;
    const checkout = `${root}/checkout`;

    yield* execOk("git", ["init", "--quiet", "--bare", "--initial-branch", "main", origin]);

    for (const path of [clone, checkout]) {
      yield* execOk("git", ["clone", "--quiet", origin, path]);
      yield* git(path, "config", "user.email", "test@example.com");
      yield* git(path, "config", "user.name", "Test");
    }

    const commit = (message: string, file: string, text: string) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(`${clone}/${file}`, text);
        yield* git(clone, "add", "--all");
        yield* git(clone, "commit", "--quiet", "-m", message);

        return yield* git(clone, "rev-parse", "HEAD");
      });

    yield* git(clone, "checkout", "--quiet", "-b", "main");
    yield* commit("base", "a.txt", "a\n");
    yield* git(clone, "push", "--quiet", "origin", "main");

    const heads: Array<string> = [];

    for (const task of tasks) {
      yield* git(clone, "checkout", "--quiet", "-b", `auto/issue-${task}`);

      if (conflicting && task === tasks[1]) {
        yield* fs.writeFileString(`${clone}/a.txt`, "middle\n");
      }

      heads.push(yield* commit(`task ${task}`, `task-${task}.txt`, `task ${task}\n`));
      yield* git(clone, "push", "--quiet", "origin", `auto/issue-${task}`);
    }

    // A fix pushed on the bottom layer, as an address-review round would:
    // its sha. Its services are the history's own, so the test can push it
    // while the run is parked.
    const exec = yield* Exec;

    const inClone = (...args: ReadonlyArray<string>) =>
      exec.run("git", ["-C", clone, ...args]).pipe(
        Effect.tap((result) =>
          Effect.when(
            Effect.die(`git ${args.join(" ")}: ${result.stderr}`),
            Effect.sync(() => result.exitCode !== 0),
          ),
        ),
        Effect.map((result) => result.stdout.trim()),
      );

    const fixBottom = Effect.gen(function* () {
      yield* inClone("checkout", "--quiet", `auto/issue-${tasks[0]}`);
      yield* fs.writeFileString(`${clone}/task-${tasks[0]}.txt`, "fixed\n");

      if (conflicting) {
        yield* fs.writeFileString(`${clone}/a.txt`, "bottom\n");
      }

      yield* inClone("commit", "--quiet", "--all", "-m", "bottom: fix");
      yield* inClone("push", "--quiet", "origin", `auto/issue-${tasks[0]}`);

      return yield* inClone("rev-parse", "HEAD");
    }).pipe(Effect.orDie);

    // A person bringing the middle layer up to date by hand, resolving
    // a.txt's conflict: the middle layer's new head.
    const resolveMiddle = Effect.gen(function* () {
      yield* inClone("checkout", "--quiet", `auto/issue-${tasks[1]}`);
      yield* exec.run("git", ["-C", clone, "merge", "--quiet", `auto/issue-${tasks[0]}`]);
      yield* fs.writeFileString(`${clone}/a.txt`, "both\n");
      yield* inClone("commit", "--quiet", "--all", "--no-edit");
      yield* inClone("push", "--quiet", "origin", `auto/issue-${tasks[1]}`);

      return yield* inClone("rev-parse", "HEAD");
    }).pipe(Effect.orDie);

    // The bottom layer squash-merged into main, as GitHub merges it: the
    // squash commit on main.
    const squashBottom = Effect.gen(function* () {
      yield* inClone("fetch", "--quiet", "origin");
      yield* inClone("checkout", "--quiet", "main");
      yield* inClone("merge", "--quiet", "--squash", `origin/auto/issue-${tasks[0]}`);
      yield* inClone("commit", "--quiet", "-m", `Task ${tasks[0]} (#${tasks[0]})`);
      yield* inClone("push", "--quiet", "origin", "main");

      return yield* inClone("rev-parse", "HEAD");
    }).pipe(Effect.orDie);

    return { origin, clone, checkout, heads, fixBottom, resolveMiddle, squashBottom };
  });

// The epic #1 over the three tasks, each a pull request on the branch of the
// one below that closes its task, run against the fake GitHub on
// `repoHistory` with git for real. The agent answers `answer` to every
// request, each recorded in `asked`. ship: the epic's layers are on the
// automated path, each labelled auto:ship.
const startEpic = (
  tasks: readonly [number, number, number],
  repoHistory: Effect.Success<ReturnType<typeof history>>,
  answer: AgentResult["output"],
  ship = false,
) =>
  Effect.gen(function* () {
    const github = yield* Effect.acquireRelease(
      Effect.sync(() => startFakeGitHub({ slug: SLUG, bare: repoHistory.origin })),
      (started) => Effect.promise(() => started.stop()),
    );

    const epicNumber = github.addIssue("An epic", [Plan.LABELS.epic]);
    expect(epicNumber).toBe(1);

    for (const task of tasks) {
      expect(github.addIssue(`Task ${task}`, [DEFAULT_LABELS.eligible])).toBe(task);
    }

    github.subIssues.set(epicNumber, [...tasks]);
    github.blockers.set(3, [2]);
    github.blockers.set(4, [3]);

    // Each task's pull request, on the branch of the one below.
    const pulls = tasks.map((task) =>
      github.addPull(`Task ${task}`, `auto/issue-${task}`, "chernabog-bot", []),
    );

    for (const [index, pull] of pulls.entries()) {
      github.pull(pull).body = `Closes #${tasks[index]}\nPart of #${epicNumber}`;

      if (ship) {
        github.pull(pull).labels.push(DEFAULT_LABELS.ship);
      }
    }

    const [, middle, top] = pulls;
    github.pull(middle).base = "auto/issue-2";
    github.pull(top).base = "auto/issue-3";

    // bob approved the middle layer as it was.
    github.submitReview(middle, "bob", "APPROVED", "Looks right.");

    const repoSettings = { ...settings, slug: SLUG, path: repoHistory.checkout };
    const host = yield* Effect.context<Exec | FileSystem.FileSystem | Home | HostEnvironment>();

    const api = GitHubApi.layerFor(IMPLICIT).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ CHERNABOG_GITHUB_API: github.url })),
      ),
    );

    // Every request is recorded, for the tests to check who was asked.
    const asked: Array<AgentRequest> = [];

    const agent = Layer.succeed(
      Agent,
      Agent.of({
        adapters: ["claude"],
        run: (request) =>
          Effect.sync(() => asked.push(request)).pipe(
            Effect.as({
              sessionId: request.sessionId,
              output: answer,
              costUsd: Option.none(),
            }),
          ),
      }),
    );

    const live = Layer.mergeAll(
      GitHubLive(repoSettings),
      GitLive(IMPLICIT),
      WorktreeLive(repoSettings, IMPLICIT),
      Layer.succeed(Repo, Repo.of(repoSettings)),
    ).pipe(
      Layer.provide(api),
      Layer.provide(Layer.merge(GitHubTokens.fixed("test-token"), Layer.succeedContext(host))),
    );

    const base = makeFake("approve");
    const fake = { ...base, services: Layer.mergeAll(base.services, live, agent) };
    const effective = repoAs(repoSettings);

    const working = flowHandle(
      {
        ...effective,
        personas: Arr.map(effective.personas, (persona) => ({
          ...persona,
          shared: Option.match(
            Option.liftPredicate(ship, (on) => on),
            {
              onNone: () => ({}),
              onSome: () => ({ ship: true }),
            },
          ),
        })),
      },
      "epic",
      epic,
    );

    // Each branch's head on origin.
    const headOf = (branch: string) =>
      Option.getOrElse(github.refSha(`refs/heads/${branch}`), () => "");

    // Runs the epic and, each time it parks, records each layer's head on
    // origin, does the next of `acts` and signals the change; once they are
    // done, stops at the next park.
    const throughParks = (acts: ReadonlyArray<Effect.Effect<void>>) =>
      Effect.gen(function* () {
        const parks: Array<ReadonlyArray<string>> = [];
        const answered = new Set<string>();
        let acted = 0;

        const run = yield* runUntil(
          working,
          fake,
          item(`issue-${epicNumber}`, { issue: epicNumber }),
          (current) =>
            Effect.gen(function* () {
              if (current.status !== "running") {
                return true;
              }

              const { waits } = yield* listRunWaitsHandler({
                runId: current.id,
                signal: Epic.LAYER_CHANGED,
              });

              const parked = Arr.findFirst(waits, (wait) => !answered.has(wait.deferred));

              if (Option.isNone(parked)) {
                return false;
              }

              if (parks.length === answered.size) {
                parks.push(tasks.map((task) => headOf(`auto/issue-${task}`)));
              }

              if (parks.length > acts.length) {
                return true;
              }

              if (acted < parks.length) {
                yield* acts[acted] ?? Effect.void;
                acted += 1;
              }

              const found = yield* triggered(fake, Epic.queued).pipe(Effect.orDie);

              if ((yield* deliverSignals(working, IMPLICIT, found)) > 0) {
                answered.add(parked.value.deferred);
              }

              return false;
            }),
          STACK_POLLS,
        );

        return { run, parks };
      });

    return { github, pulls, asked, throughParks };
  });

describe("epic: carrying a change up the stack", () => {
  atHome(
    "a fix pushed on layer 1 brings layer 2 and then layer 3 up to date, keeping a clean merge's approval",
    () =>
      Effect.gen(function* () {
        // The epic is #1 and its tasks #2, #3 and #4, each built on the one before.
        const tasks = [2, 3, 4] as const;
        const repoHistory = yield* history(tasks);

        const { asked, github, pulls, throughParks } = yield* startEpic(tasks, repoHistory, {
          status: "done",
          summary: "Nothing to adjust.",
        });

        const [bottom, middle, top] = pulls;

        // The fix is pushed after the first park.
        let fixed = "";

        const { parks, run } = yield* throughParks([
          repoHistory.fixBottom.pipe(
            Effect.map((sha) => {
              fixed = sha;
            }),
          ),
        ]);

        expect(run.status).toBe("running");
        expect(parks).toHaveLength(2);

        // First park: nothing had moved, so nothing was pushed.
        expect(parks[0]).toEqual(repoHistory.heads);

        // Second park: the middle layer merged the fix, then the top layer
        // merged the middle layer's new head.
        const [bottomHead = "", middleHead = "", topHead = ""] = parks[1] ?? [];
        expect(bottomHead).toBe(fixed);
        yield* git(repoHistory.clone, "fetch", "--quiet", "origin");

        const parentsOf = (sha: string) =>
          git(repoHistory.clone, "rev-list", "--parents", "-n", "1", sha).pipe(
            Effect.map((said) => said.split(" ").slice(1)),
          );

        expect(yield* parentsOf(middleHead)).toEqual([repoHistory.heads[1], fixed]);
        expect(yield* parentsOf(topHead)).toEqual([repoHistory.heads[2], middleHead]);
        expect(yield* contains(repoHistory.clone, fixed, topHead)).toBe(true);

        // The middle layer's head only merged its base: bob's approval stands,
        // and nobody is asked to review again.
        expect(github.reviewsOf(middle).map((review) => review.state)).toEqual(["APPROVED"]);
        expect(github.pull(middle).reviewers).toEqual([]);
        expect(github.pull(top).reviewers).toEqual([]);

        // No agent was needed, and no review round was counted on any layer.
        expect(asked).toEqual([]);

        for (const pull of [bottom, middle, top]) {
          expect(
            github
              .commentsOn(pull)
              .filter((posted) => Option.isSome(reviewMarker.read(posted.body))),
          ).toEqual([]);
          expect(github.pull(pull).labels).not.toContain(DEFAULT_LABELS.needsHuman);
        }
      }),
    STACK_TIMEOUT,
  );

  atHome(
    "a refresh that needs a person holds that layer and the ones above it until the person hands it back",
    () =>
      Effect.gen(function* () {
        const tasks = [2, 3, 4] as const;
        const repoHistory = yield* history(tasks, true);

        // The fix conflicts with the middle layer, and its author agent needs a person.
        const { asked, github, pulls, throughParks } = yield* startEpic(tasks, repoHistory, {
          status: "needs-clarification",
          summary: "Both changed a.txt.",
          questions: "Which a.txt should the middle layer keep?",
        });

        const [, middle, top] = pulls;

        let fixed = "";
        let resolved = "";

        const { parks, run } = yield* throughParks([
          repoHistory.fixBottom.pipe(
            Effect.map((sha) => {
              fixed = sha;
            }),
          ),
          // The person merges the fix by hand and hands the layer back.
          repoHistory.resolveMiddle.pipe(
            Effect.map((sha) => {
              resolved = sha;
              const labels = github.pull(middle).labels;
              labels.splice(labels.indexOf(DEFAULT_LABELS.needsHuman), 1);
            }),
          ),
        ]);

        expect(run.status).toBe("running");
        expect(parks).toHaveLength(3);

        // Second park: the middle layer went to a person, and the top layer
        // waited on it; the run carried on to park.
        expect(parks[1]).toEqual([fixed, repoHistory.heads[1], repoHistory.heads[2]]);
        expect(asked).toHaveLength(1);
        expect(
          github
            .commentsOn(middle)
            .filter((posted) =>
              posted.body.startsWith("Chernabog stopped bringing this layer up to date"),
            ),
        ).toHaveLength(1);
        expect(github.pull(top).labels).not.toContain(DEFAULT_LABELS.needsHuman);

        // Third park: handed back, the middle layer was already up to date,
        // and the top layer merged the person's head.
        const [, middleHead = "", topHead = ""] = parks[2] ?? [];
        expect(middleHead).toBe(resolved);
        yield* git(repoHistory.clone, "fetch", "--quiet", "origin");

        const parents = yield* git(repoHistory.clone, "rev-list", "--parents", "-n", "1", topHead);
        expect(parents.split(" ").slice(1)).toEqual([repoHistory.heads[2], resolved]);

        // Nothing new went to a person, and no agent was asked again.
        expect(asked).toHaveLength(1);
        expect(github.pull(middle).labels).not.toContain(DEFAULT_LABELS.needsHuman);
        expect(github.pull(top).labels).not.toContain(DEFAULT_LABELS.needsHuman);
      }),
    STACK_TIMEOUT,
  );
});

describe("epic: landing layers that ship", () => {
  atHome(
    "once the bottom layer squash-merges, the approved middle layer is moved onto main, brought up to date and merged",
    () =>
      Effect.gen(function* () {
        const tasks = [2, 3, 4] as const;
        const repoHistory = yield* history(tasks);

        const { asked, github, pulls, throughParks } = yield* startEpic(
          tasks,
          repoHistory,
          { status: "done", summary: "Nothing to adjust." },
          true,
        );

        const [bottom, middle, top] = pulls;

        // Chernabog's review approved the middle layer as it was.
        github.comments.set(middle, [
          ...github.commentsOn(middle),
          {
            id: 9001,
            body: reviewMarker.write({
              sha: repoHistory.heads[1],
              round: 1,
              verdict: "approve",
            }),
            user: { login: "bob" },
            author_association: "MEMBER",
            created_at: "2026-10-29T00:00:00Z",
          },
        ]);

        // After the first park, the bottom layer squash-merges into main, its
        // branch left in place, so nothing has moved the middle layer yet.
        const { run } = yield* throughParks([
          repoHistory.squashBottom.pipe(
            Effect.map((squash) => {
              github.pull(bottom).mergeCommit = squash;
              github.closePull(bottom);
              github.issue(tasks[0]).closed = true;
            }),
          ),
        ]);

        expect(run.status).toBe("running");

        // The run moved the middle layer onto main, reconciled the squash
        // without asking bob again, and merged it: its approval stood.
        expect(github.pull(middle).base).toBe("main");
        expect(github.pull(middle).merged).toBe(true);
        expect(github.merges.map((merged) => merged.number)).toEqual([middle]);
        expect(github.pull(middle).reviewers).toEqual([]);
        expect(github.issue(tasks[1]).closed).toBe(true);

        // The top layer is moved onto main too, and waits for its review.
        expect(github.pull(top).base).toBe("main");
        expect(github.pull(top).merged).toBe(false);

        // No agent was needed, and nothing went to a person.
        expect(asked).toEqual([]);

        for (const pull of [middle, top]) {
          expect(github.pull(pull).labels).not.toContain(DEFAULT_LABELS.needsHuman);
        }
      }),
    STACK_TIMEOUT,
  );
});

// While task #3 is implemented on task #2's branch, #2 squash-merges into main
// and GitHub deletes its branch. #3's agent writes `work`.
const mergedBelowMidTask = (work: { readonly path: string; readonly contents: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-epic-merged-" });
    const root = yield* fs.realPath(temporary);
    const origin = `${root}/origin.git`;
    const clone = `${root}/clone`;
    const checkout = `${root}/checkout`;

    yield* execOk("git", ["init", "--quiet", "--bare", "--initial-branch", "main", origin]);

    for (const path of [clone, checkout]) {
      yield* execOk("git", ["clone", "--quiet", origin, path]);
      yield* git(path, "config", "user.email", "test@example.com");
      yield* git(path, "config", "user.name", "Test");
    }

    // main, and task #2's layer on it, in review.
    yield* git(clone, "checkout", "--quiet", "-b", "main");
    yield* fs.writeFileString(`${clone}/a.txt`, "a\n");
    yield* git(clone, "add", "--all");
    yield* git(clone, "commit", "--quiet", "-m", "base");
    yield* git(clone, "push", "--quiet", "origin", "main");
    yield* git(clone, "checkout", "--quiet", "-b", "auto/issue-2");
    yield* fs.writeFileString(`${clone}/task-2.txt`, "task 2\n");
    yield* git(clone, "add", "--all");
    yield* git(clone, "commit", "--quiet", "-m", "task 2");
    yield* git(clone, "push", "--quiet", "origin", "auto/issue-2");

    const github = yield* Effect.acquireRelease(
      Effect.sync(() => startFakeGitHub({ slug: SLUG, bare: origin })),
      (started) => Effect.promise(() => started.stop()),
    );

    const epicNumber = github.addIssue("An epic", [Plan.LABELS.epic]);
    expect(github.addIssue("Task 2", [DEFAULT_LABELS.eligible])).toBe(2);
    expect(github.addIssue("Task 3", [DEFAULT_LABELS.eligible])).toBe(3);
    github.subIssues.set(epicNumber, [2, 3]);
    github.blockers.set(3, [2]);

    const bottom = github.addPull("Task 2", "auto/issue-2", "chernabog-bot", []);
    github.pull(bottom).body = `Closes #2\nPart of #${epicNumber}`;

    const exec = yield* Exec;

    const inClone = (...args: ReadonlyArray<string>) =>
      exec.run("git", ["-C", clone, ...args]).pipe(
        Effect.tap((result) =>
          Effect.when(
            Effect.die(`git ${args.join(" ")}: ${result.stderr}`),
            Effect.sync(() => result.exitCode !== 0),
          ),
        ),
        Effect.map((result) => result.stdout.trim()),
      );

    // While task #3 is implemented on #2's branch, #2 squash-merges into
    // main and GitHub deletes its branch.
    let squash = "";

    const agent = Layer.succeed(
      Agent,
      Agent.of({
        adapters: ["claude"],
        run: (request) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(`${request.cwd}/${work.path}`, work.contents);
            yield* exec.run("git", ["-C", request.cwd, "add", "--all"]);
            yield* exec.run("git", [
              "-C",
              request.cwd,
              "-c",
              "user.email=agent@example.com",
              "-c",
              "user.name=Agent",
              "commit",
              "--quiet",
              "-m",
              "task 3",
            ]);

            yield* inClone("checkout", "--quiet", "main");
            yield* inClone("merge", "--quiet", "--squash", "auto/issue-2");
            yield* inClone("commit", "--quiet", "-m", "Task 2 (#2)");
            yield* inClone("push", "--quiet", "origin", "main");
            squash = yield* inClone("rev-parse", "HEAD");
            github.pull(bottom).mergeCommit = squash;
            github.closePull(bottom);
            yield* inClone("push", "--quiet", "origin", "--delete", "auto/issue-2");
            github.issue(2).closed = true;

            return {
              sessionId: request.sessionId,
              output: {
                status: "done",
                summary: "Task 3.",
                title: "feat: task 3",
                body: "Task 3.",
              },
              costUsd: Option.none(),
            };
          }).pipe(Effect.orDie),
      }),
    );

    const repoSettings = { ...settings, slug: SLUG, path: checkout };
    const host = yield* Effect.context<Exec | FileSystem.FileSystem | Home | HostEnvironment>();

    const api = GitHubApi.layerFor(IMPLICIT).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ CHERNABOG_GITHUB_API: github.url })),
      ),
    );

    const live = Layer.mergeAll(
      GitHubLive(repoSettings),
      GitLive(IMPLICIT),
      WorktreeLive(repoSettings, IMPLICIT),
      Layer.succeed(Repo, Repo.of(repoSettings)),
    ).pipe(
      Layer.provide(api),
      Layer.provide(Layer.merge(GitHubTokens.fixed("test-token"), Layer.succeedContext(host))),
    );

    const base = makeFake("approve");
    const fake = { ...base, services: Layer.mergeAll(base.services, live, agent) };
    const working = flowHandle(repoAs(repoSettings), "epic", epic);

    const opened = () =>
      Arr.findFirst([...github.pulls.values()], (pull) => pull.head === "auto/issue-3");

    const run = yield* runUntil(
      working,
      fake,
      item(`issue-${epicNumber}`, { issue: epicNumber }),
      (current) => Effect.succeed(current.status !== "running" || Option.isSome(opened())),
      STACK_POLLS,
    );

    expect(run.status).toBe("running");

    // The pull request is on main, and its head has main's squash merged
    // in, so its diff is task #3's alone.
    const pull = Option.getOrThrow(opened());
    expect(pull.base).toBe("main");
    const head = Option.getOrElse(github.refSha("refs/heads/auto/issue-3"), () => "");
    expect(yield* contains(origin, squash, head)).toBe(true);
    const changed = yield* exec.run("git", ["-C", origin, "diff", "--name-only", squash, head]);
    expect(changed.stdout.trim()).toBe(work.path);
    expect(github.issue(3).labels).not.toContain(DEFAULT_LABELS.needsHuman);
  });

describe("epic: a layer below that merges while a task is implemented", () => {
  atHome(
    "the task's pull request opens on the branch that layer merged into, brought up to date with it",
    () => mergedBelowMidTask({ path: "task-3.txt", contents: "task 3\n" }),
    STACK_TIMEOUT,
  );

  atHome(
    "a task that edits what that layer added has its squash reconciled, not left in conflict",
    () => mergedBelowMidTask({ path: "task-2.txt", contents: "task 2, as task 3 needs it\n" }),
    STACK_TIMEOUT,
  );
});

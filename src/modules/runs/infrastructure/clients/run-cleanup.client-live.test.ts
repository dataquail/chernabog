import { claimMarker, Git, GitError, GitHub, type Json, Repo, Worktree } from "@chernabog/sdk";
import { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { effectAtHomeWith } from "../../../../../test/effect-test.ts";
import { settings } from "../../../../../test/sdk-fakes.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { Exec, execOk } from "../../../../platform/exec.ts";
import { Home } from "../../../../platform/home.ts";
import { RunCleanupClient } from "../../domain/ports/clients/run-cleanup.client.ts";
import { RunRoot } from "../../domain/run/run.root.ts";
import { LaunchRecord, sessionFiles } from "../runtime/agents/session-files.ts";
import { recordRunSession } from "../runtime/agents/sessions.ts";
import { RunCleanupClientLive } from "./run-cleanup.client-live.ts";

const run = (itemKey: string) =>
  RunRoot.make({
    id: RunId.make("run-1"),
    repo: "demo",
    persona: Option.some("bob"),
    flow: "implement",
    itemKey,
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    item: Option.none(),
    executionId: Option.some("x"),
    status: "cancelled",
    currentStep: Option.none(),
    summary: Option.none(),
    startedAt: "2026-10-24T00:00:00.000Z",
    finishedAt: Option.some("2026-10-24T01:00:00.000Z"),
  });

// What the fake GitHub is asked, and what it has: the claim comment on #7, the
// pull request opened from a branch, and how far a branch is ahead of main.
type GitHubState = {
  readonly calls: Array<string>;
  readonly bodies: Array<Option.Option<Json>>;
  claimedBy: string;
  pullFrom: Option.Option<number>;
  ahead: number;
  branchGone: boolean;
};

const github = (state: GitHubState) =>
  Layer.mock(GitHub)({
    comments: () =>
      Effect.succeed([
        {
          id: 1,
          author: "bob",
          createdAt: "t",
          trusted: true,
          body: `Claimed.\n\n${claimMarker.write({ runId: state.claimedBy, claimedAt: "t", branch: "auto/issue-7" })}`,
        },
      ]),
    removeLabel: (number, label) =>
      Effect.sync(() => {
        state.calls.push(`remove-label #${number} ${label}`);
      }),
    login: Effect.succeed("bob"),
    branchSha: () => Effect.succeed(Option.liftPredicate("sha", () => !state.branchGone)),
    pullRequestForBranch: () =>
      Effect.succeed(
        Option.map(state.pullFrom, (number) => ({
          number,
          title: "",
          body: "",
          url: "",
          state: "open" as const,
          headRef: "auto/issue-7",
          headSha: "sha",
          baseRef: "main",
          labels: [],
          author: "bob",
          assignees: [],
          requestedReviewers: [],
        })),
      ),
    deleteBranch: (branch) =>
      Effect.sync(() => {
        state.calls.push(`delete-branch ${branch}`);
      }),
    request: (method, path, body) =>
      Effect.sync(() => {
        state.calls.push(`${method} ${path}`);
        state.bodies.push(body);

        return { ahead_by: state.ahead };
      }),
  });

const gitLive = Layer.effect(
  Git,
  Effect.map(Effect.context<Exec>(), (context) =>
    Git.of({
      run: (args, cwd) =>
        execOk("git", args, { cwd }).pipe(
          Effect.mapError((error) => new GitError({ message: error.message })),
          Effect.provideContext(context),
        ),
      headSha: () => Effect.die("unused"),
      commitsAhead: () => Effect.die("unused"),
      changedFiles: () => Effect.die("unused"),
      push: () => Effect.die("unused"),
      pull: () => Effect.die("unused"),
    }),
  ),
);

// A clone of a bare origin, with its worktrees under `worktrees/`, and the
// client cleaning up as bob over it.
const opened = (state: GitHubState) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-cleanup-" }),
    );

    const git = (cwd: string, ...args: ReadonlyArray<string>) =>
      execOk("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });

    yield* git(root, "init", "--quiet", "--bare", "--initial-branch", "main", "origin.git");
    yield* git(root, "clone", "--quiet", `${root}/origin.git`, "checkout");

    const checkout = `${root}/checkout`;
    yield* git(checkout, "commit", "--quiet", "--allow-empty", "-m", "base");
    yield* git(checkout, "push", "--quiet", "origin", "main");

    const pathFor = (branch: string) => `${root}/worktrees/${branch.replace(/[^\w.-]+/g, "-")}`;

    const context = Layer.mergeAll(
      Layer.succeed(Repo, Repo.of({ ...settings, path: checkout, persona: "bob" })),
      github(state),
      gitLive,
      Layer.mock(Worktree)({ pathFor }),
    );

    const services = yield* Layer.build(context);

    const built = yield* Layer.build(
      RunCleanupClientLive((repo) =>
        Option.liftPredicate(Effect.succeed(services), () => repo === "demo"),
      ),
    );

    return { checkout, client: Context.get(built, RunCleanupClient), fs, git, pathFor };
  });

const freshState = (): GitHubState => ({
  calls: [],
  bodies: [],
  claimedBy: "run-1",
  pullFrom: Option.none(),
  ahead: 0,
  branchGone: false,
});

// git runs for real.
const effect = effectAtHomeWith(Exec.layer.pipe(Layer.provide(BunServices.layer)));

describe("RunCleanupClientLive", () => {
  effect("removes an issue's worktree that holds no work, and keeps one that does", () =>
    Effect.gen(function* () {
      const { checkout, client, fs, git, pathFor } = yield* opened(freshState());
      yield* git(
        checkout,
        "worktree",
        "add",
        "--quiet",
        "-b",
        "auto/issue-7",
        pathFor("auto/issue-7"),
      );
      yield* git(
        checkout,
        "worktree",
        "add",
        "--quiet",
        "-b",
        "auto/issue-8",
        pathFor("auto/issue-8"),
      );
      yield* fs.writeFileString(`${pathFor("auto/issue-8")}/notes.txt`, "half done");

      const clean = yield* client.removeWorktrees(run("issue-7"));
      const dirty = yield* client.removeWorktrees(run("issue-8"));

      expect(clean).toEqual({ removed: [pathFor("auto/issue-7")], kept: [] });
      expect(dirty).toEqual({
        removed: [],
        kept: [{ path: pathFor("auto/issue-8"), reason: "it has uncommitted changes" }],
      });
      expect(yield* fs.exists(pathFor("auto/issue-7"))).toBe(false);
      expect(yield* git(checkout, "branch", "--list", "auto/issue-*")).not.toContain("issue-7");
    }),
  );

  effect("keeps a branch with commits not pushed, and removes a detached review checkout", () =>
    Effect.gen(function* () {
      const { checkout, client, git, pathFor } = yield* opened(freshState());
      yield* git(
        checkout,
        "worktree",
        "add",
        "--quiet",
        "-b",
        "auto/issue-7",
        pathFor("auto/issue-7"),
      );
      yield* git(pathFor("auto/issue-7"), "commit", "--quiet", "--allow-empty", "-m", "wip");
      yield* git(
        checkout,
        "worktree",
        "add",
        "--quiet",
        "--detach",
        pathFor("review-pr-9@bob"),
        "origin/main",
      );
      // The pull request's commit, which no remote has once its branch is gone.
      yield* git(pathFor("review-pr-9@bob"), "commit", "--quiet", "--allow-empty", "-m", "theirs");

      expect(yield* client.removeWorktrees(run("issue-7"))).toEqual({
        removed: [],
        kept: [{ path: pathFor("auto/issue-7"), reason: "it has 1 commit not pushed" }],
      });
      expect(yield* client.removeWorktrees(run("pr-9"))).toEqual({
        removed: [pathFor("review-pr-9@bob")],
        kept: [],
      });
      expect(yield* client.removeWorktrees(run("nightly"))).toEqual({ removed: [], kept: [] });
    }),
  );

  effect("releases the run's claim: label, assignment, and a branch with no work", () =>
    Effect.gen(function* () {
      const state = freshState();
      const { client } = yield* opened(state);

      expect(yield* client.releaseClaim(run("issue-7"), 7)).toEqual(
        Option.some({ branch: "auto/issue-7", kept: Option.none() }),
      );
      expect(state.calls).toEqual([
        "remove-label #7 auto:in-progress",
        "DELETE /repos/dataquail/demo/issues/7/assignees",
        "GET /repos/dataquail/demo/compare/main...auto%2Fissue-7",
        "delete-branch auto/issue-7",
      ]);
      expect(state.bodies[0]).toEqual(Option.some({ assignees: ["bob"] }));
    }),
  );

  effect("keeps a claim branch with commits or a pull request from it", () =>
    Effect.gen(function* () {
      const ahead = { ...freshState(), ahead: 2 };
      const withPull = { ...freshState(), pullFrom: Option.some(12) };
      const kept = [];

      for (const state of [ahead, withPull]) {
        const { client } = yield* opened(state);
        kept.push(yield* client.releaseClaim(run("issue-7"), 7));
        expect(state.calls.some((call) => call.startsWith("delete-branch"))).toBe(false);
      }

      expect(kept).toEqual([
        Option.some({ branch: "auto/issue-7", kept: Option.some("it has 2 commits not on main") }),
        Option.some({
          branch: "auto/issue-7",
          kept: Option.some("pull request #12 was opened from it"),
        }),
      ]);
    }),
  );

  effect("leaves an issue another run claimed alone", () =>
    Effect.gen(function* () {
      const state = { ...freshState(), claimedBy: "run-2" };
      const { client } = yield* opened(state);

      expect(yield* client.releaseClaim(run("issue-7"), 7)).toEqual(Option.none());
      expect(state.calls).toEqual([]);
    }),
  );

  effect("finds the run's open sessions by their launch record, and closes one by its handle", () =>
    Effect.gen(function* () {
      const { client, fs } = yield* opened(freshState());
      const home = (yield* Home).root;
      const closed = `${home}/closed`;

      const account = {
        name: "work",
        configDir: Option.none(),
        expectedEmail: Option.none(),
        oauthTokenEnv: Option.none(),
        usageGate: "usage" as const,
      };

      for (const sessionId of ["open", "gone", "unlaunched"]) {
        yield* recordRunSession("run-1", "claude", sessionId, "/w", account);
      }

      for (const [sessionId, alive] of [
        ["open", "true"],
        ["gone", "false"],
      ] as const) {
        const files = sessionFiles(home, sessionId);
        yield* fs.makeDirectory(files.dir, { recursive: true });
        yield* fs.writeFileString(
          files.launch,
          yield* Schema.encodeEffect(LaunchRecord)({
            launcher: {
              name: "mine",
              from: "machine config",
              custom: Option.some({
                start: ["true"],
                close: ["sh", "-c", `echo {handle} > ${closed}`],
                alive: Option.some([alive]),
                attach: Option.none(),
              }),
            },
            handle: `handle-${sessionId}`,
            at: "t",
          }),
        );
      }

      const open = yield* client.openSessions(run("issue-7"));

      expect(open).toEqual([{ sessionId: "open", launcher: "mine", handle: "handle-open" }]);

      yield* client.closeSession(open[0]);

      const refused = yield* Effect.flip(
        client.closeSession({ sessionId: "unlaunched", launcher: "mine", handle: "h" }),
      );

      expect((yield* fs.readFileString(closed)).trim()).toBe("handle-open");
      expect(refused.message).toBe("no record of mine session h");
    }),
  );

  effect("a persona the repo no longer has can't clean up", () =>
    Effect.gen(function* () {
      const { client } = yield* opened(freshState());
      const elsewhere = RunRoot.make({ ...run("issue-7"), repo: "gone" });

      expect((yield* Effect.flip(client.removeWorktrees(elsewhere))).message).toBe(
        "bob no longer runs gone",
      );
    }),
  );
});

// Stack.refreshLayer on real git history behind the fake GitHub, with a
// stand-in for the author agent: a layer whose base moved is brought up to
// date and adjusted, and its reviewer asked again only when the new head is
// more than a clean merge of the base into the head they reviewed.

import {
  Agent,
  type AgentRequest,
  defineFlow,
  latestMarker,
  Repo,
  reviewMarker,
  sessionMarker,
  Stack,
  StepFailed,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { IMPLICIT } from "../src/kernel/persona.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import {
  GitHubLive,
  GitLive,
  WorktreeLive,
} from "../src/modules/runs/infrastructure/runtime/sdk-live.ts";
import type { HostEnvironment } from "../src/platform/environment.ts";
import { Exec, execOk } from "../src/platform/exec.ts";
import { GitHubApi } from "../src/platform/github-api.ts";
import { GitHubTokens } from "../src/platform/github-auth.ts";
import type { Home } from "../src/platform/home.ts";
import { startFakeGitHub } from "./acceptance/fake-github.ts";
import { effectAtHomeWith } from "./effect-test.ts";
import { item, makeFake, repo, runToEnd, settings, summaryOf } from "./sdk-fakes.ts";

const SLUG = "dataquail/demo";
const LOWER = "auto/issue-1";
const UPPER = "auto/issue-2";

// The fake's first pull request: the upper layer, stacked on the lower one.
const PULL = 1;

// The session the implement run left its marker for.
const AUTHOR_SESSION = "author-session-2";

// git runs for real.
const atHome = effectAtHomeWith(Exec.layer);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execOk("git", ["-C", cwd, ...args]).pipe(Effect.map((said) => said.trim()));

const lines = (...values: ReadonlyArray<string>) => `${values.join("\n")}\n`;

const A_LINES = ["line 1", "line 2", "line 3", "line 4", "line 5"];

// a.txt with one of its lines replaced.
const aWith = (line: number, value: string) => lines(...A_LINES.toSpliced(line - 1, 1, value));

// A bare origin, the repo's checkout, a person's clone where the lower layer
// is written, and the upper layer's worktree: main with a.txt, the lower layer
// adding lower.txt, and the upper layer on it changing line 5 of a.txt and
// adding upper.txt, all pushed.
const history = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-refresh-" });
  const root = yield* fs.realPath(temporary);

  const origin = `${root}/origin.git`;
  const clone = `${root}/clone`;
  const checkout = `${root}/checkout`;
  const layer = `${root}/layer`;

  yield* execOk("git", ["init", "--quiet", "--bare", "--initial-branch", "main", origin]);

  for (const path of [clone, checkout, layer]) {
    yield* execOk("git", ["clone", "--quiet", origin, path]);
    yield* git(path, "config", "user.email", "test@example.com");
    yield* git(path, "config", "user.name", "Test");
  }

  const commit = (cwd: string, message: string, files: Readonly<Record<string, string>>) =>
    Effect.gen(function* () {
      for (const [name, content] of Object.entries(files)) {
        yield* fs.writeFileString(`${cwd}/${name}`, content);
      }

      yield* git(cwd, "add", "--all");
      yield* git(cwd, "commit", "--quiet", "-m", message);

      return yield* git(cwd, "rev-parse", "HEAD");
    });

  yield* git(clone, "checkout", "--quiet", "-b", "main");
  yield* commit(clone, "base", { "a.txt": lines(...A_LINES), "b.txt": lines("b") });
  yield* git(clone, "push", "--quiet", "origin", "main");
  yield* git(clone, "checkout", "--quiet", "-b", LOWER);
  yield* commit(clone, "lower", { "lower.txt": lines("lower") });
  yield* git(clone, "push", "--quiet", "origin", LOWER);

  yield* git(layer, "fetch", "--quiet", "origin");
  yield* git(layer, "checkout", "--quiet", "-b", UPPER, `origin/${LOWER}`);

  const reviewed = yield* commit(layer, "upper", {
    "a.txt": aWith(5, "upper"),
    "upper.txt": lines("upper"),
  });

  yield* git(layer, "push", "--quiet", "--set-upstream", "origin", UPPER);

  // The lower layer gets another commit, as a fix round on it would.
  const moveLower = (files: Readonly<Record<string, string>>) =>
    Effect.gen(function* () {
      const moved = yield* commit(clone, "lower: fix", files);
      yield* git(clone, "push", "--quiet", "origin", LOWER);

      return moved;
    });

  return { root, origin, checkout, layer, reviewed, moveLower };
});

type History = Effect.Success<typeof history>;

// The author agent's stand-in: what it does in the worktree it is given.
type Author = (cwd: string) => Effect.Effect<void, unknown, Exec | FileSystem.FileSystem>;

// Writes a file and commits it in `cwd` with git's `args`.
const commitIn = (cwd: string, file: string, text: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* (yield* FileSystem.FileSystem).writeFileString(`${cwd}/${file}`, text);
    yield* git(cwd, "commit", "--quiet", "--all", ...args);
  });

// Refreshes the upper layer for the base at `baseSha`, under the engine, with
// real git and the fake's API: the pull request approved by bob at its head,
// and the session marker the implement run left.
const refreshOn = (repoHistory: History, baseSha: string, author: Author = () => Effect.void) =>
  Effect.gen(function* () {
    const github = yield* Effect.acquireRelease(
      Effect.sync(() => startFakeGitHub({ slug: SLUG, bare: repoHistory.origin })),
      (started) => Effect.promise(() => started.stop()),
    );

    expect(github.addPull("The upper layer", UPPER, "chernabog-bot", [])).toBe(PULL);
    github.pull(PULL).base = LOWER;

    github.comments.set(PULL, [
      {
        id: 1,
        body: `Implemented by claude for #2. ${sessionMarker.write({
          adapter: "claude",
          sessionId: AUTHOR_SESSION,
          issue: 2,
          branch: UPPER,
        })}`,
        user: { login: "chernabog-bot" },
        author_association: "OWNER",
        created_at: "2026-10-28T00:00:00Z",
      },
      {
        id: 2,
        body: `Approved at \`${repoHistory.reviewed.slice(0, 7)}\`. ${reviewMarker.write({
          sha: repoHistory.reviewed,
          round: 1,
          verdict: "approve",
          reviewer: "bob",
        })}`,
        user: { login: "bob" },
        author_association: "OWNER",
        created_at: "2026-10-28T00:01:00Z",
      },
    ]);

    github.submitReview(PULL, "bob", "APPROVED", "Looks right.");

    const repoSettings = { ...settings, slug: SLUG, path: repoHistory.checkout };
    const host = yield* Effect.context<Exec | FileSystem.FileSystem | Home | HostEnvironment>();

    const api = GitHubApi.layerFor(IMPLICIT).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ CHERNABOG_GITHUB_API: github.url })),
      ),
    );

    const asked: Array<AgentRequest> = [];

    const agent = Layer.succeed(
      Agent,
      Agent.of({
        adapters: ["claude"],
        run: (request) =>
          Effect.sync(() => asked.push(request)).pipe(
            Effect.andThen(author(request.cwd)),
            Effect.provide(host),
            Effect.orDie,
            Effect.as({
              sessionId: request.sessionId,
              output: {
                status: "done",
                summary: "Adjusted to the lower layer's fix.",
                title: "feat: the upper layer",
                body: "The upper layer.",
              },
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

    const flow = defineFlow({
      trigger: Effect.succeed([]),
      workflow: () =>
        Stack.refreshLayer(repoHistory.layer, {
          pullRequest: PULL,
          branch: UPPER,
          base: LOWER,
          baseSha,
        }).pipe(
          Effect.map((refreshed) =>
            [
              `adjusted: ${refreshed.adjusted}`,
              `asked: ${Option.getOrElse(refreshed.askedAgain, () => "nobody")}`,
            ].join(", "),
          ),
          Effect.catchTags({
            NothingCommitted: (nothing) =>
              Effect.fail(new StepFailed({ step: "refresh", message: nothing.message })),
            PushRejected: (rejected) =>
              Effect.fail(new StepFailed({ step: "refresh", message: rejected.message })),
            CiTimedOut: (timedOut) =>
              Effect.fail(new StepFailed({ step: "refresh", message: timedOut.message })),
            PullRequestClosed: (closed) =>
              Effect.fail(new StepFailed({ step: "refresh", message: closed.message })),
            NotFound: (gone) =>
              Effect.fail(new StepFailed({ step: "refresh", message: gone.message })),
          }),
        ),
    });

    const fake = makeFake("approve");

    const finished = yield* runToEnd(
      flowHandle(repo, "demo", flow),
      { ...fake, services: Layer.mergeAll(fake.services, live, agent) },
      item("refresh"),
    );

    const head = yield* git(repoHistory.layer, "rev-parse", "HEAD");
    const pushed = Option.getOrElse(github.refSha(`refs/heads/${UPPER}`), () => "");
    const bodies = github.commentsOn(PULL).map((posted) => posted.body);

    return {
      finished,
      github,
      asked,
      head,
      pushed,
      bodies,
      // The review round the pull request is on, as its markers count it.
      round: Option.map(latestMarker(reviewMarker.read, bodies), (marker) => marker.round),
      reviewMarkers: bodies.filter((body) => Option.isSome(reviewMarker.read(body))).length,
    };
  });

const parentsOf = (cwd: string, sha: string) =>
  git(cwd, "rev-list", "--parents", "-n", "1", sha).pipe(
    Effect.map((said) => said.split(" ").slice(1)),
  );

describe("Stack.refreshLayer", () => {
  atHome(
    "a clean moved base with nothing to adjust pushes a merge-only head and keeps the approval",
    () =>
      Effect.gen(function* () {
        const repoHistory = yield* history;
        const moved = yield* repoHistory.moveLower({ "lower.txt": lines("lower, fixed") });

        const refreshed = yield* refreshOn(repoHistory, moved);

        expect(refreshed.finished.status).toBe("done");
        expect(summaryOf(refreshed.finished)).toBe("adjusted: false, asked: nobody");
        expect(refreshed.asked).toEqual([]);
        expect(refreshed.pushed).toBe(refreshed.head);
        expect(yield* parentsOf(repoHistory.layer, refreshed.head)).toEqual([
          repoHistory.reviewed,
          moved,
        ]);
        expect(refreshed.github.pull(PULL).reviewers).toEqual([]);
        expect(refreshed.round).toEqual(Option.some(1));
        expect(refreshed.reviewMarkers).toBe(1);
      }),
  );

  atHome("a base change to what the layer builds on is adjusted, pushed and reviewed again", () =>
    Effect.gen(function* () {
      const repoHistory = yield* history;
      // The lower layer changes line 1 of a.txt, which the upper layer edits too.
      const moved = yield* repoHistory.moveLower({ "a.txt": aWith(1, "lower") });

      const refreshed = yield* refreshOn(repoHistory, moved, (cwd) =>
        commitIn(
          cwd,
          "upper.txt",
          lines("upper, adjusted"),
          "-m",
          "upper: adjust to the lower fix",
        ),
      );

      expect(refreshed.finished.status).toBe("done");
      expect(summaryOf(refreshed.finished)).toBe("adjusted: true, asked: bob");
      expect(refreshed.asked).toHaveLength(1);
      expect(refreshed.asked[0]?.sessionId).toBe(AUTHOR_SESSION);
      expect(refreshed.asked[0]?.prompt).toContain("+lower");
      expect(refreshed.asked[0]?.prompt).toContain("a.txt");
      expect(refreshed.pushed).toBe(refreshed.head);
      expect(yield* git(repoHistory.layer, "log", "-1", "--format=%s", refreshed.head)).toBe(
        "upper: adjust to the lower fix",
      );
      expect(refreshed.github.pull(PULL).reviewers).toEqual(["bob"]);
      expect(refreshed.round).toEqual(Option.some(1));
      expect(refreshed.reviewMarkers).toBe(1);
    }),
  );

  atHome("a conflict with the moved base is resolved by the agent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoHistory = yield* history;
      // The lower layer changes line 5 of a.txt, which the upper layer changed.
      const moved = yield* repoHistory.moveLower({ "a.txt": aWith(5, "lower") });

      const refreshed = yield* refreshOn(repoHistory, moved, (cwd) =>
        commitIn(cwd, "a.txt", aWith(5, "upper and lower"), "--no-edit"),
      );

      expect(refreshed.finished.status).toBe("done");
      expect(summaryOf(refreshed.finished)).toBe("adjusted: true, asked: bob");
      expect(refreshed.asked).toHaveLength(1);
      expect(refreshed.asked[0]?.prompt).toContain("conflict");
      expect(yield* fs.readFileString(`${repoHistory.layer}/a.txt`)).toBe(
        aWith(5, "upper and lower"),
      );
      expect(refreshed.pushed).toBe(refreshed.head);
      expect(yield* parentsOf(repoHistory.layer, refreshed.head)).toEqual([
        repoHistory.reviewed,
        moved,
      ]);
      expect(refreshed.github.pull(PULL).reviewers).toEqual(["bob"]);
      expect(refreshed.round).toEqual(Option.some(1));
      expect(refreshed.reviewMarkers).toBe(1);
    }),
  );

  atHome("a conflict the agent leaves unresolved goes to a person, unpushed", () =>
    Effect.gen(function* () {
      const repoHistory = yield* history;
      const moved = yield* repoHistory.moveLower({ "a.txt": aWith(5, "lower") });

      const refreshed = yield* refreshOn(repoHistory, moved);

      expect(refreshed.finished.status).toBe("needs-human");
      expect(summaryOf(refreshed.finished)).toContain("a.txt");
      expect(refreshed.pushed).toBe(repoHistory.reviewed);
      expect(refreshed.github.pull(PULL).reviewers).toEqual([]);
    }),
  );

  atHome("a base it already holds needs nothing", () =>
    Effect.gen(function* () {
      const repoHistory = yield* history;
      const lowerHead = yield* git(repoHistory.layer, "rev-parse", `origin/${LOWER}`);

      const refreshed = yield* refreshOn(repoHistory, lowerHead);

      expect(refreshed.finished.status).toBe("done");
      expect(summaryOf(refreshed.finished)).toBe("adjusted: false, asked: nobody");
      expect(refreshed.asked).toEqual([]);
      expect(refreshed.head).toBe(repoHistory.reviewed);
      expect(refreshed.pushed).toBe(repoHistory.reviewed);
    }),
  );
});

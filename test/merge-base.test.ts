// PullRequest.merge on real git history behind the fake GitHub: an approval
// survives a head that only merged its base in cleanly, and nothing else.

import {
  defineFlow,
  NeedsHuman,
  PullRequest,
  Repo,
  reviewMarker,
  StepFailed,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

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

// The fake's first pull request.
const PULL = 1;

// A refused merge hands the pull request to a person, as mergeOrLeave does.
const flow = defineFlow({
  trigger: Effect.succeed([]),
  workflow: () =>
    PullRequest.merge(PULL, { method: "squash" }).pipe(
      Effect.catchTags({
        MergeRefused: (refused) => Effect.fail(new NeedsHuman({ reason: refused.message })),
        PullRequestClosed: (closed) =>
          Effect.fail(new StepFailed({ step: "merge", message: closed.message })),
        NotFound: (gone) => Effect.fail(new StepFailed({ step: "merge", message: gone.message })),
      }),
    ),
});

const handle = flowHandle(repo, "demo", flow);

// git runs for real.
const atHome = effectAtHomeWith(Exec.layer);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execOk("git", ["-C", cwd, ...args]).pipe(Effect.map((said) => said.trim()));

// A bare origin, the repo's checkout of it, and a person's clone, with main at
// one commit and the pull request's branch one change on, which review 1 approved.
const history = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-merge-" });

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

  const commitFile = (file: string, text: string, message: string) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(`${clone}/${file}`, text);
      yield* git(clone, "add", file);
      yield* git(clone, "commit", "--quiet", "-m", message);
    });

  yield* git(clone, "checkout", "--quiet", "-b", "main");
  yield* commitFile("shared.txt", "base\n", "base");
  yield* git(clone, "push", "--quiet", "origin", "main");
  yield* git(clone, "checkout", "--quiet", "-b", "feature");
  yield* commitFile("feature.txt", "feature\n", "the change");
  yield* git(clone, "push", "--quiet", "origin", "feature");

  // Someone moves main on, as another pull request merging would.
  const moveBase = (file: string, text: string) =>
    Effect.gen(function* () {
      yield* git(clone, "checkout", "--quiet", "main");
      yield* commitFile(file, text, `main: ${file}`);
      yield* git(clone, "push", "--quiet", "origin", "main");
      yield* git(clone, "checkout", "--quiet", "feature");
    });

  // Merges main into the branch, as `gh pr update-branch` does; it fails on a conflict.
  const mergeBase = Effect.gen(function* () {
    yield* git(clone, "fetch", "--quiet", "origin");
    yield* git(clone, "merge", "--quiet", "--no-ff", "--no-edit", "origin/main");
  });

  // Pushes the branch: its head.
  const push = Effect.gen(function* () {
    yield* git(clone, "push", "--quiet", "origin", "feature");

    return yield* git(clone, "rev-parse", "HEAD");
  });

  return { root, origin, clone, checkout, commitFile, moveBase, mergeBase, push };
});

type History = Effect.Success<typeof history>;

const short = (sha: string) => sha.slice(0, 7);

// Opens the pull request on the fake, approved by review 1 at `reviewed`, and
// runs PullRequest.merge on it with real git and the fake's API.
const mergeOn = (repoHistory: History, reviewed: string, checks: "green" | "red" = "green") =>
  Effect.gen(function* () {
    const github = yield* Effect.acquireRelease(
      Effect.sync(() => startFakeGitHub({ slug: SLUG, bare: repoHistory.origin, checks })),
      (started) => Effect.promise(() => started.stop()),
    );

    expect(github.addPull("A change", "feature", "alice", [])).toBe(PULL);

    github.comments.set(PULL, [
      {
        id: 1,
        body: reviewMarker.write({ sha: reviewed, round: 1, verdict: "approve" }),
        user: { login: "bob" },
        author_association: "OWNER",
        created_at: "2026-10-28T00:00:00Z",
      },
    ]);

    const repoSettings = { ...settings, slug: SLUG, path: repoHistory.checkout };
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

    const fake = makeFake("approve");

    const finished = yield* runToEnd(
      handle,
      { ...fake, services: Layer.merge(fake.services, live) },
      item("merge"),
    );

    return { finished, github };
  });

const headOf = (repoHistory: History) => git(repoHistory.clone, "rev-parse", "HEAD");

describe("PullRequest.merge after the head moved since the approval", () => {
  atHome("merges a head that only merged its base in cleanly", () =>
    Effect.gen(function* () {
      const repoHistory = yield* history;
      const reviewed = yield* headOf(repoHistory);
      yield* repoHistory.moveBase("main.txt", "main\n");
      yield* repoHistory.mergeBase;
      const head = yield* repoHistory.push;

      const { finished, github } = yield* mergeOn(repoHistory, reviewed);
      expect(summaryOf(finished)).toBe(`#${PULL} merged (squash) as \`${short(head)}\``);
      expect(finished.status).toBe("done");
      expect(github.merges).toEqual([{ number: PULL, method: "squash", by: "chernabog-bot" }]);
    }),
  );

  atHome("merges a head that merged its base in cleanly twice", () =>
    Effect.gen(function* () {
      const repoHistory = yield* history;
      const reviewed = yield* headOf(repoHistory);
      yield* repoHistory.moveBase("main.txt", "main\n");
      yield* repoHistory.mergeBase;
      yield* repoHistory.moveBase("later.txt", "later\n");
      yield* repoHistory.mergeBase;
      yield* repoHistory.push;

      const { finished, github } = yield* mergeOn(repoHistory, reviewed);
      expect(finished.status).toBe("done");
      expect(github.merges).toHaveLength(1);
    }),
  );

  atHome("refuses a merge of the base where someone resolved a conflict", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoHistory = yield* history;
      const { clone } = repoHistory;
      // The branch and main each change shared.txt, so merging main conflicts.
      yield* repoHistory.commitFile("shared.txt", "feature side\n", "the change, more");
      const reviewed = yield* repoHistory.push;
      yield* repoHistory.moveBase("shared.txt", "main side\n");
      expect(Result.isFailure(yield* Effect.result(repoHistory.mergeBase))).toBe(true);
      yield* fs.writeFileString(`${clone}/shared.txt`, "resolved by hand\n");
      yield* git(clone, "add", "shared.txt");
      yield* git(clone, "commit", "--quiet", "--no-edit");
      const head = yield* repoHistory.push;

      const { finished, github } = yield* mergeOn(repoHistory, reviewed);
      expect(finished.status).toBe("needs-human");
      expect(summaryOf(finished)).toContain(`\`${short(head)}\` is not a clean merge of \`main\``);
      expect(github.merges).toEqual([]);
    }),
  );

  atHome("refuses a merge of the base with edits of its own", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoHistory = yield* history;
      const { clone } = repoHistory;
      const reviewed = yield* headOf(repoHistory);
      yield* repoHistory.moveBase("main.txt", "main\n");
      yield* repoHistory.mergeBase;
      yield* fs.writeFileString(`${clone}/extra.txt`, "slipped in\n");
      yield* git(clone, "add", "extra.txt");
      yield* git(clone, "commit", "--quiet", "--amend", "--no-edit");
      const head = yield* repoHistory.push;

      const { finished, github } = yield* mergeOn(repoHistory, reviewed);
      expect(finished.status).toBe("needs-human");
      expect(summaryOf(finished)).toContain(`\`${short(head)}\` is not a clean merge of \`main\``);
      expect(github.merges).toEqual([]);
    }),
  );

  atHome("refuses a head with an ordinary commit since the review", () =>
    Effect.gen(function* () {
      const repoHistory = yield* history;
      const reviewed = yield* headOf(repoHistory);
      yield* repoHistory.moveBase("main.txt", "main\n");
      yield* repoHistory.mergeBase;
      yield* repoHistory.commitFile("feature.txt", "changed after review\n", "more");
      const head = yield* repoHistory.push;

      const { finished, github } = yield* mergeOn(repoHistory, reviewed);
      expect(finished.status).toBe("needs-human");

      expect(summaryOf(finished)).toContain(
        `the head moved to \`${short(head)}\` since review 1 saw \`${short(reviewed)}\``,
      );

      expect(summaryOf(finished)).toContain(`\`${short(head)}\` is not a merge of \`main\``);
      expect(github.merges).toEqual([]);
    }),
  );

  atHome("refuses a clean merge of the base when checks fail on it", () =>
    Effect.gen(function* () {
      const repoHistory = yield* history;
      const reviewed = yield* headOf(repoHistory);
      yield* repoHistory.moveBase("main.txt", "main\n");
      yield* repoHistory.mergeBase;
      yield* repoHistory.push;

      const { finished, github } = yield* mergeOn(repoHistory, reviewed, "red");
      expect(finished.status).toBe("needs-human");
      expect(summaryOf(finished)).toContain("checks failed: test");
      expect(github.merges).toEqual([]);
    }),
  );
});

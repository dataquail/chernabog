// Stack.updateFromBase against real git: a layer of a stack brought up to date
// with its base when the layer below got new commits, and when the layer below
// merged into main, by a merge commit, a squash or a rebase.

import { GitHub, type PullRequest, Repo, Stack } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { GitLive } from "../src/modules/runs/infrastructure/runtime/sdk-live.ts";
import { Exec, execOk } from "../src/platform/exec.ts";
import { GitHubTokens } from "../src/platform/github-auth.ts";
import { effectAtHomeWith } from "./effect-test.ts";
import { settings } from "./sdk-fakes.ts";

const LOWER = 1;
const LOWER_BRANCH = "auto/issue-1";
const UPPER_BRANCH = "auto/issue-2";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execOk("git", ["-C", cwd, ...args]).pipe(Effect.map((said) => said.trim()));

// Whether git refuses the command, as a merge with conflicts does.
const gitFails = (cwd: string, ...args: ReadonlyArray<string>) =>
  git(cwd, ...args).pipe(
    Effect.as(false),
    Effect.orElseSucceed(() => true),
  );

// A bare origin and two clones of it: `main`, where the layers are written and
// merged as GitHub would, and `upper`, the upper layer's worktree.
class Repos extends Context.Service<
  Repos,
  { readonly origin: string; readonly main: string; readonly upper: string }
>()("test/Repos") {}

// The lower pull request as GitHub reports it, and its merge commit: the
// test sets both once it has merged the lower layer.
type LowerState = { pull: PullRequest; mergeCommit: Option.Option<string> };

const lower: LowerState = {
  pull: {
    number: LOWER,
    title: "Lower layer",
    body: "",
    url: "https://github.com/dataquail/demo/pull/1",
    state: "open",
    headRef: LOWER_BRANCH,
    headSha: "",
    baseRef: "main",
    labels: [],
    author: "chernabog-bot",
    assignees: [],
    requestedReviewers: [],
  },
  mergeCommit: Option.none(),
};

const lines = (...values: ReadonlyArray<string>) => `${values.join("\n")}\n`;

const A_LINES = ["line 1", "line 2", "line 3", "line 4", "line 5"];

// The five lines of a.txt on main.
const aBase = lines(...A_LINES);

// a.txt with one of its lines replaced.
const aWith = (line: number, value: string) => lines(...A_LINES.toSpliced(line - 1, 1, value));

const repos = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-stack-" }),
    );

    const origin = `${root}/origin.git`;
    const main = `${root}/main`;
    const upper = `${root}/upper`;

    yield* execOk("git", ["init", "--quiet", "--bare", "--initial-branch", "main", origin]);

    for (const clone of [main, upper]) {
      yield* execOk("git", ["clone", "--quiet", origin, clone]);
      yield* git(clone, "config", "user.email", "test@example.com");
      yield* git(clone, "config", "user.name", "Test");
    }

    lower.pull = { ...lower.pull, state: "open", headSha: "" };
    lower.mergeCommit = Option.none();

    return Layer.mergeAll(
      Layer.succeed(Repos, Repos.of({ origin, main, upper })),
      Layer.succeed(Repo, Repo.of(settings)),
      Layer.mock(GitHub)({
        pullRequest: () => Effect.sync(() => lower.pull),
        request: (method, path) =>
          Effect.sync(() => {
            expect(`${method} ${path}`).toBe(`GET /repos/dataquail/demo/pulls/${LOWER}`);

            return { number: LOWER, merge_commit_sha: Option.getOrNull(lower.mergeCommit) };
          }),
      }),
      GitLive(Option.none()),
    ).pipe(Layer.provide(GitHubTokens.fixed("token")));
  }).pipe(Effect.orDie),
);

// Writes files and commits them in `cwd`.
const commit = (cwd: string, message: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    for (const [name, content] of Object.entries(files)) {
      yield* fs.writeFileString(`${cwd}/${name}`, content);
    }

    yield* git(cwd, "add", "--all");
    yield* git(cwd, "commit", "--quiet", "-m", message);

    return yield* git(cwd, "rev-parse", "HEAD");
  });

// main with a.txt, the lower layer changing line 2 of it, and the upper layer
// cut from the lower one, with `upperChange` on top, all pushed. The upper
// clone has the upper layer checked out.
const stack = (upperChange: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const { main, upper } = yield* Repos;
    yield* commit(main, "base", { "a.txt": aBase, "b.txt": lines("b") });
    yield* git(main, "push", "--quiet", "origin", "HEAD:refs/heads/main");

    yield* git(main, "checkout", "--quiet", "-b", LOWER_BRANCH);
    yield* commit(main, "lower: line 2", { "a.txt": aWith(2, "lower") });
    yield* commit(main, "lower: notes", { "notes.txt": lines("lower notes") });
    yield* git(main, "push", "--quiet", "origin", LOWER_BRANCH);
    lower.pull = { ...lower.pull, headSha: yield* git(main, "rev-parse", "HEAD") };

    yield* git(upper, "fetch", "--quiet", "origin");
    yield* git(upper, "checkout", "--quiet", "-b", UPPER_BRANCH, `origin/${LOWER_BRANCH}`);
    yield* commit(upper, "upper", upperChange);
    yield* git(main, "checkout", "--quiet", "main");
  });

// Commits on main and pushes it.
const onMain = (message: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const { main } = yield* Repos;
    const sha = yield* commit(main, message, files);
    yield* git(main, "push", "--quiet", "origin", "main");

    return sha;
  });

// Squash-merges the lower layer into main, as GitHub does: one commit with
// the tree of main and the lower layer merged, and only main as its parent.
const squashLower = Effect.gen(function* () {
  const { main } = yield* Repos;
  yield* git(main, "merge", "--quiet", "--squash", LOWER_BRANCH);
  yield* git(main, "commit", "--quiet", "-m", `Lower layer (#${LOWER})`);
  yield* git(main, "push", "--quiet", "origin", "main");
  const sha = yield* git(main, "rev-parse", "HEAD");
  lower.pull = { ...lower.pull, state: "merged" };
  lower.mergeCommit = Option.some(sha);

  return sha;
});

// Rebase-merges it: each of its commits replayed on main.
const rebaseLower = Effect.gen(function* () {
  const { main } = yield* Repos;
  const fork = yield* git(main, "merge-base", "main", LOWER_BRANCH);
  yield* git(main, "cherry-pick", `${fork}..${LOWER_BRANCH}`);
  yield* git(main, "push", "--quiet", "origin", "main");
  const sha = yield* git(main, "rev-parse", "HEAD");
  lower.pull = { ...lower.pull, state: "merged" };
  lower.mergeCommit = Option.some(sha);

  return sha;
});

// Merges it with a merge commit.
const mergeLower = Effect.gen(function* () {
  const { main } = yield* Repos;
  yield* git(main, "merge", "--quiet", "--no-ff", "-m", `Merge #${LOWER}`, LOWER_BRANCH);
  yield* git(main, "push", "--quiet", "origin", "main");
  const sha = yield* git(main, "rev-parse", "HEAD");
  lower.pull = { ...lower.pull, state: "merged" };
  lower.mergeCommit = Option.some(sha);

  return sha;
});

// What the upper layer's pull request would show against its base.
const ownDiff = (base: string) =>
  Effect.gen(function* () {
    const { upper } = yield* Repos;
    yield* git(upper, "fetch", "--quiet", "origin");

    return yield* git(upper, "diff", "--name-only", `origin/${base}...HEAD`);
  });

const fileIn = (name: string) =>
  Effect.gen(function* () {
    const { upper } = yield* Repos;

    return yield* (yield* FileSystem.FileSystem).readFileString(`${upper}/${name}`);
  });

// A clone of the upper layer at its head before the update, to try a plain merge on.
const plainMergeConflicts = (head: string) =>
  Effect.gen(function* () {
    const { origin } = yield* Repos;
    const fs = yield* FileSystem.FileSystem;
    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-plain-" });
    yield* execOk("git", ["clone", "--quiet", origin, scratch]);
    yield* git(scratch, "config", "user.email", "test@example.com");
    yield* git(scratch, "config", "user.name", "Test");
    yield* git(scratch, "fetch", "--quiet", (yield* Repos).upper, head);
    yield* git(scratch, "checkout", "--quiet", "--detach", head);

    if (!(yield* gitFails(scratch, "merge", "--no-edit", "origin/main"))) {
      return [];
    }

    return (yield* git(scratch, "diff", "--name-only", "--diff-filter=U")).split("\n");
  });

// git runs for real.
const atHome = effectAtHomeWith(Exec.layer);

describe("Stack.updateFromBase", () => {
  atHome("a base that moved is merged in", () =>
    Effect.gen(function* () {
      const { main, upper } = yield* Repos;
      yield* stack({ "b.txt": lines("upper") });
      const before = lower.pull.headSha;

      yield* git(main, "checkout", "--quiet", LOWER_BRANCH);
      const moved = yield* commit(main, "lower: more", { "c.txt": lines("more") });
      yield* git(main, "push", "--quiet", "origin", LOWER_BRANCH);
      lower.pull = { ...lower.pull, headSha: moved };

      const synced = yield* Stack.updateFromBase(upper, { base: LOWER_BRANCH, lower: LOWER });

      expect(synced).toEqual({
        clean: true,
        conflicts: [],
        base: LOWER_BRANCH,
        oldBase: before,
        newBase: moved,
        reconciled: false,
      });
      expect(yield* fileIn("c.txt")).toBe(lines("more"));
      expect(yield* ownDiff(LOWER_BRANCH)).toBe("b.txt");
    }).pipe(Effect.provide(repos)),
  );

  atHome("a squash-merged layer below that the layer doesn't touch the lines of", () =>
    Effect.gen(function* () {
      const { upper } = yield* Repos;
      yield* stack({ "b.txt": lines("upper") });
      const squashed = yield* squashLower;

      const synced = yield* Stack.updateFromBase(upper, { base: LOWER_BRANCH, lower: LOWER });

      expect(synced).toEqual({
        clean: true,
        conflicts: [],
        base: "main",
        oldBase: lower.pull.headSha,
        newBase: squashed,
        reconciled: true,
      });
      expect(yield* ownDiff("main")).toBe("b.txt");
    }).pipe(Effect.provide(repos)),
  );

  atHome(
    "a squash-merged layer below whose lines the layer edits merges cleanly, where a plain merge conflicts",
    () =>
      Effect.gen(function* () {
        const { upper } = yield* Repos;
        yield* stack({ "a.txt": aWith(2, "upper") });
        const head = yield* git(upper, "rev-parse", "HEAD");
        yield* squashLower;

        expect(yield* plainMergeConflicts(head)).toEqual(["a.txt"]);

        const synced = yield* Stack.updateFromBase(upper, { base: LOWER_BRANCH, lower: LOWER });

        expect(synced.clean).toBe(true);
        expect(synced.reconciled).toBe(true);
        expect(yield* fileIn("a.txt")).toBe(aWith(2, "upper"));
        expect(yield* ownDiff("main")).toBe("a.txt");
        expect(yield* git(upper, "diff", "origin/main...HEAD", "--", "a.txt")).toContain(
          "-lower\n+upper",
        );
      }).pipe(Effect.provide(repos)),
  );

  atHome("a squash with unrelated commits on main before and after it", () =>
    Effect.gen(function* () {
      const { upper } = yield* Repos;
      yield* stack({ "a.txt": aWith(2, "upper") });
      yield* onMain("unrelated before", { "before.txt": lines("before") });
      yield* squashLower;
      const after = yield* onMain("unrelated after", { "after.txt": lines("after") });

      const synced = yield* Stack.updateFromBase(upper, { base: LOWER_BRANCH, lower: LOWER });

      expect(synced).toEqual({
        clean: true,
        conflicts: [],
        base: "main",
        oldBase: lower.pull.headSha,
        newBase: after,
        reconciled: true,
      });
      expect(yield* fileIn("before.txt")).toBe(lines("before"));
      expect(yield* fileIn("after.txt")).toBe(lines("after"));
      expect(yield* ownDiff("main")).toBe("a.txt");
    }).pipe(Effect.provide(repos)),
  );

  atHome("a genuine conflict with another change on main is reported, not hidden", () =>
    Effect.gen(function* () {
      const { upper } = yield* Repos;
      yield* stack({ "a.txt": aWith(2, "upper"), "b.txt": lines("upper") });
      yield* squashLower;
      yield* onMain("main edits line 2 too", { "a.txt": aWith(2, "main") });

      const synced = yield* Stack.updateFromBase(upper, { base: LOWER_BRANCH, lower: LOWER });

      expect(synced.clean).toBe(false);
      expect(synced.conflicts).toEqual(["a.txt"]);
      expect(synced.reconciled).toBe(true);

      // The agent resolves it, keeping the upper layer's line, and commits the merge.
      yield* (yield* FileSystem.FileSystem).writeFileString(`${upper}/a.txt`, aWith(2, "upper"));
      yield* git(upper, "commit", "--quiet", "--all", "--no-edit");
      expect(yield* ownDiff("main")).toBe("a.txt\nb.txt");
    }).pipe(Effect.provide(repos)),
  );

  atHome("a rebase-merged layer below is reconciled like a squash", () =>
    Effect.gen(function* () {
      const { upper } = yield* Repos;
      yield* stack({ "a.txt": aWith(2, "upper") });
      yield* onMain("unrelated before", { "before.txt": lines("before") });
      const rebased = yield* rebaseLower;

      const synced = yield* Stack.updateFromBase(upper, { base: LOWER_BRANCH, lower: LOWER });

      expect(synced).toEqual({
        clean: true,
        conflicts: [],
        base: "main",
        oldBase: lower.pull.headSha,
        newBase: rebased,
        reconciled: true,
      });
      expect(yield* ownDiff("main")).toBe("a.txt");
    }).pipe(Effect.provide(repos)),
  );

  atHome("a layer below merged with a merge commit is merged in plainly", () =>
    Effect.gen(function* () {
      const { upper } = yield* Repos;
      yield* stack({ "a.txt": aWith(2, "upper") });
      const merged = yield* mergeLower;

      const synced = yield* Stack.updateFromBase(upper, { base: LOWER_BRANCH, lower: LOWER });

      expect(synced).toEqual({
        clean: true,
        conflicts: [],
        base: "main",
        oldBase: lower.pull.headSha,
        newBase: merged,
        reconciled: false,
      });
      expect(yield* ownDiff("main")).toBe("a.txt");
    }).pipe(Effect.provide(repos)),
  );
});

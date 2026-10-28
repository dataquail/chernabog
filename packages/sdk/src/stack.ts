// The blocks of a stack of pull requests, each layer built on the one below:
// bringing a layer up to date with its base, by merging only. Nothing is
// rebased or force-pushed, so a layer's history is never rewritten.

import {
  activity,
  Git,
  GitHub,
  type Json,
  type PullRequest,
  Repo,
  StepFailed,
} from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { baseOf } from "./implement.ts";

// base: the branch the layer is built on now, the repo's base branch unless
// given. lower: the pull request of the layer below, whose head branch is
// `base` until it merges. id: tells apart two updates in one run, as
// Implement's RepeatOptions do.
export type UpdateOptions = {
  readonly base?: string;
  readonly lower?: number;
  readonly id?: string;
};

// What updating did. clean: the merge is committed; otherwise it is left in
// progress with `conflicts` unresolved, for the agent to resolve and commit as
// resolve-conflicts does, and updating again (with another id) finishes it.
// base: the branch the layer is now built on, the lower layer's base once it
// merged. oldBase and newBase: what the layer's own changes were against
// before, and the base's head merged in now. reconciled: the lower layer's
// squash or rebase was recorded as already contained.
export const Updated = Schema.Struct({
  clean: Schema.Boolean,
  conflicts: Schema.Array(Schema.String),
  base: Schema.String,
  oldBase: Schema.String,
  newBase: Schema.String,
  reconciled: Schema.Boolean,
});

export type Updated = typeof Updated.Type;

const MergeCommit = Schema.Struct({ merge_commit_sha: Schema.OptionFromNullOr(Schema.String) });

const step = "update-from-base";

// The commit GitHub made merging the pull request.
const mergeCommitOf = (pullRequest: number) =>
  Effect.gen(function* () {
    const repo = yield* Repo;

    const answer = yield* (yield* GitHub)
      .request("GET", `/repos/${repo.slug}/pulls/${pullRequest}`, Option.none())
      .pipe(
        Effect.flatMap((json: Json) => Schema.decodeUnknownEffect(MergeCommit)(json)),
        Effect.mapError((error) => new StepFailed({ step, message: error.message })),
      );

    return yield* Effect.fromOption(answer.merge_commit_sha).pipe(
      Effect.mapError(
        () => new StepFailed({ step, message: `#${pullRequest} has no merge commit` }),
      ),
    );
  });

const output = (said: string) => said.trim();

const lines = (said: string) =>
  said
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

// Whether `ancestor` is in HEAD's history. git exits 1 for no, and fails
// alike for a commit it doesn't have, which HEAD's history can't hold either.
const contains = (worktree: string, ancestor: string) =>
  Git.use((git) => git.run(["merge-base", "--is-ancestor", ancestor, "HEAD"], worktree)).pipe(
    Effect.as(true),
    Effect.catchTag("GitError", () => Effect.succeed(false)),
  );

// Merges `ref` into HEAD. One that conflicts is left in progress, and its
// conflicted paths returned; any other failure stays a failure.
const merge = (worktree: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const git = yield* Git;

    return yield* git.run(["merge", "--no-edit", ...args], worktree).pipe(
      Effect.as<ReadonlyArray<string>>([]),
      Effect.catchTag("GitError", (error) =>
        git.run(["diff", "--name-only", "--diff-filter=U"], worktree).pipe(
          Effect.map(lines),
          Effect.filterOrFail(
            (conflicts) => conflicts.length > 0,
            () => error,
          ),
        ),
      ),
    );
  });

// The commits a squash or rebase put on the base for the lower layer: those
// at the tip of the base's first-parent line, ending at `merged`, whose change
// the lower layer's head has (git cherry's "-"). A squash's one commit
// matches none of the layer's commits, and is one commit too.
const mergedCount = (worktree: string, lowerHead: string, merged: string) =>
  Effect.gen(function* () {
    const git = yield* Git;
    const fork = output(yield* git.run(["merge-base", lowerHead, merged], worktree));
    const marks = lines(yield* git.run(["cherry", lowerHead, merged, fork], worktree));
    const count = Arr.takeWhile(Arr.reverse(marks), (mark) => mark.startsWith("-")).length;

    return Math.max(count, 1);
  });

// Merges the base the lower layer squash- or rebase-merged into, in three
// steps. The base as it was before the lower layer's commits is merged
// normally, so its conflicts are real ones. Those commits are recorded as
// merged with `-s ours`, sound because they are exactly the lower layer's
// change, which this layer already holds: it is built on the head that
// merged. The rest of the base is then merged normally. A plain merge would
// instead see this layer's edits of lines the lower layer added as a conflict.
const reconcile = (worktree: string, base: string, lowerHead: string, merged: string) =>
  Effect.gen(function* () {
    const count = yield* mergedCount(worktree, lowerHead, merged);
    const before = yield* merge(worktree, [`${merged}~${count}`]);

    if (before.length > 0) {
      return { conflicts: before, reconciled: false };
    }

    const message = `Merge ${merged.slice(0, 7)}, the layer below as ${base} merged it, already here`;
    yield* merge(worktree, ["-s", "ours", "-m", message, merged]);

    return { conflicts: yield* merge(worktree, [`origin/${base}`]), reconciled: true };
  });

// The layer below's pull request, when there is one.
const lowerPull = (options: UpdateOptions) =>
  Option.match(Option.fromUndefinedOr(options.lower), {
    onNone: () => Effect.succeed(Option.none<PullRequest>()),
    onSome: (number) => GitHub.use((github) => github.pullRequest(number)).pipe(Effect.asSome),
  });

// Brings the layer checked out in `worktree` up to date with its base, by
// merging: the base's new commits when it moved, such as the layer below
// getting more; or, once the layer below merged, the branch it merged into.
// A merge commit is merged plainly. A squash or rebase is reconciled when this
// layer is built on the head that merged, and merged plainly otherwise.
export const updateFromBase = (worktree: string, options: UpdateOptions = {}) =>
  Effect.gen(function* () {
    const git = yield* Git;
    const given = yield* baseOf(options);
    const below = Option.filter(yield* lowerPull(options), (pull) => pull.state === "merged");

    const base = Option.match(below, { onNone: () => given, onSome: (pull) => pull.baseRef });
    yield* git.run(["fetch", "--quiet", "origin", base], worktree);

    const newBase = output(yield* git.run(["rev-parse", `origin/${base}`], worktree));

    const forkPoint = git
      .run(["merge-base", "HEAD", `origin/${base}`], worktree)
      .pipe(Effect.map(output));

    const done = (
      oldBase: string,
      merged: { conflicts: ReadonlyArray<string>; reconciled: boolean },
    ) => ({
      clean: merged.conflicts.length === 0,
      conflicts: [...merged.conflicts],
      base,
      oldBase,
      newBase,
      reconciled: merged.reconciled,
    });

    const plainly = Effect.gen(function* () {
      const oldBase = yield* forkPoint;

      return done(oldBase, {
        conflicts: yield* merge(worktree, [`origin/${base}`]),
        reconciled: false,
      });
    });

    if (Option.isNone(below)) {
      return yield* plainly;
    }

    const lowerHead = below.value.headSha;
    const merged = yield* mergeCommitOf(below.value.number);
    const parents = yield* git.run(["rev-list", "--parents", "-n", "1", merged], worktree);
    // One parent: a squash or rebase. A merge commit has two.
    const squashed = output(parents).split(" ").length === 2;

    if (
      !squashed ||
      !(yield* contains(worktree, lowerHead)) ||
      (yield* contains(worktree, merged))
    ) {
      return yield* plainly;
    }

    return done(lowerHead, yield* reconcile(worktree, base, lowerHead, merged));
  }).pipe(
    Effect.catchTag("GitError", (error) =>
      Effect.fail(new StepFailed({ step, message: error.message })),
    ),
  );

// updateFromBase as a durable step: the merge is made once, and a replay
// returns what it did.
export const syncBase = (worktree: string, options: UpdateOptions = {}) =>
  activity(
    Option.match(Option.fromUndefinedOr(options.id), {
      onNone: () => step,
      onSome: (id) => `${step}#${id}`,
    }),
    updateFromBase(worktree, options),
    Updated,
  );

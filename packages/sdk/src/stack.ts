// The blocks of a stack of pull requests, each layer built on the one below:
// bringing a layer up to date with its base, by merging only, and adjusting
// it to what moved. Nothing is rebased or force-pushed, so a layer's history
// is never rewritten.

import {
  activity,
  Git,
  GitHub,
  type Json,
  NeedsHuman,
  type PullRequest,
  Repo,
  SessionMarker,
  StepFailed,
} from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { REFRESH } from "./default-prompts.ts";
import {
  type AuthorSession,
  baseOf,
  fixWithAgent,
  localGate,
  push,
  waitForCi,
} from "./implement.ts";
import { renderPromptOr } from "./prompt.ts";
import { onlyMergedBase } from "./pull-request.ts";
import { decisiveReviews, findAuthorSession, requestAgain } from "./review.ts";

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
// before, and the base's head merged in now; oldBase is the lower head
// whenever the lower layer's squash or rebase is being reconciled, finished
// or not. reconciled: that squash or rebase was recorded as already
// contained. It is false while a conflict in the base before the lower
// layer's commits stops the reconcile short, so a flow reads `reconciled`,
// not `oldBase`, to tell whether the reconcile got that far.
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

// Whether `descendant` holds `ancestor` in its history.
const holds = (worktree: string, descendant: string, ancestor: string) =>
  Git.use((git) => git.run(["merge-base", "--is-ancestor", ancestor, descendant], worktree)).pipe(
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
// matches none of the layer's commits, and is one commit too. A commit on the
// base just before them whose change matches one of the layer's would be
// counted too, and recorded with them rather than merged; that is still sound,
// since its change is one this layer already holds.
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

const ClosedPull = Schema.Struct({
  number: Schema.Finite,
  merged_at: Schema.OptionFromNullOr(Schema.String),
  merge_commit_sha: Schema.OptionFromNullOr(Schema.String),
  head: Schema.Struct({ sha: Schema.String }),
});

// The pull requests closed lately into `base`, newest first, one page.
const closedInto = (base: string) =>
  Effect.gen(function* () {
    const repo = yield* Repo;
    const query = `state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc&per_page=30`;

    return yield* (yield* GitHub)
      .request("GET", `/repos/${repo.slug}/pulls?${query}`, Option.none())
      .pipe(
        Effect.flatMap((json: Json) => Schema.decodeUnknownEffect(Schema.Array(ClosedPull))(json)),
        Effect.mapError(
          (error) => new StepFailed({ step: "merged-below", message: error.message }),
        ),
      );
  });

// The layer below the one checked out in `worktree` that squash- or
// rebase-merged into `base` without this layer recording it: a pull request
// merged lately into `base` whose head is in this layer's history and whose
// merge commit isn't. Its number, for updateFromBase's `lower`; none when
// there is none. It is for a layer whose pull request already moved onto
// `base`, as GitHub moves one when the branch below it is deleted, so its
// layer below is no longer its base: merging `base` plainly would see this
// layer's edits of lines the layer below added as conflicts, and bring back
// files `base` has since moved or deleted (#311). With two such layers below,
// it is the higher one, whose head holds the other's.
export const mergedBelow = (worktree: string, base: string) =>
  Effect.gen(function* () {
    const git = yield* Git;
    yield* git.run(["fetch", "--quiet", "origin", base], worktree);

    const found: Array<{ number: number; head: string }> = [];

    for (const pull of yield* closedInto(base)) {
      if (Option.isNone(pull.merged_at) || Option.isNone(pull.merge_commit_sha)) {
        continue;
      }

      if (
        (yield* contains(worktree, pull.head.sha)) &&
        !(yield* contains(worktree, pull.merge_commit_sha.value))
      ) {
        found.push({ number: pull.number, head: pull.head.sha });
      }
    }

    // The one no other found head is built on.
    for (const candidate of found) {
      let highest = true;

      for (const other of found) {
        if (
          other.number !== candidate.number &&
          (yield* holds(worktree, other.head, candidate.head))
        ) {
          highest = false;
        }
      }

      if (highest) {
        return Option.some(candidate.number);
      }
    }

    return Option.none<number>();
  }).pipe(
    Effect.catchTag("GitError", (error) =>
      Effect.fail(new StepFailed({ step: "merged-below", message: error.message })),
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

// The layer a refresh brings up to date: its pull request and branch, the
// base it is built on and the layer below's pull request, as updateFromBase
// takes them, and baseSha, the head of the base the caller saw move, which
// keys every step: a loop refreshes a layer once per base move. attempt: the
// caller's count of refreshes at that baseSha, which keys the steps too after
// the first, so a refresh handed to a person and back runs again rather than
// replaying the outcome it saved. session: the author's session to resume, the
// one the implementing run's marker on the pull request names unless given.
export type LayerRefresh = {
  readonly pullRequest: number;
  readonly branch: string;
  readonly base?: string;
  readonly lower?: number;
  readonly baseSha: string;
  readonly attempt?: number;
  readonly session?: AuthorSession;
};

// What a refresh did. upToDate: the layer already held its base, so nothing
// was pushed. adjusted: the author agent was asked to resolve conflicts or
// adjust the layer. askedAgain: the reviewer asked to review again, none when
// the new head only merged the base into the head they reviewed, or nobody
// has reviewed it.
export type Refreshed = {
  readonly upToDate: boolean;
  readonly adjusted: boolean;
  readonly askedAgain: Option.Option<string>;
};

// The most lines of the base's diff a prompt carries; the agent reads the rest itself.
const DIFF_LINES = 400;

const BaseChange = Schema.Struct({
  upToDate: Schema.Boolean,
  touched: Schema.Array(Schema.String),
  diff: Schema.String,
});

// What the merge brought in, against what the layer changes itself: whether
// it changed anything, the files the base changed that the layer changes too,
// and the base's diff of them.
const baseChange = (worktree: string, before: string, synced: Updated) =>
  Effect.gen(function* () {
    const git = yield* Git;

    if (synced.clean && output(yield* git.headSha(worktree)) === before) {
      return { upToDate: true, touched: [], diff: "" };
    }

    const own = new Set(
      lines(yield* git.run(["diff", "--name-only", synced.oldBase, before], worktree)),
    );

    const touched = lines(
      yield* git.run(["diff", "--name-only", synced.oldBase, synced.newBase], worktree),
    ).filter((path) => own.has(path));

    if (touched.length === 0) {
      return { upToDate: false, touched, diff: "" };
    }

    const diff = (yield* git.run(
      ["diff", synced.oldBase, synced.newBase, "--", ...touched],
      worktree,
    )).split("\n");

    const shown = diff.slice(0, DIFF_LINES);

    if (diff.length > DIFF_LINES) {
      shown.push(`… ${diff.length - DIFF_LINES} more lines`);
    }

    return { upToDate: false, touched, diff: shown.join("\n").trimEnd() };
  }).pipe(
    Effect.catchTag("GitError", (error) =>
      Effect.fail(new StepFailed({ step: "refresh", message: error.message })),
    ),
  );

const describeMerge = (synced: Updated) => {
  if (synced.clean) {
    return "The merge is committed; nothing conflicted.";
  }

  return [
    "The merge is left in progress, with these files in conflict:",
    "",
    ...synced.conflicts.map((path) => `- ${path}`),
  ].join("\n");
};

// Fails with NeedsHuman when the agent left the merge uncommitted, or edits it
// didn't commit, which the push would leave behind.
const mergeCommitted = (name: string, worktree: string) =>
  activity(
    name,
    Effect.gen(function* () {
      const git = yield* Git;

      const inProgress = yield* git
        .run(["rev-parse", "--quiet", "--verify", "MERGE_HEAD"], worktree)
        .pipe(
          Effect.as(true),
          Effect.catchTag("GitError", () => Effect.succeed(false)),
        );

      if (!inProgress) {
        const uncommitted = lines(
          yield* git
            .run(["status", "--porcelain"], worktree)
            .pipe(Effect.catchTag("GitError", () => Effect.succeed(""))),
        );

        if (uncommitted.length === 0) {
          return;
        }

        return yield* new NeedsHuman({
          reason: `the author agent left changes it didn't commit: ${uncommitted.join(", ")}`,
        });
      }

      const conflicts = lines(
        yield* git
          .run(["diff", "--name-only", "--diff-filter=U"], worktree)
          .pipe(Effect.catchTag("GitError", () => Effect.succeed(""))),
      );

      return yield* new NeedsHuman({
        reason: `the author agent left the merge of the moved base uncommitted, with conflicts in ${conflicts.join(", ")}`,
      });
    }),
  );

// After the push: the latest approval or request for changes stands when the
// new head only merged the base into the head it saw (PullRequest.onlyMergedBase),
// and otherwise its reviewer is asked again. The reviewer, or none. Checked
// against `base`, the branch the refresh merged in, not the base GitHub still
// reports, which is the layer below's until the pull request is retargeted.
const reviewAfterRefresh = (name: string, pullRequest: number, base: string, said: string) =>
  activity(
    name,
    Effect.gen(function* () {
      const latest = Arr.last(yield* decisiveReviews(pullRequest));

      if (Option.isNone(latest)) {
        return Option.none<string>();
      }

      const pull = yield* GitHub.use((github) => github.pullRequest(pullRequest));
      const since = yield* onlyMergedBase({ ...pull, baseRef: base }, latest.value.commitSha);

      if (since.only) {
        return Option.none<string>();
      }

      yield* requestAgain(pullRequest, latest.value.author, said);

      return Option.some(latest.value.author);
    }).pipe(
      Effect.catchTag("GitError", (error) =>
        Effect.fail(new StepFailed({ step: name, message: error.message })),
      ),
    ),
    Schema.Option(Schema.String),
  );

// Brings a layer whose base moved up to date, outside the review rounds: it
// merges the base in (syncBase); when that conflicts, or the base changed
// files the layer changes too, it resumes the author's session with the
// base's diff, to resolve the conflicts and adjust the layer's own code, test
// first where behaviour changes (its prompt is .chernabog/prompts/refresh.md,
// or the SDK's own). Then it runs the local gate, pushes against the base,
// and waits for CI. A head that only merged the base keeps its review;
// otherwise the last reviewer is asked again. It writes no review marker, so
// it never counts against limits.reviewRounds. Every step is keyed by the
// pull request and baseSha, and by the attempt after the first. Fails as push and waitForCi do, and with
// NeedsHuman when the agent needs a person, leaves the merge unfinished, or
// leaves edits uncommitted.
export const refreshLayer = (worktree: string, layer: LayerRefresh) =>
  Effect.gen(function* () {
    const again = Option.match(
      Option.filter(Option.fromUndefinedOr(layer.attempt), (attempt) => attempt > 1),
      { onNone: () => "", onSome: (attempt) => `-${attempt}` },
    );

    const key = `${layer.pullRequest}-${layer.baseSha.slice(0, 12)}${again}`;

    const before = yield* activity(
      `refresh-head-${key}`,
      Git.use((git) => git.headSha(worktree)).pipe(
        Effect.map(output),
        Effect.catchTag("GitError", (error) =>
          Effect.fail(new StepFailed({ step: "refresh", message: error.message })),
        ),
      ),
      Schema.String,
    );

    const synced = yield* syncBase(worktree, {
      ...Option.match(Option.fromUndefinedOr(layer.base), {
        onNone: () => ({}),
        onSome: (base) => ({ base }),
      }),
      ...Option.match(Option.fromUndefinedOr(layer.lower), {
        onNone: () => ({}),
        onSome: (lower) => ({ lower }),
      }),
      id: `refresh-${key}`,
    });

    const change = yield* activity(
      `refresh-diff-${key}`,
      baseChange(worktree, before, synced),
      BaseChange,
    );

    if (change.upToDate) {
      return { upToDate: true, adjusted: false, askedAgain: Option.none() } satisfies Refreshed;
    }

    const session = yield* Option.match(Option.fromUndefinedOr(layer.session), {
      onSome: Effect.succeed,
      onNone: () =>
        activity(
          `refresh-author-${key}`,
          findAuthorSession(layer.pullRequest, `refresh-${key}`),
          SessionMarker,
        ).pipe(
          Effect.map((author): AuthorSession => ({
            sessionId: Option.some(author.sessionId),
            adapter: Option.some(author.adapter),
            withPerson: author.withPerson === true,
          })),
        ),
    });

    const adjusted = !synced.clean || change.touched.length > 0;
    let said = `Merged \`${synced.base}\` at \`${synced.newBase.slice(0, 7)}\` into this branch.`;

    if (adjusted) {
      const prompt = yield* renderPromptOr("refresh", REFRESH, {
        pullRequest: layer.pullRequest,
        branch: layer.branch,
        base: synced.base,
        oldBase: synced.oldBase,
        newBase: synced.newBase,
        merge: describeMerge(synced),
        diff: change.diff,
      });

      const outcome = yield* fixWithAgent(
        `adjust-${key}`,
        worktree,
        prompt,
        session,
        Option.some(layer.pullRequest),
      );

      if (outcome.status === "needs-clarification") {
        return yield* new NeedsHuman({
          reason: `the author agent needs a person to bring #${layer.pullRequest} up to date with \`${synced.base}\`:\n\n${outcome.questions ?? outcome.summary}`,
        });
      }

      yield* mergeCommitted(`refresh-committed-${key}`, worktree);
      said = `${said} ${outcome.summary}`;
    }

    yield* localGate(worktree, { id: `refresh-${key}`, session, pullRequest: layer.pullRequest });
    // Checked against the base it is now on, so only the layer's own commits count.
    yield* push(`push-refresh-${key}`, worktree, layer.branch, {
      base: synced.base,
      withPerson: session.withPerson === true,
    });
    yield* waitForCi(
      layer.pullRequest,
      worktree,
      { ...session, branch: layer.branch, base: synced.base },
      { id: `refresh-${key}` },
    );

    const askedAgain = yield* reviewAfterRefresh(
      `refresh-review-${key}`,
      layer.pullRequest,
      synced.base,
      said,
    );

    return { upToDate: false, adjusted, askedAgain } satisfies Refreshed;
  });

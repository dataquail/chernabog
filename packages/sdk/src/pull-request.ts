// Steps on a pull request that any flow can use, whichever flow opened it:
// asking the team's reviewer pool for a review, merging on the automated path,
// and handing it to a person. A flow that works on a pull request itself can
// own it while it does, so the standalone flows leave it alone.

import {
  activity,
  Claims,
  Git,
  GitHub,
  latestMarker,
  type MergeMethod,
  MergeRefused,
  NeedsHuman,
  type OwnerMarker,
  ownerMarker,
  pathsMatching,
  type PullRequest,
  PullRequestClosed,
  reviewMarker,
  Run,
  RunLog,
  Runs,
  signalDeferred,
  Signals,
  Skip,
  sleep,
  type WorkItem,
  Worktree,
} from "@chernabog/core";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as DurableDeferred from "effect/workflow/DurableDeferred";

import * as Ci from "./ci.ts";
import { commentStep } from "./comment.ts";
import * as Settings from "./settings.ts";

// Marks the pull request as this run's: its claim ref, and a comment for people to read.
export const own = (pullRequest: number) =>
  activity(
    `own-pr-${pullRequest}`,
    Effect.gen(function* () {
      const run = yield* Run;
      const item = Claims.pullRequest(pullRequest);
      const claimed = yield* Claims.acquire(item);

      if (!claimed.acquired) {
        return yield* new Skip({
          reason: `#${pullRequest} is owned by another run (${Claims.describeHolder(item, claimed.holder)})`,
        });
      }

      const marker = ownerMarker.write({
        flow: run.flow,
        runId: run.runId,
        released: false,
        ref: true,
      });

      yield* (yield* GitHub).comment(
        pullRequest,
        [
          ...Option.toArray(Option.map(claimed.takenOver, Claims.describeTakeover)),
          `The \`${run.flow}\` run owns this pull request until it ends. ${marker}`,
        ].join(" "),
      );
    }),
  );

// Comments on the pull request, and does nothing else.
export const comment = (pullRequest: number, body: string) => commentStep("pr", pullRequest, body);

// Lets the pull request go, so the standalone flows pick it up again.
export const release = (pullRequest: number) =>
  activity(
    `release-pr-${pullRequest}`,
    Effect.gen(function* () {
      const run = yield* Run;
      yield* Claims.release(Claims.pullRequest(pullRequest));

      const marker = ownerMarker.write({
        flow: run.flow,
        runId: run.runId,
        released: true,
        ref: true,
      });

      yield* (yield* GitHub).comment(
        pullRequest,
        `The \`${run.flow}\` run is done with this pull request. ${marker}`,
      );
    }),
  );

// Owns the pull request for as long as `effect` runs, and releases it however
// that ends. A run waiting on a signal keeps it. A pull request another run
// owns is skipped.
export const owning =
  (pullRequest: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    own(pullRequest).pipe(
      Effect.andThen(
        effect.pipe(
          // A wait suspends the run by interrupting it; that is not an ending.
          Effect.onExit((exit) => {
            if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) {
              return Effect.void;
            }

            return release(pullRequest).pipe(Effect.ignore);
          }),
        ),
      ),
    );

// Whether this machine knows the run has ended; a run it never had, such as
// one on another machine, is taken to be going.
const knownEnded = (runId: string) =>
  Effect.gen(function* () {
    const runs = yield* Effect.serviceOption(Runs);

    const active = yield* Option.match(runs, {
      onNone: () => Effect.succeedNone,
      onSome: (known) => known.isActive(runId),
    });

    return Option.contains(active, false);
  });

// The run that owns the pull request, from its comments: none once it let go,
// or when this machine knows the run has ended.
export const ownerOf = (bodies: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const latest = Option.filter(
      latestMarker(ownerMarker.read, bodies),
      (marker) => !marker.released,
    );

    if (Option.isNone(latest)) {
      return Option.none<OwnerMarker>();
    }

    if (yield* knownEnded(latest.value.runId)) {
      return Option.none<OwnerMarker>();
    }

    return latest;
  });

export type Owner = { readonly flow: string; readonly runId: string };

// The run that owns the pull request: the holder of its claim ref, none when
// this machine knows that run has ended, or its lease expired, so another run
// may take it over. Migration: while runs that owned a
// pull request by comment alone may be in flight, one with no claim ref falls
// back to the latest owner marker that names no ref (ownerOf). Drop the
// fallback a release after owners became claim refs.
export const owner = (pullRequest: number) =>
  Effect.gen(function* () {
    const held = yield* Claims.holder(Claims.pullRequest(pullRequest));
    const now = yield* DateTime.now;

    if (Option.exists(held, (found) => Claims.expired(found, now))) {
      return Option.none<Owner>();
    }

    if (Option.isSome(held)) {
      if (yield* knownEnded(held.value.runId)) {
        return Option.none<Owner>();
      }

      return Option.some<Owner>({ flow: held.value.flow, runId: held.value.runId });
    }

    const bodies = (yield* (yield* GitHub).comments(pullRequest)).map((found) => found.body);
    const legacy = yield* ownerOf(bodies);

    return Option.map(
      Option.filter(legacy, (marker) => marker.ref !== true),
      (marker): Owner => ({ flow: marker.flow, runId: marker.runId }),
    );
  });

// id: tells apart two tries at merging one pull request in a run, as an epic
// run's rounds do (`merge-pr-12#land-3`); a refused try is saved like any step.
export type MergeOptions = { readonly method: MergeMethod; readonly id?: string };

const refuse = (pullRequest: number, reason: string) => new MergeRefused({ pullRequest, reason });

const short = (sha: string) => sha.slice(0, 7);

// Whether the head only brought the pull request up to date with its base
// since `reviewedSha`, and if not, which commit did more.
export type BaseMerges =
  { readonly only: true } | { readonly only: false; readonly reason: string };

const notOnly = (reason: string): BaseMerges => ({ only: false, reason });

// Whether every commit between `reviewedSha` and the pull request's head, along
// its first parents, is a merge of the base branch (baseRef) that git would
// have made by itself: two parents, the second on the base, and the tree a
// clean automatic merge of the two gives. A merge where someone resolved a
// conflict or added edits of their own is not, so the change still needs a
// review. Reads the history in a detached checkout of the head.
export const onlyMergedBase = (pull: PullRequest, reviewedSha: string) =>
  Effect.gen(function* () {
    const git = yield* Git;
    const base = pull.baseRef;

    const worktree = yield* (yield* Worktree).checkout(
      `merge-pr-${pull.number}`,
      `origin/${pull.headRef}`,
    );

    // The head by its sha, not origin/<headRef>, so the walk checks the very
    // commit merge asks GitHub to merge, even if the branch moved since.
    yield* git.run(
      [
        "fetch",
        "--quiet",
        "origin",
        `+refs/heads/${base}:refs/remotes/origin/${base}`,
        pull.headSha,
      ],
      worktree,
    );

    const reviewedKnown = yield* git
      .run(["rev-parse", "--verify", "--quiet", `${reviewedSha}^{commit}`], worktree)
      .pipe(
        Effect.as(true),
        Effect.catchTag("GitError", () => Effect.succeed(false)),
      );

    if (!reviewedKnown) {
      return notOnly(`the reviewed commit \`${short(reviewedSha)}\` is no longer in its history`);
    }

    // Newest first: each commit and its parents.
    const commits = (yield* git.run(
      ["rev-list", "--first-parent", "--parents", pull.headSha, `^${reviewedSha}`],
      worktree,
    ))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim().split(/\s+/));

    for (const [commit = "", ...parents] of commits) {
      const [first = "", second = ""] = parents;

      if (parents.length !== 2) {
        return notOnly(`\`${short(commit)}\` is not a merge of \`${base}\``);
      }

      const onBase = yield* git.run(
        [
          "for-each-ref",
          "--format=%(refname)",
          "--contains",
          second,
          `refs/remotes/origin/${base}`,
        ],
        worktree,
      );

      if (onBase.trim().length === 0) {
        return notOnly(`\`${short(commit)}\` is not a merge of \`${base}\``);
      }

      // merge-tree fails on a conflict, which only a person could have resolved.
      const clean = yield* git.run(["merge-tree", "--write-tree", first, second], worktree).pipe(
        Effect.map((said) => Option.fromUndefinedOr(said.trim().split("\n")[0])),
        Effect.catchTag("GitError", () => Effect.succeedNone),
      );

      const tree = (yield* git.run(["rev-parse", `${commit}^{tree}`], worktree)).trim();

      if (!Option.contains(clean, tree)) {
        return notOnly(`\`${short(commit)}\` is not a clean merge of \`${base}\``);
      }

      // The walk reached the reviewed commit through first parents alone.
      if (first === reviewedSha) {
        return { only: true } satisfies BaseMerges;
      }
    }

    return notOnly(
      `the reviewed commit \`${short(reviewedSha)}\` is not on the head's first-parent history`,
    );
  });

// The pull request whose head branch `pull` is based on, which makes `pull`
// a layer stacked on it: one still open, or one that merged while its branch
// stayed, which nothing retargets `pull` off, so a merge would land in that
// branch and never reach the base below it. None when `pull`'s base is the
// flow's integration base, or no open or merged pull request comes from it.
const layerBelow = (pull: PullRequest) =>
  Effect.gen(function* () {
    if (pull.baseRef === (yield* Settings.base)) {
      return Option.none<PullRequest>();
    }

    return Option.filter(
      yield* (yield* GitHub).pullRequestForBranch(pull.baseRef),
      (below) => below.state === "open" || below.state === "merged",
    );
  });

// Why a layer stacked on `below` waits.
const waitsOn = (pull: PullRequest, below: PullRequest) => {
  if (below.state === "merged") {
    return `stacked on ${pull.baseRef}, and the layer below (#${below.number}) merged; it waits to be retargeted onto ${below.baseRef}`;
  }

  return `stacked on ${pull.baseRef} (#${below.number}); it merges after the layer below`;
};

// The issue a pull request closes: the one its body names, or its claim branch's.
const closedIssue = (pull: PullRequest) =>
  Option.map(
    Option.fromNullishOr(
      pull.body.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #(\d+)/i) ??
        pull.headRef.match(/^auto\/issue-(\d+)$/),
    ),
    (match) => Number(match[1]),
  );

// Whether the pull request is the fix for a follow-up issue the post-merge
// recipe filed (Ci.isFollowUp): the fix every held merge is waiting on.
export const fixesFollowUp = (pull: PullRequest) =>
  Effect.gen(function* () {
    const closes = closedIssue(pull);

    if (Option.isNone(closes)) {
      return false;
    }

    return yield* (yield* GitHub).issue(closes.value).pipe(
      Effect.map((issue) => Ci.isFollowUp(issue.body)),
      Effect.catchTag("NotFound", () => Effect.succeed(false)),
    );
  });

// Why the pull request waits for its base branch's CI, such as "CI failing on
// main": only when the flow's settings hold merges on a broken base
// (Settings.MergeHold), the newest completed push run of a workflow on the
// base failed (GitHub.branchCiState), and the pull request isn't a follow-up's
// fix. A run still in progress changes nothing, and a base with no CI is never red.
export const baseRed = (pull: PullRequest) =>
  Effect.gen(function* () {
    if (!(yield* Settings.mergeHold).enabled) {
      return Option.none<string>();
    }

    const ci = yield* (yield* GitHub).branchCiState(pull.baseRef);

    if (ci.state !== "red" || (yield* fixesFollowUp(pull))) {
      return Option.none<string>();
    }

    return Option.some(`CI failing on ${pull.baseRef}`);
  });

// Merges the pull request, only when that is safe: it is open and not a
// layer of a stack, its checks are green on the current head by the flow's
// CI policy (Ci.verdict: by default, its required checks passed and no check
// failed), the latest review approved that very head or one the head has only merged
// its base into since (onlyMergedBase), it touches no humanOnlyPaths, its
// base branch's CI isn't red when the flow holds merges for that (baseRed),
// and GitHub's rules for the repo allow it. A pull request into any branch may
// merge, such as develop in git flow. One whose base is the head branch of
// another pull request is a layer stacked on it (layerBelow): it waits while
// the layer below is open, and after it merges, until it is retargeted onto
// the base below. A pull request based on the flow's integration base
// (Settings.base) is never a layer, whatever came from that branch.
// Otherwise it fails with MergeRefused, saying why, or PullRequestClosed for
// one closed without merging. Nothing merges unless a flow calls this.
export const merge = (pullRequest: number, options: MergeOptions) =>
  activity(
    Option.match(Option.fromUndefinedOr(options.id), {
      onNone: () => `merge-pr-${pullRequest}`,
      onSome: (id) => `merge-pr-${pullRequest}#${id}`,
    }),
    Effect.gen(function* () {
      const github = yield* GitHub;
      const rules = yield* Settings.rules;
      const pull = yield* github.pullRequest(pullRequest);

      // A rerun after a crash finds its own merge done.
      if (pull.state === "merged") {
        return `#${pullRequest} merged`;
      }

      if (pull.state === "closed") {
        return yield* new PullRequestClosed({ pullRequest, state: "closed" });
      }

      const below = yield* layerBelow(pull);

      if (Option.isSome(below)) {
        return yield* refuse(pullRequest, waitsOn(pull, below.value));
      }

      const red = yield* baseRed(pull);

      if (Option.isSome(red)) {
        return yield* refuse(pullRequest, `holding merge: ${red.value}`);
      }

      const ci = yield* Ci.pullRequestState(pullRequest);

      if (ci.state === "red") {
        return yield* refuse(pullRequest, `checks failed: ${ci.failedChecks.join(", ")}`);
      }

      if (ci.state === "pending") {
        return yield* refuse(pullRequest, "checks are still pending");
      }

      const reviewed = latestMarker(
        reviewMarker.read,
        (yield* github.comments(pullRequest)).map((posted) => posted.body),
      );

      if (Option.isNone(reviewed)) {
        return yield* refuse(pullRequest, "it has no review");
      }

      if (reviewed.value.sha !== pull.headSha) {
        const since = yield* onlyMergedBase(pull, reviewed.value.sha);

        if (!since.only) {
          return yield* refuse(
            pullRequest,
            `the head moved to \`${short(pull.headSha)}\` since review ${reviewed.value.round} saw \`${short(reviewed.value.sha)}\`, and ${since.reason}`,
          );
        }
      }

      if (reviewed.value.verdict !== "approve") {
        return yield* refuse(pullRequest, `review ${reviewed.value.round} requested changes`);
      }

      const touched = pathsMatching(
        yield* github.pullRequestFiles(pullRequest),
        rules.humanOnlyPaths,
      );

      if (touched.length > 0) {
        return yield* refuse(
          pullRequest,
          `it touches paths a person must handle: ${touched.map((path) => `\`${path}\``).join(", ")}`,
        );
      }

      const merged = yield* github.merge(pullRequest, {
        method: options.method,
        sha: pull.headSha,
      });

      return `#${pullRequest} merged (${options.method}) as \`${merged.sha.slice(0, 7)}\``;
    }),
    Schema.String,
  );

// Whether chernabog may merge the pull request: only on the automated path,
// one labelled ship (auto:ship). Anything else, a missing or misspelt label
// included, is left for a person to merge. The one place that decides it.
export const ships = (pull: PullRequest, labels: Settings.LabelNames) =>
  pull.labels.includes(labels.ship);

// The signal a run holding a merge parks on: its trigger reports it once CI
// on the pull request's base branch is no longer red (baseTurnedGreen).
export const BASE_GREEN = "base-green";

// On a pull request whose merge a run holds: which run, and the work item it
// runs for, so the trigger can wake it.
const HoldMarker = Schema.fromJsonString(
  Schema.Struct({ runId: Schema.String, key: Schema.String }),
);

const HOLD_MARKER = /<!-- chernabog-merge-hold (\{.*?\}) -->/;

const holdMarker = {
  write: (value: typeof HoldMarker.Type) =>
    `<!-- chernabog-merge-hold ${Schema.encodeSync(HoldMarker)(value)} -->`,
  read: (body: string) =>
    Option.fromNullishOr(body.match(HOLD_MARKER)).pipe(
      Option.flatMap((match) => Schema.decodeOption(HoldMarker)(match[1])),
    ),
};

// One look at the base branch's CI before a merge: the base, while it holds
// the merge, and when it looked, so a replay decides the same.
const BaseCheck = Schema.Struct({ held: Schema.Option(Schema.String), at: Schema.Finite });

const checkBase = (pullRequest: number, round: number) =>
  activity(
    `base-ci-pr-${pullRequest}-${round}`,
    Effect.gen(function* () {
      const pull = yield* (yield* GitHub).pullRequest(pullRequest);
      const at = DateTime.toEpochMillis(yield* DateTime.now);

      // One merged or closed meanwhile is merge's to report.
      if (pull.state !== "open") {
        return { held: Option.none<string>(), at };
      }

      return {
        held: Option.map(yield* baseRed(pull), () => pull.baseRef),
        at,
      };
    }),
    BaseCheck,
  );

const holdLimit = (pullRequest: number) =>
  activity(
    `merge-hold-limit-pr-${pullRequest}`,
    Effect.map(Settings.mergeHold, (hold) => hold.timeout),
    Schema.Option(Schema.Duration),
  );

// Parks the run on BASE_GREEN, its step showing why it holds the merge, until
// the trigger reports the signal or the time left runs out.
const parkOnBase = (
  pullRequest: number,
  round: number,
  base: string,
  left: Option.Option<Duration.Duration>,
) =>
  Effect.gen(function* () {
    const id = `merge-pr-${pullRequest}-${round}`;
    const deferred = signalDeferred(`${BASE_GREEN}:${id}`);
    const token = yield* DurableDeferred.token(deferred);
    const step = `holding merge: CI failing on ${base}`;

    yield* activity(
      `hold-${id}`,
      Effect.gen(function* () {
        // The step a parked run shows, as a person reads it, entered before
        // it parks, so a run seen waiting already shows why.
        yield* Effect.serviceOption(RunLog).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (log) => log.step(step).pipe(Effect.andThen(log.stepDone(step))),
            }),
          ),
        );

        yield* Signals.use((registry) => registry.register(BASE_GREEN, deferred.name, token));
      }),
    );

    const green = DurableDeferred.await(deferred).pipe(Effect.as(BASE_GREEN));

    return yield* Option.match(left, {
      onNone: () => green,
      onSome: (duration) =>
        DurableDeferred.raceAll({
          name: `race:${id}`,
          success: Schema.String,
          error: Schema.Never,
          effects: [green, sleep(`timeout:${id}`, duration).pipe(Effect.as("timeout"))],
        }),
    });
  });

// Before a merge: while CI on the pull request's base branch is red (baseRed),
// holds the merge rather than refusing it. The run says so on the pull
// request, with a marker naming the run, and parks on BASE_GREEN, which the
// flow's trigger reports with baseTurnedGreen; woken, it looks again, and
// returns once the base is no longer red, for merge's usual checks. The hold
// lasts as long as the base stays red, unless the mergeHoldTimeout setting
// caps it: then it fails with MergeRefused, for a person. With the flow's
// settings not holding merges, or for a follow-up's fix, it returns at once.
export const holdWhileBaseRed = (pullRequest: number) =>
  Effect.gen(function* () {
    let since = Option.none<number>();

    for (let round = 1; ; round++) {
      const check = yield* checkBase(pullRequest, round);

      if (Option.isNone(check.held)) {
        return;
      }

      const base = check.held.value;
      const first = Option.getOrElse(since, () => check.at);
      since = Option.some(first);
      const limit = yield* holdLimit(pullRequest);

      const left = Option.map(limit, (duration) =>
        Duration.millis(Duration.toMillis(duration) - (check.at - first)),
      );

      const stayedRed = new MergeRefused({
        pullRequest,
        reason: `CI on ${base} stayed red for ${Option.match(limit, { onNone: () => "too long", onSome: Duration.format })}`,
      });

      if (Option.exists(left, (duration) => Duration.toMillis(duration) <= 0)) {
        return yield* stayedRed;
      }

      const run = yield* Run;

      yield* comment(
        pullRequest,
        `Holding the merge: CI is failing on \`${base}\`. It merges once CI there is green again. ${holdMarker.write({ runId: run.runId, key: run.item.key })}`,
      );

      if ((yield* parkOnBase(pullRequest, round, base, left)) !== BASE_GREEN) {
        return yield* stayedRed;
      }
    }
  });

// For a trigger: the work items of runs holding a merge (holdWhileBaseRed)
// whose base branch is no longer red, as BASE_GREEN signals to those runs.
// Only open pull requests on the automated path (ships) can be held, and a
// run this machine knows has ended is left out. Never starts a run, and reads
// nothing while the flow's settings don't hold merges.
export const baseTurnedGreen = Effect.gen(function* () {
  if (!(yield* Settings.mergeHold).enabled) {
    return [];
  }

  const github = yield* GitHub;
  const labelNames = yield* Settings.labels;
  const held: Array<{ readonly pull: PullRequest; readonly key: string }> = [];

  for (const pull of yield* github.openPullRequests) {
    if (!ships(pull, labelNames)) {
      continue;
    }

    const bodies = (yield* github.trustedComments(pull.number)).map((found) => found.body);

    for (const marker of Option.toArray(latestMarker(holdMarker.read, bodies))) {
      if (!(yield* knownEnded(marker.runId))) {
        held.push({ pull, key: marker.key });
      }
    }
  }

  const red = new Map<string, boolean>();
  const items: Array<WorkItem> = [];

  for (const { key, pull } of held) {
    if (!red.has(pull.baseRef)) {
      red.set(pull.baseRef, (yield* github.branchCiState(pull.baseRef)).state === "red");
    }

    if (red.get(pull.baseRef) !== true) {
      items.push({
        key,
        title: pull.title,
        url: pull.url,
        data: { pullRequest: pull.number },
        signals: [BASE_GREEN],
        wakeOnly: true,
      });
    }
  }

  return items;
});

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

// Asks one reviewer from the team's pool (reviewers: in config) to review the
// pull request, never its author. The choice is made once, at random, in an
// activity, so a replay asks the same person. Without a pool, or with no one
// in it but the author, it labels the pull request needs-review for a person.
export const requestReview = (pullRequest: number) =>
  activity(
    `request-review-${pullRequest}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const reviewerPool = (yield* Settings.reviewers).pool;
      const labelNames = yield* Settings.labels;
      const pull = yield* github.pullRequest(pullRequest);
      const pool = reviewerPool.filter((login) => !sameLogin(login, pull.author));

      if (pool.length === 0) {
        yield* github.addLabel(pullRequest, labelNames.needsReview);

        return `#${pullRequest}: no reviewer in the pool but its author; labelled ${labelNames.needsReview} for a person`;
      }

      const reviewer = pool[yield* Random.nextIntBetween(0, pool.length, { halfOpen: true })];
      yield* github.requestReviewers(pullRequest, [reviewer]);

      return `#${pullRequest}: review requested of ${reviewer}`;
    }),
    Schema.String,
  );

// Labels the pull request needs-human and says why; no flow picks it up again
// until a person removes the label.
export const handToPerson = (pullRequest: number, reason: string) =>
  activity(
    `needs-human-pr-${pullRequest}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const labelNames = yield* Settings.labels;
      yield* github.addLabel(pullRequest, labelNames.needsHuman);
      yield* github.comment(pullRequest, `Chernabog stopped and needs a person: ${reason}`);
    }),
  ).pipe(Effect.andThen(Effect.fail(new NeedsHuman({ reason: `#${pullRequest}: ${reason}` }))));

// Whether chernabog may merge the pull request, as `ships` decides it,
// read once in an activity so a replay decides the same.
export const shipping = (pullRequest: number) =>
  activity(
    `ships-pr-${pullRequest}`,
    Effect.gen(function* () {
      const labelNames = yield* Settings.labels;

      return ships(yield* (yield* GitHub).pullRequest(pullRequest), labelNames);
    }),
    Schema.Boolean,
  );

// Why the pull request, a layer of a stack, waits for the layer below rather
// than merging (layerBelow), read once in an activity so a replay decides the
// same; none for one on the flow's integration base. An approved layer that
// waits is left approved, not handed to a person: the epic run that stacked
// it merges it once the layer below has merged and it is on the base.
export const waitingOnLayer = (pullRequest: number) =>
  activity(
    `layer-below-pr-${pullRequest}`,
    Effect.gen(function* () {
      const pull = yield* (yield* GitHub).pullRequest(pullRequest);

      return Option.map(yield* layerBelow(pull), (below) => waitsOn(pull, below));
    }),
    Schema.Option(Schema.String),
  );

// After an approval: on the automated path, merges the pull request when that
// is safe, and otherwise hands it to a person; a layer waiting for the one
// below is left approved, any other pull request is left for a person to
// merge, and one closed meanwhile is left alone. While its base branch is red
// it holds the merge (holdWhileBaseRed), so the flow's trigger should include
// baseTurnedGreen.
export const mergeOrLeave = (pullRequest: number) =>
  Effect.gen(function* () {
    if (!(yield* shipping(pullRequest))) {
      return `#${pullRequest} approved; a person merges`;
    }

    const waiting = yield* waitingOnLayer(pullRequest);

    if (Option.isSome(waiting)) {
      return `#${pullRequest} approved; ${waiting.value}`;
    }

    return yield* holdWhileBaseRed(pullRequest).pipe(
      Effect.andThen(merge(pullRequest, { method: "squash" })),
      Effect.catchTags({
        MergeRefused: (refused) => handToPerson(pullRequest, refused.message),
        PullRequestClosed: (closed) => Effect.succeed(`${closed.message}; nothing to merge`),
      }),
    );
  });

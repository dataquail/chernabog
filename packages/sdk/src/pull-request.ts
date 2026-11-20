// Steps on a pull request that any flow can use, whichever flow opened it:
// asking the team's reviewer pool for a review, merging on the automated path,
// and handing it to a person. A flow that works on a pull request itself can
// own it while it does, so the standalone flows leave it alone.

import {
  activity,
  Claims,
  Git,
  GitHub,
  type Json,
  latestMarker,
  type MergeMethod,
  MergeRefused,
  NeedsHuman,
  ownerMarker,
  pathsMatching,
  type PhaseRecord,
  Progress,
  type PullRequest,
  PullRequestClosed,
  reportAs,
  reviewMarker,
  Run,
  Runs,
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

import * as Ci from "./ci.ts";
import { commentStep } from "./comment.ts";
import * as Phases from "./phases.ts";
import * as Routing from "./routing.ts";
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

export type Owner = { readonly flow: string; readonly runId: string };

// The run that owns the pull request: the holder of its claim ref, none when
// this machine knows that run has ended, or its lease expired, so another run
// may take it over.
export const owner = (pullRequest: number) =>
  Effect.gen(function* () {
    const held = yield* Claims.holder(Claims.pullRequest(pullRequest));
    const now = yield* DateTime.now;

    if (Option.exists(held, (found) => Claims.expired(found, now))) {
      return Option.none<Owner>();
    }

    if (Option.isNone(held) || (yield* knownEnded(held.value.runId))) {
      return Option.none<Owner>();
    }

    return Option.some<Owner>({ flow: held.value.flow, runId: held.value.runId });
  });

// id: tells apart two tries at merging one pull request in a run, as an epic
// run's rounds do (`merge-pr-12#land-3`); a refused try is saved like any step.
export type MergeOptions = {
  readonly method: MergeMethod;
  readonly id?: string;
} & Hold;

// How a merge holds: what its record keeps beside the work item that holds
// it, such as where a flow document resumes (Resume.parking), and whether it
// polls the base rather than park, for a flow document's hold that can't be
// taken up from its record. A poll isn't a park, so its run isn't stranded.
export type Hold = {
  readonly data?: { readonly [key: string]: Json };
  readonly poll?: boolean;
};

// How often a hold that polls looks at the base again.
const MERGE_POLL = Duration.minutes(5);

// How merge's refusal for a red base begins (baseRed), which mergeHolding
// tells from its other refusals.
const HOLDING = "holding merge:";

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
        return yield* refuse(pullRequest, `${HOLDING} ${red.value}`);
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

// The work items whose runs said, in `bodies`, that they hold the merge, in
// the order they said so, for backfill.
export const holdKeysOf = (bodies: ReadonlyArray<string>) =>
  bodies.flatMap((body) => Option.toArray(holdMarker.read(body))).map((marker) => marker.key);

// One look at the base branch's CI before a merge: the base, while it holds
// the merge, and when it looked, so a replay decides the same.
const BaseCheck = Schema.Struct({ held: Schema.Option(Schema.String), at: Schema.Finite });

const checkBase = (pullRequest: number, round: string) =>
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

// What a pull request's merge-held record carries: the work item of the run
// that holds the merge, so the flow whose run it was takes it up again.
const HeldMerge = Schema.Struct({ key: Schema.String });

const heldKey = (record: PhaseRecord) =>
  Option.map(
    Option.flatMap(
      Option.filter(record.data, () => record.phase === Phases.PHASES.pullRequest.mergeHeld),
      Schema.decodeUnknownOption(HeldMerge),
    ),
    (held) => held.key,
  );

// When this run's work item began holding the pull request's merge, as epoch
// milliseconds: the record's `at`, when its record already holds it for this
// item, as it does for a run that takes the hold up after a CI job ended at
// the park (ADR 0021, decision 4); none for a hold that starts here.
const heldSince = (pullRequest: number) =>
  activity(
    `held-since-pr-${pullRequest}`,
    Effect.gen(function* () {
      const run = yield* Run;

      const record = yield* Progress.use((progress) =>
        progress.read(Phases.pullRequestItem(pullRequest)),
      );

      return Option.map(
        Option.filter(record, (found) => Option.contains(heldKey(found), run.item.key)),
        (found) => DateTime.toEpochMillis(found.at),
      );
    }),
    Schema.Option(Schema.Finite),
  );

// The wait of this run's work item on the pull request's base, as its
// merge-held record: the work item, with `data` beside it, kept as it is when
// the record holds it for this item already, so its `at` is when the hold
// began. `limit` is mergeHoldTimeout, counted from `since`.
const holding = (
  pullRequest: number,
  named: string,
  data: { readonly [key: string]: Json },
  limit: Option.Option<Duration.Duration>,
) =>
  Effect.map(Run, (run): Phases.Parking => ({
    step: `merge-held-pr-${pullRequest}-${named}`,
    item: Phases.pullRequestItem(pullRequest),
    phase: Phases.PHASES.pullRequest.mergeHeld,
    data: { ...data, key: run.item.key },
    keeps: (found) => Option.contains(heldKey(found), run.item.key),
    ...Option.match(limit, { onNone: () => ({}), onSome: (timeout) => ({ timeout }) }),
  }));

// Before a merge: while CI on the pull request's base branch is red (baseRed),
// holds the merge rather than refusing it. The run says so on the pull
// request, records the hold and parks (Phases.park), which ends the run; the
// flow's trigger offers the hold again from its record (heldMerges,
// documentMergeResumes), and the run that takes it up looks again, and
// returns once the base is no longer red, for merge's usual checks. The hold
// lasts as long as the base stays red, unless the mergeHoldTimeout setting
// caps it: then it fails with MergeRefused, for a person. With `hold.poll` it
// looks at the base again every MERGE_POLL instead of parking. With the
// flow's settings not holding merges, or for a follow-up's fix, it returns at
// once.
export const holdWhileBaseRed = (pullRequest: number, attempt = 1, hold: Hold = {}) =>
  Effect.gen(function* () {
    // A hold an earlier run of this work item began counts from then.
    let since = yield* heldSince(pullRequest);

    for (let round = 1; ; round++) {
      // A later attempt (mergeHolding's) names its steps apart from the first's.
      const named = Option.match(
        Option.liftPredicate(attempt, (count) => count > 1),
        {
          onNone: () => `${round}`,
          onSome: (count) => `${count}.${round}`,
        },
      );

      const check = yield* checkBase(pullRequest, named);

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

      const parking = yield* holding(pullRequest, named, hold.data ?? {}, limit);

      // A hold that polls says so once; one that parks each time it holds
      // again, after a wake.
      if (hold.poll !== true || round === 1) {
        yield* comment(
          pullRequest,
          `Holding the merge: CI is failing on \`${base}\`. It merges once CI there is green again.`,
        );
      }

      if (hold.poll === true) {
        if (round === 1) {
          yield* Phases.recordParking(parking);
        }

        yield* sleep(
          `merge-pr-${pullRequest}-${named}-wait`,
          Option.match(left, {
            onNone: () => MERGE_POLL,
            onSome: (time) => Duration.min(time, MERGE_POLL),
          }),
        );

        continue;
      }

      if (
        (yield* Phases.park(parking, [BASE_GREEN], `merge-pr-${pullRequest}-${named}`)) !==
        BASE_GREEN
      ) {
        return yield* stayedRed;
      }
    }
  });

// Holds while the pull request's base branch is red (holdWhileBaseRed), then
// merges it with merge's usual checks. A merge refused because the base
// turned red after the hold last looked holds again, rather than failing:
// only merge's other refusals, and a hold past mergeHoldTimeout, fail with
// MergeRefused. The first try keeps merge's own step name (`merge-pr-7`, or
// with `id`), and each later one adds `hold-<n>`.
export const mergeHolding = (pullRequest: number, options: MergeOptions) =>
  Effect.gen(function* () {
    for (let attempt = 1; ; attempt++) {
      yield* holdWhileBaseRed(pullRequest, attempt, options);

      const id = Option.match(
        Option.liftPredicate(attempt, (count) => count > 1),
        {
          onNone: () => Option.fromUndefinedOr(options.id),
          onSome: (count) =>
            Option.some(
              Option.match(Option.fromUndefinedOr(options.id), {
                onNone: () => `hold-${count}`,
                onSome: (given) => `${given}-hold-${count}`,
              }),
            ),
        },
      );

      const merged = yield* merge(pullRequest, {
        method: options.method,
        ...Option.match(id, { onNone: () => ({}), onSome: (named) => ({ id: named }) }),
      }).pipe(
        Effect.asSome,
        Effect.catchTag("MergeRefused", (refused) => {
          if (refused.reason.startsWith(HOLDING)) {
            return Effect.succeedNone;
          }

          return Effect.fail(refused);
        }),
      );

      if (Option.isSome(merged)) {
        return merged.value;
      }
    }
  });

// A run holding a pull request's merge, by its record: the pull request, the
// work item it runs for, and when the hold began.
type Held = {
  readonly pull: PullRequest;
  readonly key: string;
  readonly since: DateTime.Utc;
};

// Every run holding a merge on an open pull request on the automated path
// (ships), by its merge-held record (ADR 0021, decision 3).
const heldMergesOnPulls = Effect.gen(function* () {
  const github = yield* GitHub;
  const labelNames = yield* Settings.labels;
  const shipping = (yield* github.openPullRequests).filter((pull) => ships(pull, labelNames));
  const all = yield* Phases.records;

  return shipping.flatMap((pull) =>
    Option.toArray(
      Option.flatMap(Phases.recordOf(all, Phases.pullRequestItem(pull.number)), (record) =>
        Option.map(heldKey(record), (key): Held => ({ pull, key, since: record.at })),
      ),
    ),
  );
});

// Whether CI on each held pull request's base branch is red, read once per base.
const redBases = (held: ReadonlyArray<Held>) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const red = new Map<string, boolean>();

    for (const { pull } of held) {
      if (!red.has(pull.baseRef)) {
        red.set(pull.baseRef, (yield* github.branchCiState(pull.baseRef)).state === "red");
      }
    }

    return red;
  });

const heldItem = (held: Held): WorkItem => ({
  key: held.key,
  title: held.pull.title,
  url: held.pull.url,
  data: { pullRequest: held.pull.number },
});

// For a trigger: the work items of runs holding a merge (holdWhileBaseRed)
// whose base branch is no longer red, as BASE_GREEN signals to those runs,
// one per work item. Never starts a run: for a document's pr.land, which
// can't be taken up again mid-graph (audit W8); a recipe's trigger uses
// heldMerges. Reads nothing while the flow's settings don't hold merges.
export const baseTurnedGreen = Effect.gen(function* () {
  if (!(yield* Settings.mergeHold).enabled) {
    return [];
  }

  const held = yield* heldMergesOnPulls;
  const red = yield* redBases(held);

  return held
    .filter(({ pull }) => red.get(pull.baseRef) !== true)
    .map((found): WorkItem => ({ ...heldItem(found), signals: [BASE_GREEN], wakeOnly: true }));
});

// What a flow document's pr.land keeps in a hold's record beside its work
// item (recordHold): the pull request.
const DocumentHold = Schema.Struct({ pullRequest: Schema.Finite });

// Whether a flow document's run that parked holding a merge may be taken up
// (ADR 0021, decision 4), as heldMerges says for a recipe's: once CI on the
// base is no longer red, or the hold has lasted mergeHoldTimeout since the
// record's `at`, when the run that takes it up finds its time is up and hands
// it to a person; held while neither. Routed by assignees and reviewers. One
// closed, off the automated path or handed to a person has nothing left to
// resume.
export const documentMergeResumes = (
  data: { readonly [key: string]: Json },
  item: WorkItem,
  at: DateTime.Utc,
) =>
  Effect.gen(function* () {
    const parked = Schema.decodeUnknownOption(DocumentHold)(data);

    if (Option.isNone(parked)) {
      return Option.none<WorkItem>();
    }

    const github = yield* GitHub;
    const labelNames = yield* Settings.labels;
    const hold = yield* Settings.mergeHold;

    const pull = Option.filter(
      yield* github.pullRequest(parked.value.pullRequest).pipe(
        Effect.asSome,
        Effect.catchTag("NotFound", () => Effect.succeedNone),
      ),
      (found) =>
        found.state === "open" &&
        ships(found, labelNames) &&
        !found.labels.includes(labelNames.needsHuman),
    );

    if (Option.isNone(pull)) {
      return Option.none<WorkItem>();
    }

    const route = (work: WorkItem) =>
      Routing.route(work, {
        assignees: pull.value.assignees,
        reviewers: pull.value.requestedReviewers,
      });

    const red = (yield* github.branchCiState(pull.value.baseRef)).state === "red";
    const now = yield* DateTime.now;

    const due = Option.exists(
      Option.map(hold.timeout, (limit) => DateTime.addDuration(at, limit)),
      (deadline) => DateTime.isLessThanOrEqualTo(deadline, now),
    );

    if (hold.enabled && red && !due) {
      return Option.some<WorkItem>({
        ...item,
        held: `holds the merge of #${pull.value.number}: CI on ${pull.value.baseRef} is red`,
      });
    }

    return Option.some(yield* route(item));
  }).pipe(reportAs("trigger"));

const ResumingMerge = Schema.Struct({
  pullRequest: Schema.Finite,
  resumeMerge: Schema.Literal(true),
});

// The pull request whose held merge a work item from heldMerges takes up;
// none for any other item. A recipe asks before it reads its own item data.
export const resumingMerge = (item: WorkItem) =>
  Option.map(Schema.decodeUnknownOption(ResumingMerge)(item.data), (data) => data.pullRequest);

// For a recipe's trigger: the held merges its own runs held, by their work
// items' keys (`owns`, given the key and the pull request), as work a run may
// start (ADR 0021, decision 4): a CI job that held the merge ended at the
// park, and a new run takes the merge up. One whose base is no longer red
// also signals BASE_GREEN, which wakes a daemon's run still parked on it; that
// run holds the work item, so no second one starts. One held past the
// mergeHoldTimeout setting, by its record's `at`, is offered too, and the run
// that takes it up finds its time is up and hands it to a person.
export const heldMerges = (owns: (key: string, pullRequest: number) => boolean) =>
  Effect.gen(function* () {
    const hold = yield* Settings.mergeHold;

    if (!hold.enabled) {
      return [];
    }

    const now = yield* DateTime.now;

    const held = (yield* heldMergesOnPulls).filter((found) => owns(found.key, found.pull.number));
    const red = yield* redBases(held);
    const items: Array<WorkItem> = [];

    for (const found of held) {
      const item = {
        ...heldItem(found),
        data: { pullRequest: found.pull.number, resumeMerge: true },
      };

      const route = (work: WorkItem) =>
        Routing.route(work, {
          assignees: found.pull.assignees,
          reviewers: found.pull.requestedReviewers,
        });

      if (red.get(found.pull.baseRef) !== true) {
        items.push(yield* route({ ...item, signals: [BASE_GREEN] }));
        continue;
      }

      const due = Option.exists(hold.timeout, (limit) =>
        DateTime.isLessThanOrEqualTo(DateTime.addDuration(found.since, limit), now),
      );

      if (due) {
        items.push(yield* route(item));
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

// Gives the pull request to a person as the next ordinary step, such as
// merging it: labels it by the flow's ready-for-person label and comments
// `message`. Unlike handToPerson, the run goes on, and can end done.
export const readyForPerson = (pullRequest: number, message: string) =>
  activity(
    `ready-for-person-pr-${pullRequest}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const label = yield* Settings.readyForPerson;
      yield* github.addLabel(pullRequest, label);
      yield* github.comment(pullRequest, message);
      // With who reviewed it, so a review asked of one of them later is a
      // review again (Phases.reviewedBefore).
      yield* Phases.recordAwaitingReview(pullRequest, Phases.PHASES.pullRequest.readyForPerson);

      return `#${pullRequest}: labelled ${label}; ${message}`;
    }),
    Schema.String,
  );

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
// it holds the merge (mergeHolding), so the flow's trigger should include
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

    return yield* mergeHolding(pullRequest, { method: "squash" }).pipe(
      Effect.catchTags({
        MergeRefused: (refused) => handToPerson(pullRequest, refused.message),
        PullRequestClosed: (closed) => Effect.succeed(`${closed.message}; nothing to merge`),
      }),
    );
  });

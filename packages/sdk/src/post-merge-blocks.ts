// The post-merge blocks: watching push CI on the merge commit of a pull
// request this persona wrote, once it merged into the base branch, and, when
// the merge turned it red, filing a follow-up issue with the failed runs and
// the tail of their logs, so implement takes the fix on. A red merge of a
// follow-up's own fix goes to a person rather than to another follow-up.
//
// Each merge is watched once: the run's first step records the pull
// request's watched phase, which the source reads (ADR 0021, decision 3), and
// comments that it is watching. A merge watched before the record was written
// is known by the hidden marker in that comment. The follow-up
// carries a marker with the merge commit's sha, so a run that resumes after
// filing finds it rather than filing another.
//
// Push CI can take minutes or hours, and a run ends at every park (ADR 0021,
// decision 4), so a watch whose first reading is still pending parks: it
// records awaiting-merge-ci on the pull request, with the merge commit and
// when the watch began, and the run ends. The source offers it again once CI
// settles or the watch's time is up, and the run that takes it up reads CI
// once, records watched again when the watch ends, and goes on.

import {
  activity,
  awaitSignal,
  type CiFailedRun,
  GitHub,
  type Json,
  NeedsHuman,
  type PhaseData,
  type PhaseRecord,
  Repo,
  reportAs,
  sleep,
  StepFailed,
  type WorkItem,
} from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Brand from "effect/Brand";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  BaseBranch,
  defineBlock,
  defineSource,
  type FailureContext,
  IssueNumber,
  PullRequestNumber,
  ToPerson,
} from "./block.ts";
import * as Events from "./events.ts";
import { current, PHASES, pullRequestItem, record, recordOf, records } from "./phases.ts";
import * as PullRequest from "./pull-request.ts";
import * as Resume from "./resume.ts";
import * as Settings from "./settings.ts";

// A commit, by its sha: the merge commit a run watches.
export type CommitSha = string & Brand.Brand<"CommitSha">;

export const CommitSha = Brand.nominal<CommitSha>();

// Only merges this recent are watched, so enrolling a repo doesn't watch its history.
const WATCH_WITHIN = Duration.days(1);
const CI_POLL = Duration.minutes(1);

// How long a merge commit may go with no CI run before the repo is taken to
// run none for it, unless the flow's noCiGrace setting says otherwise.
const NO_CI_GRACE = Duration.minutes(10);

// "10 minutes": a duration as config may write one.
const isDurationText = (text: string): text is `${number} ${Duration.Unit}` =>
  /^\d+(?:\.\d+)? (?:nano|micro|milli|second|minute|hour|day|week)s?$/.test(text);

const durationOf = (text: string) =>
  Option.flatMap(Option.liftPredicate(text, isDurationText), Duration.fromInput);

// What config.yaml may set for a flow that watches merges, under flows.<name>.settings.
const Own = Schema.Struct({
  noCiGrace: Schema.optionalKey(
    Schema.String.pipe(
      Schema.check(
        Schema.makeFilter(
          (text: string) =>
            Option.isSome(durationOf(text)) || `"${text}" is not a duration, such as "10 minutes"`,
        ),
      ),
    ).annotate({
      description: `How long a merge commit may go with no CI run before the run takes the repo to run none for it, such as "10 minutes". Default: ${Duration.format(NO_CI_GRACE)}.`,
    }),
  ),
});

// A hidden marker in a comment or an issue body, as chernabog's own are written.
const marker = <A>(name: string, schema: Schema.Codec<A, Json>) => {
  const pattern = new RegExp(`<!-- chernabog-${name} (\\{.*?\\}) -->`);
  const codec = Schema.fromJsonString(schema);

  return {
    write: (value: A) => `<!-- chernabog-${name} ${Schema.encodeSync(codec)(value)} -->`,
    read: (body: string): Option.Option<A> =>
      Option.fromNullishOr(body.match(pattern)).pipe(
        Option.flatMap((match) => Schema.decodeOption(codec)(match[1])),
      ),
  };
};

// On the merged pull request: a run watched its merge commit. Written still,
// for a person and for an older chernabog's trigger; read only for a merge
// with no watched record, one watched before runs recorded it.
const watchedMarker = marker("post-merge-watched", Schema.Struct({ sha: Schema.String }));

// The step that records a merge watched. The recipe's step has the same name.
const MARK_WATCHED = "mark-watched";

// Records that a run is watching the merge commit `sha` of pull request `pr`:
// the pull request's watched phase, carrying the sha, from whatever phase its
// review left. This is what pr.mergedRecently reads, so each merge is watched
// once, whatever happens to the comment.
const markWatched = (pr: number, sha: string) =>
  activity(MARK_WATCHED, record(pullRequestItem(pr), PHASES.pullRequest.watched, { sha }));

const WATCHED = PHASES.pullRequest.watched;
const AWAITING = PHASES.pullRequest.awaitingMergeCi;

// What a parked watch's record carries beside where a document resumes: the
// merge commit, and when the watch began, which noCiGrace and ciTimeout count
// from across the runs that take it up. The record's `at` won't do for that:
// a record written afresh has a new one.
const ParkedWatch = Schema.Struct({ sha: Schema.String, since: Schema.String });

// When the watch of `sha` that `found` parked began; none for any other record.
const parkedSince = (found: PhaseRecord, sha: string) =>
  Option.flatMap(
    Option.filter(
      Option.flatMap(found.data, Schema.decodeUnknownOption(ParkedWatch)),
      (watch) => found.phase === AWAITING && watch.sha === sha,
    ),
    (watch) => DateTime.make(watch.since),
  );

// How far a run has watched a merge, by the pull request's record: finished,
// by watched, or parked, by awaiting-merge-ci, at a document's node (its data
// says where to resume) or a recipe's.
type Watch = "finished" | "parked" | "parked-to-resume";

const recordedWatch = (all: ReadonlyMap<string, PhaseRecord>, pr: number) =>
  Option.flatMap(recordOf(all, pullRequestItem(pr)), (found): Option.Option<Watch> => {
    if (found.phase === WATCHED) {
      return Option.some("finished");
    }

    if (found.phase !== AWAITING) {
      return Option.none();
    }

    if (Option.exists(found.data, (data) => "resume" in data)) {
      return Option.some("parked-to-resume");
    }

    return Option.some("parked");
  });

// Whether a run watched the merge of pull request `pr` before runs recorded
// it, by the watched marker on it: for a merge whose record is neither
// watched nor parked watching it.
const markedWatched = (pr: number) =>
  Effect.map(
    GitHub.use((github) => github.trustedComments(pr)),
    (comments) => comments.some((comment) => Option.isSome(watchedMarker.read(comment.body))),
  );

// On a follow-up issue: the merge commit whose red CI it is for.
const followUpMarker = marker(
  "post-merge",
  Schema.Struct({ sha: Schema.String, pullRequest: Schema.Finite }),
);

// What a work item says of a merged pull request.
const MergedItem = Schema.Struct({
  pullRequest: Schema.Finite,
  url: Schema.String,
  title: Schema.String,
  mergeSha: Schema.String,
  baseRef: Schema.String,
  // The issue the pull request closes, when it names one.
  issue: Schema.optionalKey(Schema.Finite),
});

const ClosedPulls = Schema.Array(
  Schema.Struct({
    number: Schema.Finite,
    title: Schema.String,
    html_url: Schema.String,
    body: Schema.OptionFromNullOr(Schema.String),
    user: Schema.Struct({ login: Schema.String }),
    merged_at: Schema.OptionFromNullOr(Schema.String),
    merge_commit_sha: Schema.OptionFromNullOr(Schema.String),
    base: Schema.Struct({ ref: Schema.String }),
    head: Schema.Struct({ ref: Schema.String }),
  }),
);

const decodeIn =
  <A>(schema: Schema.Codec<A, Json>, step: string) =>
  (json: Json) =>
    Schema.decodeEffect(schema)(json).pipe(
      Effect.mapError((issue) => new StepFailed({ step, message: issue.message })),
    );

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

// The issue a pull request closes: the one its body names, or its claim branch's.
const closedIssue = (body: string, headRef: string) => {
  const named =
    body.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #(\d+)/i) ??
    headRef.match(/^auto\/issue-(\d+)$/);

  return Option.map(Option.fromNullishOr(named), (match) => Number(match[1]));
};

const isRecent = (mergedAt: string, now: DateTime.Utc) =>
  Option.match(DateTime.make(mergedAt), {
    onNone: () => false,
    onSome: (at) =>
      Duration.isLessThanOrEqualTo(
        Duration.millis(DateTime.toEpochMillis(now) - DateTime.toEpochMillis(at)),
        WATCH_WITHIN,
      ),
  });

const FailedRun = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  job: Schema.Option(Schema.Finite),
  workflowRun: Schema.Option(Schema.Finite),
});

// The merge commit's CI as one poll read it: pending with nothing to wait on
// is no CI yet.
const MergeCi = Schema.Union([
  Schema.Struct({ state: Schema.Literal("pending"), waitingOn: Schema.Array(Schema.String) }),
  Schema.Struct({ state: Schema.Literal("green") }),
  Schema.Struct({
    state: Schema.Literal("red"),
    failedChecks: Schema.Array(Schema.String),
    failedRuns: Schema.Array(FailedRun),
  }),
]);

type MergeCi = typeof MergeCi.Type;

// Red CI on a merge commit: the checks that failed, and the runs to read why.
export type RedCi = Extract<MergeCi, { readonly state: "red" }>;

const readMergeCi = (sha: string, poll: number) =>
  activity(
    `ci-${poll}`,
    Effect.gen(function* () {
      const report = yield* (yield* GitHub).commitCiState(sha, { event: "push" });

      switch (report.state) {
        case "pending":
          return { state: "pending" as const, waitingOn: report.waitingOn };
        case "green":
          return { state: "green" as const };
        case "red":
          return {
            state: "red" as const,
            failedChecks: report.failedChecks,
            failedRuns: [...report.failedRuns],
          };
      }
    }),
    MergeCi,
  );

const WatchLimits = Schema.Struct({ grace: Schema.Duration, timeout: Schema.Duration });

type WatchLimits = typeof WatchLimits.Type;

// The no-CI grace and the CI timeout, from the flow's settings.
const limitsNow = Effect.gen(function* () {
  const own = yield* Settings.read(Own);
  const ci = yield* Settings.ci;

  return {
    grace: Option.getOrElse(
      Option.flatMap(Option.fromUndefinedOr(own.noCiGrace), durationOf),
      () => NO_CI_GRACE,
    ),
    timeout: ci.timeout,
  };
});

// The no-CI grace and the CI timeout, read once, so a replay decides the same.
const watchLimits = activity("watch-limits", limitsNow, WatchLimits);

// When the watch began, as ISO text, and how long it had gone when this run
// first read CI: no time for a watch this run began, and since the record's
// `since` for one it takes up from a park. Read once, so a replay decides the
// same.
const WatchClock = Schema.Struct({ since: Schema.String, waited: Schema.Duration });

const watchClock = (pr: number, sha: string) =>
  activity(
    "watch-since",
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const found = yield* current(pullRequestItem(pr));

      return Option.match(
        Option.flatMap(found, (parked) => parkedSince(parked, sha)),
        {
          onNone: () => ({ since: DateTime.formatIso(now), waited: Duration.zero }),
          onSome: (began) => ({
            since: DateTime.formatIso(began),
            waited: Duration.millis(
              Math.max(0, DateTime.toEpochMillis(now) - DateTime.toEpochMillis(began)),
            ),
          }),
        },
      );
    }),
    WatchClock,
  );

// The watch is over: a pull request whose watch parked is recorded watched
// again, which the source takes for finished, by this run, not the one that
// parked. One whose watch never parked holds watched already.
const endWatch = (pr: number, sha: string) =>
  activity(
    "watch-ended",
    Effect.gen(function* () {
      const found = yield* current(pullRequestItem(pr));

      if (Option.isSome(Option.flatMap(found, (parked) => parkedSince(parked, sha)))) {
        yield* record(pullRequestItem(pr), WATCHED, { sha });
      }
    }),
  );

// The signal a parked watch waits on. Nothing sends it: the run ends at the
// park, and the one that takes the watch up is a new run.
export const MERGE_CI_SETTLED = "merge-ci-settled";

// Where a watch parks, and what its record carries: on the merged pull
// request, the merge commit and when the watch began, and, for a document,
// where it resumes.
type WatchParking = { readonly item: string; readonly data: { readonly [key: string]: Json } };

// Records that the watch waits on push CI and parks, which ends the run. A
// run that takes up a parked watch and parks again keeps the record it found,
// `since` and all: Phases.record writes nothing over the same phase.
const parkWatch = (parking: WatchParking, timeout: Duration.Duration) =>
  activity("awaiting-merge-ci", record(parking.item, AWAITING, parking.data)).pipe(
    Effect.andThen(awaitSignal([MERGE_CI_SETTLED], { id: "merge-ci", timeout })),
  );

// Why a parked watch of `sha` can't be taken up yet, for a source to hold it
// with: push CI still pending, with a run to wait on inside ciTimeout, or
// none yet inside noCiGrace, both counted from `since`. None once a run that
// takes it up goes on: CI green or red, no CI within the grace, or time up.
const watchHeld = (sha: string, since: DateTime.Utc, limits: WatchLimits) =>
  Effect.gen(function* () {
    const report = yield* (yield* GitHub).commitCiState(sha, { event: "push" });
    const now = yield* DateTime.now;

    if (report.state !== "pending") {
      return Option.none<string>();
    }

    const waited = Duration.millis(DateTime.toEpochMillis(now) - DateTime.toEpochMillis(since));
    const timedOut = Duration.isGreaterThanOrEqualTo(waited, limits.timeout);

    const noCi =
      report.waitingOn.length === 0 && Duration.isGreaterThanOrEqualTo(waited, limits.grace);

    if (timedOut || noCi) {
      return Option.none<string>();
    }

    return Option.some(
      Arr.match(report.waitingOn, {
        onEmpty: () => `waits for push CI to start on ${sha.slice(0, 7)}`,
        onNonEmpty: (names) => `waits on push CI on ${sha.slice(0, 7)}: ${names.join(", ")}`,
      }),
    );
  });

// What a watch of the merge commit came to, as merged.awaitCi gives it.
type Watched = {
  readonly state: "none" | "green" | "red";
  readonly summary: string;
  readonly red: Option.Option<RedCi>;
};

// The merge commit, as summaries and the follow-up name it.
type Merge = {
  readonly pr: PullRequestNumber;
  readonly sha: CommitSha;
  readonly base: BaseBranch;
};

const shortOf = (sha: CommitSha) => sha.slice(0, 7);

// Watches the merge commit's push CI until it stops pending. No run within
// the noCiGrace setting is no CI for this push; still pending after the
// ciTimeout setting is a person's to look at; both count from when the watch
// began, across the runs that take it up. A first reading still pending
// parks, given somewhere to (`parking`, from when the watch began); with
// nowhere, as at a document's node it can't resume at, it reads CI once a
// minute, durably.
const awaitMergeCi = <E, R>(
  merge: Merge,
  limits: WatchLimits,
  parking: (since: string) => Effect.Effect<Option.Option<WatchParking>, E, R>,
) =>
  Effect.gen(function* () {
    const grace = Duration.toMillis(limits.grace);
    const timeout = Duration.toMillis(limits.timeout);
    const every = Duration.toMillis(CI_POLL);
    const clock = yield* watchClock(merge.pr, merge.sha);
    const where = yield* parking(clock.since);
    const ended = endWatch(merge.pr, merge.sha);

    for (let poll = 1; ; poll++) {
      if (poll > 1) {
        yield* sleep(`ci-${poll}-wait`, CI_POLL);
      }

      const reading = yield* readMergeCi(merge.sha, poll);

      if (reading.state !== "pending") {
        yield* ended;

        return reading;
      }

      const waited = Duration.toMillis(clock.waited) + (poll - 1) * every;

      if (reading.waitingOn.length === 0 && waited >= grace) {
        yield* ended;

        return { state: "none" as const };
      }

      if (waited >= timeout) {
        yield* ended;

        return yield* new NeedsHuman({
          reason: `CI on ${merge.base} at ${merge.sha} stayed pending for ${Duration.format(limits.timeout)} after #${merge.pr} merged`,
        });
      }

      if (poll === 1 && Option.isSome(where)) {
        yield* parkWatch(where.value, limits.timeout);
      }
    }
  });

// What the watch came to, with what a document's end says of it.
const watched = (
  merge: Merge,
  limits: WatchLimits,
  ci: RedCi | { readonly state: "green" } | { readonly state: "none" },
): Watched => {
  const pr = `#${merge.pr}`;
  const short = shortOf(merge.sha);

  switch (ci.state) {
    case "none":
      return {
        state: ci.state,
        summary: `${pr}: no CI ran on ${short} within ${Duration.format(limits.grace)}; taken as none for this push`,
        red: Option.none(),
      };
    case "green":
      return { state: ci.state, summary: `${pr}: CI on ${short} is green`, red: Option.none() };
    case "red":
      return { state: ci.state, summary: "", red: Option.some(ci) };
  }
};

const Parents = Schema.Struct({ parents: Schema.Array(Schema.Struct({ sha: Schema.String })) });

// Whether push CI was already red on the merge commit's first parent, the
// base branch as it was before the merge.
const redBeforeMerge = (sha: CommitSha) =>
  activity(
    "ci-before-merge",
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;

      const commit = yield* github
        .request("GET", `/repos/${repo.slug}/commits/${sha}`, Option.none())
        .pipe(Effect.flatMap(decodeIn(Parents, "ci-before-merge")));

      const parent = Arr.head(commit.parents);

      if (Option.isNone(parent)) {
        return false;
      }

      return (yield* github.commitCiState(parent.value.sha, { event: "push" })).state === "red";
    }),
    Schema.Boolean,
  );

// The follow-up this flow filed that the merged pull request fixed, if it fixed one.
const fixesAFollowUp = (closes: Option.Option<IssueNumber>) =>
  activity(
    "closes-follow-up",
    Effect.gen(function* () {
      if (Option.isNone(closes)) {
        return Option.none<number>();
      }

      const issue = yield* (yield* GitHub).issue(closes.value).pipe(
        Effect.asSome,
        Effect.catchTag("NotFound", () => Effect.succeedNone),
      );

      return Option.map(
        Option.filter(issue, (found) => Option.isSome(followUpMarker.read(found.body))),
        (found) => found.number,
      );
    }),
    Schema.Option(Schema.Finite),
  ).pipe(Effect.map(Option.map(IssueNumber)));

const FailureDetail = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  logTail: Schema.Option(Schema.String),
});

// A failed run's link and the tail of its failed jobs' logs.
export type FailureDetail = typeof FailureDetail.Type;

// Each failed run's link and the tail of its failed jobs' logs.
const failureDetails = (runs: ReadonlyArray<CiFailedRun>) =>
  activity(
    "failure-details",
    Effect.gen(function* () {
      const github = yield* GitHub;
      const details: Array<FailureDetail> = [];

      for (const run of runs) {
        const found = yield* github.ciFailureDetails(run);
        details.push({ name: run.name, url: found.url, logTail: found.logTail });
      }

      return details;
    }),
    Schema.Array(FailureDetail),
  );

// A fence longer than any run of backticks in the text it holds.
const fenced = (text: string) => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));

  return `${fence}text\n${text.trimEnd()}\n${fence}`;
};

// The merged pull request, as the follow-up names it.
type Merged = Merge & { readonly url: string; readonly title: string };

const followUpBody = (
  merged: Merged,
  slug: string,
  ci: RedCi,
  details: ReadonlyArray<FailureDetail>,
  fixed: Option.Option<IssueNumber>,
) => {
  const commit = `[\`${shortOf(merged.sha)}\`](https://github.com/${slug}/commit/${merged.sha})`;

  const runs = details.map((detail) =>
    [
      `### [${detail.name}](${detail.url})`,
      Option.match(detail.logTail, {
        onNone: () => "No log to show; open the run for its output.",
        onSome: fenced,
      }),
    ].join("\n\n"),
  );

  const unlinked = ci.failedChecks.filter(
    (check) => !details.some((detail) => detail.name === check),
  );

  return [
    `CI on \`${merged.base}\` went red on ${commit}, the merge commit of #${merged.pr} ([${merged.title}](${merged.url})). CI on the commit before it was not red, so the merge is the likely cause.`,
    ...Option.match(fixed, {
      onNone: () => [],
      onSome: (issue) => [
        `#${merged.pr} was the fix for #${issue}, itself a follow-up of a red merge, so this one is for a person rather than another follow-up.`,
      ],
    }),
    "## Failed runs",
    ...runs,
    ...Arr.match(unlinked, {
      onEmpty: () => [],
      onNonEmpty: (names) => [`Also failed: ${names.join(", ")}.`],
    }),
    "## Acceptance criteria",
    [
      `- [ ] CI on \`${merged.base}\` passes again: the failed checks above pass on the fix.`,
      `- [ ] The fix keeps what #${merged.pr} meant to change, or its pull request says why not.`,
    ].join("\n"),
    followUpMarker.write({ sha: merged.sha, pullRequest: merged.pr }),
  ].join("\n\n");
};

const Made = Schema.Array(
  Schema.Struct({ number: Schema.Finite, body: Schema.OptionFromNullOr(Schema.String) }),
);

// The follow-up already filed for this merge commit, among the issues this login opened lately.
const filedFor = (sha: CommitSha) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const repo = yield* Repo;
    const login = yield* github.login;

    const recent = yield* github.request(
      "GET",
      `/repos/${repo.slug}/issues?state=all&creator=${encodeURIComponent(login)}&sort=created&direction=desc&per_page=100`,
      Option.none(),
    );

    const made = Option.getOrElse(Schema.decodeUnknownOption(Made)(recent), () => []);

    return Option.fromUndefinedOr(
      made.find((issue) =>
        Option.exists(
          Option.flatMap(issue.body, followUpMarker.read),
          (found) => found.sha === sha,
        ),
      )?.number,
    );
  });

// Files the follow-up, or finds the one a run filed before it crashed.
const fileFollowUp = (merged: Merged, body: string, fixed: Option.Option<IssueNumber>) =>
  activity(
    "file-follow-up",
    Effect.gen(function* () {
      const existing = yield* filedFor(merged.sha);

      if (Option.isSome(existing)) {
        return existing.value;
      }

      const labelNames = yield* Settings.labels;

      const issue = yield* (yield* GitHub).createIssue({
        title: `CI is red on ${merged.base} after #${merged.pr} merged`,
        body,
        labels: [
          Option.match(fixed, {
            onNone: () => labelNames.eligible,
            onSome: () => labelNames.needsHuman,
          }),
        ],
      });

      return issue.number;
    }),
    Schema.Finite,
  ).pipe(Effect.map(IssueNumber));

// Step names, which more than one block may use: an implement flow's CI is
// ci-<round>-<poll>, and this watch's ci-<poll>.
const CI_STEPS = "ci";

export const postMergeBlocks = {
  "merged.markWatched": defineBlock({
    name: "merged.markWatched",
    about:
      "Records the merged pull request's watched phase, with its merge commit (mark-watched), and comments on it that a run is watching CI on that commit. pr.mergedRecently leaves a pull request recorded watched alone, so each merge is watched once; one watched before runs recorded it is known by the comment's hidden marker (chernabog-post-merge-watched).",
    inputKinds: {
      pr: "PullRequestNumber: the merged pull request, trigger.pr",
      sha: "CommitSha: its merge commit, trigger.sha",
      base: "BaseBranch: the branch it merged into, trigger.base",
    },
    outputKinds: "nothing",
    outcomeKinds: {},
    inputs: { pr: "required", sha: "required", base: "required" },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly sha: CommitSha;
      readonly base: BaseBranch;
    }) =>
      Effect.gen(function* () {
        yield* markWatched(input.pr, input.sha);

        yield* PullRequest.comment(
          input.pr,
          `Watching CI on \`${input.base}\` at ${input.sha}, this pull request's merge commit. ${watchedMarker.write({ sha: input.sha })}`,
        );
      }),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {},
    mustRoute: [],
    records: [{ item: "pull-request", phase: PHASES.pullRequest.watched }],
    contributes: {},
  }),

  "merged.awaitCi": defineBlock({
    name: "merged.awaitCi",
    about:
      "Waits for push CI on the merge commit, with the noCiGrace and ciTimeout settings read once first (watch-limits) and when the watch began (watch-since). A first reading still pending (ci-1) records awaiting-merge-ci on the pull request, with the merge commit and when the watch began, and the run ends at the park (awaiting-merge-ci); pr.mergedRecently's document offers it again once CI settles or its time is up, and the run that takes it up starts here, reads CI once, and records watched again (watch-ended). At a node the document can't resume at, it reads CI once a minute, durably (ci-2-wait and ci-2, and on). Comes to green, to red, or to none when no CI run started within noCiGrace (10 minutes by default). Still pending after ciTimeout, the run ends needing a person. Both count from when the watch began. Only push runs count, so a pull request's runs on the same commit don't.",
    inputKinds: {
      pr: "PullRequestNumber: the merged pull request, trigger.pr",
      sha: "CommitSha: its merge commit, trigger.sha",
      base: "BaseBranch: the branch it merged into, trigger.base",
    },
    outputKinds: {
      state: "none, green or red",
      summary: "for `end`'s summary, on none and green",
      red: "the red CI, on red",
    },
    outcomeKinds: {
      none: "an object: summary, for end's summary",
      green: "an object: summary, for end's summary",
      red: "the red CI: failedChecks and failedRuns, for merged.failureDetails and merged.fileFollowUp",
    },
    waits: true,
    stepNames: ["watch-limits", "watch-since", "watch-ended", "awaiting-merge-ci", CI_STEPS],
    inputs: { pr: "required", sha: "required", base: "required" },
    run: (input: Merge) =>
      Effect.gen(function* () {
        const limits = yield* watchLimits;

        const ci = yield* awaitMergeCi(input, limits, (since) =>
          Resume.parking({ sha: input.sha, since }),
        );

        return watched(input, limits, ci);
      }),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {
      none: (ci: Watched) =>
        Option.liftPredicate({ summary: ci.summary }, () => ci.state === "none"),
      green: (ci: Watched) =>
        Option.liftPredicate({ summary: ci.summary }, () => ci.state === "green"),
      red: (ci: Watched) => ci.red,
    },
    mustRoute: ["none", "green", "red"],
    exhaustive: true,
    // Its watched record again is written only over its own park; what puts
    // a merge's watch on record is merged.markWatched.
    records: [{ item: "pull-request", phase: AWAITING }],
    // A parked watch may start again once push CI on its merge commit
    // settled, or none started within noCiGrace, or ciTimeout passed, all
    // counted from when the watch began; held, with why, until then.
    parks: (data: PhaseData, item: WorkItem) =>
      Effect.gen(function* () {
        const parked = Option.flatMap(Schema.decodeUnknownOption(ParkedWatch)(data), (watch) =>
          Option.map(DateTime.make(watch.since), (since) => ({ sha: watch.sha, since })),
        );

        if (Option.isNone(parked)) {
          return Option.none<WorkItem>();
        }

        const held = yield* watchHeld(parked.value.sha, parked.value.since, yield* limitsNow);

        return Option.some(
          Option.match(held, {
            onNone: () => item,
            onSome: (why): WorkItem => ({ ...item, held: why }),
          }),
        );
      }).pipe(reportAs("trigger")),
    contributes: {
      settings: { ...Settings.Ci.fields, ...Own.fields },
      wakeEvents: [Events.baseCiCompleted],
    },
  }),

  "merged.redBefore": defineBlock({
    name: "merged.redBefore",
    about:
      "Reads push CI on the merge commit's first parent, the base branch as it was before the merge (ci-before-merge). Comes to already-red when it was red there too: the merge didn't break it. The commit before may still be running CI, which reads as not red.",
    inputKinds: {
      pr: "PullRequestNumber: the merged pull request, trigger.pr",
      sha: "CommitSha: its merge commit, trigger.sha",
    },
    outputKinds: {
      redBefore: "boolean: whether CI was red before the merge",
      summary: "for `end`'s summary, on already-red",
    },
    outcomeKinds: { "already-red": "an object: summary, for end's summary" },
    inputs: { pr: "required", sha: "required" },
    run: (input: { readonly pr: PullRequestNumber; readonly sha: CommitSha }) =>
      redBeforeMerge(input.sha).pipe(
        Effect.map((redBefore) => ({
          redBefore,
          summary: `#${input.pr}: CI on ${shortOf(input.sha)} is red, as it already was before the merge; filed nothing`,
        })),
      ),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {
      "already-red": (before: { readonly redBefore: boolean; readonly summary: string }) =>
        Option.liftPredicate({ summary: before.summary }, () => before.redBefore),
    },
    mustRoute: ["already-red"],
    contributes: {},
  }),

  "merged.closesFollowUp": defineBlock({
    name: "merged.closesFollowUp",
    about:
      "Whether the issue the merged pull request closes is itself a follow-up of a red merge, by its hidden marker (chernabog-post-merge) (closes-follow-up). Its output is that issue, or none, for merged.fileFollowUp and merged.linkFollowUp: a red merge of a follow-up's own fix goes to a person, not to another follow-up.",
    inputKinds: { issue: "Option<IssueNumber>: the issue it closes, trigger.issue" },
    outputKinds: { fixed: "Option<IssueNumber>: the follow-up it fixed, if any" },
    outcomeKinds: {},
    inputs: { issue: "required" },
    run: (input: { readonly issue: Option.Option<IssueNumber> }) =>
      fixesAFollowUp(input.issue).pipe(Effect.map((fixed) => ({ fixed }))),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "merged.failureDetails": defineBlock({
    name: "merged.failureDetails",
    about:
      "Each failed run's link and the tail of its failed jobs' logs (failure-details), for merged.fileFollowUp.",
    inputKinds: { ci: "the red CI, from merged.awaitCi's red" },
    outputKinds: { details: "each failed run: name, url and the tail of its log" },
    outcomeKinds: {},
    inputs: { ci: "required" },
    run: (input: { readonly ci: RedCi }) =>
      failureDetails(input.ci.failedRuns).pipe(Effect.map((details) => ({ details }))),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "merged.fileFollowUp": defineBlock({
    name: "merged.fileFollowUp",
    about:
      "Files an issue, CI is red on <base> after #<n> merged, linking the merged pull request, the merge commit and each failed run with the tail of its log, with acceptance criteria for the fix (file-follow-up). It is labelled auto:eligible so implement takes it, or auto:needs-human when the pull request was a follow-up's own fix. Its body carries a hidden marker with the merge commit's sha (chernabog-post-merge): a run that resumes after filing finds that issue among the ones the persona opened lately and files no other.",
    inputKinds: {
      pr: "PullRequestNumber: the merged pull request, trigger.pr",
      url: "its URL, trigger.url",
      title: "its title, trigger.title",
      sha: "CommitSha: its merge commit, trigger.sha",
      base: "BaseBranch: the branch it merged into, trigger.base",
      ci: "the red CI, from merged.awaitCi's red",
      details: "from merged.failureDetails",
      fixed: "Option<IssueNumber>: from merged.closesFollowUp",
    },
    outputKinds: "IssueNumber: the follow-up",
    outcomeKinds: {},
    inputs: {
      pr: "required",
      url: "required",
      title: "required",
      sha: "required",
      base: "required",
      ci: "required",
      details: "required",
      fixed: "required",
    },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly url: string;
      readonly title: string;
      readonly sha: CommitSha;
      readonly base: BaseBranch;
      readonly ci: RedCi;
      readonly details: ReadonlyArray<FailureDetail>;
      readonly fixed: Option.Option<IssueNumber>;
    }) =>
      Effect.gen(function* () {
        const repo = yield* Repo;
        const body = followUpBody(input, repo.slug, input.ci, input.details, input.fixed);

        return yield* fileFollowUp(input, body, input.fixed);
      }),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "merged.linkFollowUp": defineBlock({
    name: "merged.linkFollowUp",
    about:
      "Comments on the merged pull request that CI went red on its merge commit, linking the follow-up. Its output is a summary, for end's summary.",
    inputKinds: {
      pr: "PullRequestNumber: the merged pull request, trigger.pr",
      sha: "CommitSha: its merge commit, trigger.sha",
      base: "BaseBranch: the branch it merged into, trigger.base",
      followUp: "IssueNumber: from merged.fileFollowUp",
      fixed: "Option<IssueNumber>: from merged.closesFollowUp",
    },
    outputKinds: "a summary, for `end`'s summary",
    outcomeKinds: {},
    inputs: {
      pr: "required",
      sha: "required",
      base: "required",
      followUp: "required",
      fixed: "required",
    },
    run: (input: {
      readonly pr: PullRequestNumber;
      readonly sha: CommitSha;
      readonly base: BaseBranch;
      readonly followUp: IssueNumber;
      readonly fixed: Option.Option<IssueNumber>;
    }) =>
      Effect.gen(function* () {
        const purpose = Option.match(input.fixed, {
          onNone: () => "to fix it",
          onSome: () => "for a person",
        });

        yield* PullRequest.comment(
          input.pr,
          `CI on \`${input.base}\` went red on this pull request's merge commit: #${input.followUp} is ${purpose}.`,
        );

        const pr = `#${input.pr}`;
        const short = shortOf(input.sha);

        if (Option.isSome(input.fixed)) {
          return `${pr}: CI on ${short} is red after a follow-up's fix; filed #${input.followUp} for a person`;
        }

        return `${pr}: CI on ${short} is red; filed #${input.followUp} to fix it`;
      }),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),
};

export const postMergeSources = {
  // Pull requests this persona wrote that merged into the base branch in the
  // last day, among the 30 closed most lately, and that no run has watched
  // yet: none recorded watched or parked watching it (awaiting-merge-ci),
  // nor, from before records, carries the marker.
  "pr.mergedRecently": defineSource(
    "pr.mergedRecently",
    "merged",
    () => ({
      trigger: Effect.gen(function* () {
        const github = yield* GitHub;
        const repo = yield* Repo;
        const base = yield* Settings.base;
        const me = yield* github.login;
        const now = yield* DateTime.now;
        const all = yield* records;
        const items: Array<WorkItem> = [];

        const closed = yield* github
          .request(
            "GET",
            `/repos/${repo.slug}/pulls?state=closed&sort=updated&direction=desc&per_page=30`,
            Option.none(),
          )
          .pipe(Effect.flatMap(decodeIn(ClosedPulls, "trigger")));

        for (const pull of closed) {
          if (
            !sameLogin(pull.user.login, me) ||
            pull.base.ref !== base ||
            Option.isNone(pull.merge_commit_sha) ||
            !Option.exists(pull.merged_at, (at) => isRecent(at, now))
          ) {
            continue;
          }

          // A finished watch isn't watched again, and a parked one is the
          // document's parked items' (Resume.parked) to offer. One the recipe
          // parked, which says nowhere to resume, is watched again from the top.
          const recorded = recordedWatch(all, pull.number);

          if (
            Option.exists(recorded, (watch) => watch !== "parked") ||
            (Option.isNone(recorded) && (yield* markedWatched(pull.number)))
          ) {
            continue;
          }

          const issue = closedIssue(
            Option.getOrElse(pull.body, () => ""),
            pull.head.ref,
          );

          items.push({
            key: `merged-${pull.number}`,
            title: pull.title,
            url: pull.html_url,
            data: {
              pullRequest: pull.number,
              url: pull.html_url,
              title: pull.title,
              mergeSha: pull.merge_commit_sha.value,
              baseRef: pull.base.ref,
              ...Option.match(issue, {
                onNone: () => ({}),
                onSome: (number) => ({ issue: number }),
              }),
            },
          });
        }

        return items;
      }).pipe(reportAs("trigger")),
      contributes: { settings: Settings.Base.fields, ownWork: true },
    }),
    {
      reads: [{ item: "pull-request", phases: [WATCHED, AWAITING] }],
      events: [Events.pullRequestClosed],
    },
  ),
};

// A pull request this persona wrote, merged into the base branch. A run only
// reads CI and files issues, so nothing else is owned or claimed. A failure
// going to a person labels the merged pull request auto:needs-human and
// comments why.
export const mergedSubject = {
  fields: ["pr", "url", "title", "sha", "base", "issue"],
  kinds: {
    pr: "PullRequestNumber",
    url: "its URL",
    title: "its title",
    sha: "CommitSha",
    base: "BaseBranch",
    issue: "Option<IssueNumber>",
  },
  failureContext: [],
  read: (item: WorkItem) =>
    Schema.decodeUnknownEffect(MergedItem)(item.data).pipe(
      Effect.mapError((issue) => new StepFailed({ step: "item", message: issue.message })),
      Effect.map((merged) => ({
        pr: PullRequestNumber(merged.pullRequest),
        url: merged.url,
        title: merged.title,
        sha: CommitSha(merged.mergeSha),
        base: BaseBranch(merged.baseRef),
        issue: Option.map(Option.fromUndefinedOr(merged.issue), IssueNumber),
      })),
    ),
  scope: <A, E, R>(
    trigger: { readonly pr: PullRequestNumber },
    _options: { readonly claims: boolean },
    body: (context: FailureContext) => Effect.Effect<A, E | ToPerson, R>,
  ) =>
    Effect.suspend(() => body({ pr: Option.some(trigger.pr) })).pipe(
      Effect.catchIf(
        (failure): failure is ToPerson => failure instanceof ToPerson,
        (failure) => PullRequest.handToPerson(trigger.pr, failure.reason),
      ),
    ),
  // The recipe declares none: a merged pull request stays merged.
  stillValid: Option.none(),
};

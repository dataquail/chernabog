// Watches CI on the base branch after a pull request this persona wrote
// merges. Nothing else looks at the merge commit: when CI goes red there, a
// person finds out when the next pull request's CI fails. This flow waits for
// the merge commit's push CI and, when it's red, files a follow-up issue
// labelled auto:eligible, with the failed runs and the tail of their logs, so
// implement takes the fix on.
//
// Each pull request is watched once: the run's first step records its
// watched phase, which the trigger reads, and comments on it that it is
// watching. A merge watched before runs recorded it is known by the hidden
// marker in that comment. The follow-up carries a
// marker with the merge commit's sha, so a run that resumes after filing
// finds it rather than filing another. A red merge of a follow-up's own fix
// goes to a person (auto:needs-human), not to another follow-up. And when CI
// was already red on the commit before the merge, the merge didn't break it,
// and nothing is filed.
//
// Push CI can take minutes or hours, and a run ends at every park, so a
// first reading still pending parks: the run records awaiting-merge-ci on
// the pull request, with the merge commit and when the watch began, and
// ends. The trigger offers it again once CI settles, or none started within
// noCiGrace, or ciTimeout passed, both counted from when the watch began.
// The run that takes it up reads CI once, records watched again, and goes on.
//
// This file is chernabog's post-merge recipe, and this repo's to change:
// `chernabog recipes diff` shows how it differs from the recipe's current
// version. The names of its steps ("mark-watched", "watch-limits",
// "watch-since", "ci-<n>", "awaiting-merge-ci", "watch-ended",
// "ci-before-merge", "closes-follow-up", "failure-details", "file-follow-up")
// are the keys a run in flight resumes by, so renaming one restarts that step.

import {
  activity,
  awaitSignal,
  type CiFailedRun,
  defineFlow,
  Events,
  GitHub,
  type Json,
  NeedsHuman,
  type PhaseRecord,
  Phases,
  PullRequest,
  Repo,
  reportAs,
  Settings,
  sleep,
  StepFailed,
  type WorkItem,
} from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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

// What config.yaml may set for this flow alone, under flows.<name>.settings.
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

const WATCHED = Phases.PHASES.pullRequest.watched;

// Records that a run is watching the merge: the pull request's watched phase,
// carrying the merge commit, from whatever phase its review left.
const markWatched = (merged: MergedItem) =>
  activity(
    "mark-watched",
    Phases.record(Phases.pullRequestItem(merged.pullRequest), WATCHED, { sha: merged.mergeSha }),
  );

const AWAITING = Phases.PHASES.pullRequest.awaitingMergeCi;

// What a parked watch's record carries: the merge commit, and when the watch
// began, which noCiGrace and ciTimeout count from across the runs that take
// it up. The record's `at` won't do for that: a record written afresh has a
// new one.
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

// Whether a run watched the merge of pull request `number` before runs
// recorded it, by the marker on it: for a merge whose record is neither
// watched nor parked watching it.
const markedWatched = (number: number) =>
  Effect.map(
    GitHub.use((github) => github.trustedComments(number)),
    (comments) => comments.some((comment) => Option.isSome(watchedMarker.read(comment.body))),
  );

// On a follow-up issue: the merge commit whose red CI it is for.
const followUpMarker = marker(
  "post-merge",
  Schema.Struct({ sha: Schema.String, pullRequest: Schema.Finite }),
);

const MergedItem = Schema.Struct({
  pullRequest: Schema.Finite,
  url: Schema.String,
  title: Schema.String,
  mergeSha: Schema.String,
  baseRef: Schema.String,
  // The issue the pull request closes, when it names one.
  issue: Schema.optionalKey(Schema.Finite),
  // A watch a run parked, which this run takes up.
  resumeWatch: Schema.optionalKey(Schema.Literal(true)),
});

type MergedItem = typeof MergedItem.Type;

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

type RedCi = Extract<MergeCi, { readonly state: "red" }>;

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

const watchClock = (merged: MergedItem) =>
  activity(
    "watch-since",
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const found = yield* Phases.current(Phases.pullRequestItem(merged.pullRequest));

      return Option.match(
        Option.flatMap(found, (parked) => parkedSince(parked, merged.mergeSha)),
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
// again, which the trigger takes for finished, by this run, not the one that
// parked. One whose watch never parked holds watched already.
const endWatch = (merged: MergedItem) =>
  activity(
    "watch-ended",
    Effect.gen(function* () {
      const item = Phases.pullRequestItem(merged.pullRequest);
      const found = yield* Phases.current(item);

      if (Option.isSome(Option.flatMap(found, (parked) => parkedSince(parked, merged.mergeSha)))) {
        yield* Phases.record(item, WATCHED, { sha: merged.mergeSha });
      }
    }),
  );

// Records that the watch waits on push CI, with the merge commit and when the
// watch began, and parks, which ends the run. A run that takes up a parked
// watch and parks again keeps the record it found, `since` and all:
// Phases.record writes nothing over the same phase. Nothing sends the signal:
// the run that takes the watch up is a new one.
const parkWatch = (merged: MergedItem, since: string, timeout: Duration.Duration) =>
  activity(
    "awaiting-merge-ci",
    Phases.record(Phases.pullRequestItem(merged.pullRequest), AWAITING, {
      sha: merged.mergeSha,
      since,
    }),
  ).pipe(Effect.andThen(awaitSignal(["merge-ci-settled"], { id: "merge-ci", timeout })));

// Why a parked watch of `sha` can't be taken up yet, for the trigger to hold
// it with: push CI still pending, with a run to wait on inside ciTimeout, or
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

// Watches the merge commit's push CI until it stops pending. No run within
// the noCiGrace setting is no CI for this push; still pending after the
// ciTimeout setting is a person's to look at; both count from when the watch
// began, across the runs that take it up. A first reading still pending
// parks (parkWatch), and the trigger offers the watch again once it settles.
const awaitMergeCi = (merged: MergedItem, limits: WatchLimits) =>
  Effect.gen(function* () {
    const grace = Duration.toMillis(limits.grace);
    const timeout = Duration.toMillis(limits.timeout);
    const every = Duration.toMillis(CI_POLL);
    const clock = yield* watchClock(merged);

    for (let poll = 1; ; poll++) {
      if (poll > 1) {
        yield* sleep(`ci-${poll}-wait`, CI_POLL);
      }

      const reading = yield* readMergeCi(merged.mergeSha, poll);

      if (reading.state !== "pending") {
        yield* endWatch(merged);

        return reading;
      }

      const waited = Duration.toMillis(clock.waited) + (poll - 1) * every;

      if (reading.waitingOn.length === 0 && waited >= grace) {
        yield* endWatch(merged);

        return { state: "none" as const };
      }

      if (waited >= timeout) {
        yield* endWatch(merged);

        return yield* new NeedsHuman({
          reason: `CI on ${merged.baseRef} at ${merged.mergeSha} stayed pending for ${Duration.format(limits.timeout)} after #${merged.pullRequest} merged`,
        });
      }

      if (poll === 1) {
        yield* parkWatch(merged, clock.since, limits.timeout);
      }
    }
  });

// Pull requests this persona wrote that merged into the base branch lately,
// and that no run has watched yet: none recorded watched, nor, from before
// records, carries the marker. And those whose watch a run parked
// (awaiting-merge-ci), as work a run may start, which takes the watch up:
// held, with why, while push CI on the merge commit is still pending and
// the watch has time left.
const trigger = Effect.gen(function* () {
  const github = yield* GitHub;
  const repo = yield* Repo;
  const base = yield* Settings.base;
  const me = yield* github.login;
  const now = yield* DateTime.now;
  const all = yield* Phases.records;
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

    const sha = pull.merge_commit_sha.value;
    const recorded = Phases.recordOf(all, Phases.pullRequestItem(pull.number));

    if (Option.exists(recorded, (found) => found.phase === WATCHED)) {
      continue;
    }

    const parked = Option.flatMap(recorded, (found) => parkedSince(found, sha));

    if (
      !Option.exists(recorded, (found) => found.phase === AWAITING) &&
      (yield* markedWatched(pull.number))
    ) {
      continue;
    }

    const issue = closedIssue(
      Option.getOrElse(pull.body, () => ""),
      pull.head.ref,
    );

    const item: WorkItem = {
      key: `merged-${pull.number}`,
      title: pull.title,
      url: pull.html_url,
      data: {
        pullRequest: pull.number,
        url: pull.html_url,
        title: pull.title,
        mergeSha: sha,
        baseRef: pull.base.ref,
        ...Option.match(issue, { onNone: () => ({}), onSome: (number) => ({ issue: number }) }),
        ...Option.match(parked, { onNone: () => ({}), onSome: () => ({ resumeWatch: true }) }),
      },
    };

    if (Option.isNone(parked)) {
      items.push(item);
      continue;
    }

    const held = yield* watchHeld(sha, parked.value, yield* limitsNow);

    items.push(
      Option.match(held, {
        onNone: () => item,
        onSome: (why): WorkItem => ({ ...item, held: why }),
      }),
    );
  }

  return items;
}).pipe(reportAs("trigger"));

const Parents = Schema.Struct({ parents: Schema.Array(Schema.Struct({ sha: Schema.String })) });

// Whether push CI was already red on the merge commit's first parent, the
// base branch as it was before the merge.
const redBeforeMerge = (merged: MergedItem) =>
  activity(
    "ci-before-merge",
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;

      const commit = yield* github
        .request("GET", `/repos/${repo.slug}/commits/${merged.mergeSha}`, Option.none())
        .pipe(Effect.flatMap(decodeIn(Parents, "ci-before-merge")));

      const parent = Arr.head(commit.parents);

      if (Option.isNone(parent)) {
        return false;
      }

      return (yield* github.commitCiState(parent.value.sha, { event: "push" })).state === "red";
    }),
    Schema.Boolean,
  );

// The follow-up this recipe filed that the merged pull request fixed, if it fixed one.
const fixesAFollowUp = (merged: MergedItem) =>
  activity(
    "closes-follow-up",
    Effect.gen(function* () {
      const closes = Option.fromUndefinedOr(merged.issue);

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
  );

const FailureDetail = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  logTail: Schema.Option(Schema.String),
});

type FailureDetail = typeof FailureDetail.Type;

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

const followUpBody = (
  merged: MergedItem,
  slug: string,
  ci: RedCi,
  details: ReadonlyArray<FailureDetail>,
  fixed: Option.Option<number>,
) => {
  const commit = `[\`${merged.mergeSha.slice(0, 7)}\`](https://github.com/${slug}/commit/${merged.mergeSha})`;

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
    `CI on \`${merged.baseRef}\` went red on ${commit}, the merge commit of #${merged.pullRequest} ([${merged.title}](${merged.url})). CI on the commit before it was not red, so the merge is the likely cause.`,
    ...Option.match(fixed, {
      onNone: () => [],
      onSome: (issue) => [
        `#${merged.pullRequest} was the fix for #${issue}, itself a follow-up of a red merge, so this one is for a person rather than another follow-up.`,
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
      `- [ ] CI on \`${merged.baseRef}\` passes again: the failed checks above pass on the fix.`,
      `- [ ] The fix keeps what #${merged.pullRequest} meant to change, or its pull request says why not.`,
    ].join("\n"),
    followUpMarker.write({ sha: merged.mergeSha, pullRequest: merged.pullRequest }),
  ].join("\n\n");
};

const Made = Schema.Array(
  Schema.Struct({ number: Schema.Finite, body: Schema.OptionFromNullOr(Schema.String) }),
);

// The follow-up already filed for this merge commit, among the issues this login opened lately.
const filedFor = (sha: string) =>
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
const fileFollowUp = (merged: MergedItem, body: string, fixed: Option.Option<number>) =>
  activity(
    "file-follow-up",
    Effect.gen(function* () {
      const existing = yield* filedFor(merged.mergeSha);

      if (Option.isSome(existing)) {
        return existing.value;
      }

      const labelNames = yield* Settings.labels;

      const issue = yield* (yield* GitHub).createIssue({
        title: `CI is red on ${merged.baseRef} after #${merged.pullRequest} merged`,
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
  );

const watch = (merged: MergedItem) =>
  Effect.gen(function* () {
    const repo = yield* Repo;
    const short = merged.mergeSha.slice(0, 7);
    const pr = `#${merged.pullRequest}`;

    // A run that takes up a parked watch has marked it and commented already.
    if (merged.resumeWatch !== true) {
      yield* markWatched(merged);

      yield* PullRequest.comment(
        merged.pullRequest,
        `Watching CI on \`${merged.baseRef}\` at ${merged.mergeSha}, this pull request's merge commit. ${watchedMarker.write({ sha: merged.mergeSha })}`,
      );
    }

    const limits = yield* watchLimits;
    const ci = yield* awaitMergeCi(merged, limits);

    if (ci.state === "none") {
      return `${pr}: no CI ran on ${short} within ${Duration.format(limits.grace)}; taken as none for this push`;
    }

    if (ci.state === "green") {
      return `${pr}: CI on ${short} is green`;
    }

    if (yield* redBeforeMerge(merged)) {
      return `${pr}: CI on ${short} is red, as it already was before the merge; filed nothing`;
    }

    const fixed = yield* fixesAFollowUp(merged);
    const details = yield* failureDetails(ci.failedRuns);
    const body = followUpBody(merged, repo.slug, ci, details, fixed);
    const followUp = yield* fileFollowUp(merged, body, fixed);

    const purpose = Option.match(fixed, {
      onNone: () => "to fix it",
      onSome: () => "for a person",
    });

    yield* PullRequest.comment(
      merged.pullRequest,
      `CI on \`${merged.baseRef}\` went red on this pull request's merge commit: #${followUp} is ${purpose}.`,
    );

    if (Option.isSome(fixed)) {
      return `${pr}: CI on ${short} is red after a follow-up's fix; filed #${followUp} for a person`;
    }

    return `${pr}: CI on ${short} is red; filed #${followUp} to fix it`;
  });

const workflow = (item: WorkItem) =>
  Effect.gen(function* () {
    const merged = yield* Schema.decodeUnknownEffect(MergedItem)(item.data).pipe(
      Effect.mapError((issue) => new StepFailed({ step: "item", message: issue.message })),
    );

    return yield* watch(merged);
  });

// What config.yaml may set for this flow, under settings: or flows.<name>.settings.
const settings = Schema.Struct({
  ...Settings.Labels.fields,
  ...Settings.Base.fields,
  ...Settings.Ci.fields,
  ...Own.fields,
});

const flow = defineFlow({
  trigger,
  // No agent runs, so no usage gate. Watching is only reading CI, so several merges are watched at once.
  concurrency: 4,
  // Its trigger finds only pull requests this persona wrote.
  ownWork: true,
  labels: Settings.declaredLabels,
  settings,
  workflow,
});

// The GitHub events that can change what its trigger finds, so it wakes in CI
// rather than only on the schedule: a pull request closing, merged among them,
// and a CI run finishing, which may settle a parked watch's push CI. A push
// CI run's branch is the base, which names no item, so it wakes the plan for
// every one. Only its own runs record the phases its trigger reads, and a
// park settles nothing, so a phase event doesn't wake it.
export default Events.declare(flow, {
  events: [Events.pullRequestClosed, Events.baseCiCompleted],
  readsPhases: false,
});

// Watches CI on the base branch after a pull request this persona wrote
// merges. Nothing else looks at the merge commit: when CI goes red there, a
// person finds out when the next pull request's CI fails. This flow waits for
// the merge commit's push CI and, when it's red, files a follow-up issue
// labelled auto:eligible, with the failed runs and the tail of their logs, so
// implement takes the fix on.
//
// Each pull request is watched once: the run's first step comments on it
// with a hidden marker, which the trigger looks for. The follow-up carries a
// marker with the merge commit's sha, so a run that resumes after filing
// finds it rather than filing another. A red merge of a follow-up's own fix
// goes to a person (auto:needs-human), not to another follow-up. And when CI
// was already red on the commit before the merge, the merge didn't break it,
// and nothing is filed.
//
// This file is chernabog's post-merge recipe, and this repo's to change:
// `chernabog recipes diff` shows how it differs from the recipe's current
// version. The names of its steps ("watch-limits", "ci-<n>", "ci-before-merge",
// "closes-follow-up", "failure-details", "file-follow-up") are the keys a
// run in flight resumes by, so renaming one restarts that step.

import {
  activity,
  type CiFailedRun,
  defineFlow,
  GitHub,
  type Json,
  NeedsHuman,
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

// On the merged pull request: a run watched its merge commit.
const watchedMarker = marker("post-merge-watched", Schema.Struct({ sha: Schema.String }));

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

// Pull requests this persona wrote that merged into the base branch lately,
// and that no run has watched yet.
const trigger = Effect.gen(function* () {
  const github = yield* GitHub;
  const repo = yield* Repo;
  const base = yield* Settings.base;
  const me = yield* github.login;
  const now = yield* DateTime.now;
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

    const comments = yield* github.trustedComments(pull.number);

    if (comments.some((comment) => Option.isSome(watchedMarker.read(comment.body)))) {
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
        ...Option.match(issue, { onNone: () => ({}), onSome: (number) => ({ issue: number }) }),
      },
    });
  }

  return items;
}).pipe(reportAs("trigger"));

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

// The no-CI grace and the CI timeout, read once, so a replay decides the same.
const watchLimits = activity(
  "watch-limits",
  Effect.gen(function* () {
    const own = yield* Settings.read(Own);
    const ci = yield* Settings.ci;

    return {
      grace: Option.getOrElse(
        Option.flatMap(Option.fromUndefinedOr(own.noCiGrace), durationOf),
        () => NO_CI_GRACE,
      ),
      timeout: ci.timeout,
    };
  }),
  WatchLimits,
);

// Polls the merge commit's push CI durably until it stops pending. No run
// within the noCiGrace setting is no CI for this push; still pending after
// the ciTimeout setting is a person's to look at.
const awaitMergeCi = (merged: MergedItem, limits: WatchLimits) =>
  Effect.gen(function* () {
    const grace = Duration.toMillis(limits.grace);
    const timeout = Duration.toMillis(limits.timeout);
    const every = Duration.toMillis(CI_POLL);

    for (let poll = 1; ; poll++) {
      if (poll > 1) {
        yield* sleep(`ci-${poll}-wait`, CI_POLL);
      }

      const reading = yield* readMergeCi(merged.mergeSha, poll);

      if (reading.state !== "pending") {
        return reading;
      }

      const waited = (poll - 1) * every;

      if (reading.waitingOn.length === 0 && waited >= grace) {
        return { state: "none" as const };
      }

      if (waited >= timeout) {
        return yield* new NeedsHuman({
          reason: `CI on ${merged.baseRef} at ${merged.mergeSha} stayed pending for ${Duration.format(limits.timeout)} after #${merged.pullRequest} merged`,
        });
      }
    }
  });

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

    yield* PullRequest.comment(
      merged.pullRequest,
      `Watching CI on \`${merged.baseRef}\` at ${merged.mergeSha}, this pull request's merge commit. ${watchedMarker.write({ sha: merged.mergeSha })}`,
    );

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

export default defineFlow({
  trigger,
  // No agent runs, so no usage gate. Watching is only polling, so several merges are watched at once.
  concurrency: 4,
  // Its trigger finds only pull requests this persona wrote.
  ownWork: true,
  labels: Settings.declaredLabels,
  settings,
  workflow,
});

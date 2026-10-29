// The settings the SDK's blocks read, as schemas a recipe includes in its own:
// `settings: Schema.Struct({ ...Settings.Ci.fields, promoteFrom: Schema.String })`.
// A repo sets them in .chernabog/config.yaml, once for every flow under
// `settings:`, or for one under `flows.<name>.settings`. Each block reads its
// own keys with core's Settings.read, so a recipe that leaves a block's
// schema out still runs it, on what config.yaml set.
//
// Until core's next major (ADR 0005), a setting the flow's settings leave
// out falls back to config.yaml's old key, which the binary still gives
// every flow as Repo's: `limits.ciRounds` for `ciRounds`, `labels` for
// `labels`, `baseBranch` for `base`, and so on.

import { type FlowLabel, Repo, type RepoSettings, Settings as CoreSettings } from "@chernabog/core";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

export const FlowSettings = CoreSettings.FlowSettings;

export type FlowSettings = CoreSettings.FlowSettings;

export type SettingsSchema = CoreSettings.SettingsSchema;

// Decodes the flow's settings with `schema`: the flow's own, or a part of it.
export const read = CoreSettings.read;

const Strings = Schema.Array(Schema.String);

// A YAML null turns the setting off.
const Nullable = <S extends Schema.Constraint>(schema: S) =>
  Schema.optionalKey(Schema.NullOr(schema));

const Count = (description: string) => Schema.optionalKey(Schema.Int.annotate({ description }));

const DURATION = /^(\d+(?:\.\d+)?)\s*(millis?|seconds?|minutes?|hours?|days?|weeks?)$/;

const UNIT_MILLIS: Readonly<Record<string, number>> = {
  milli: 1,
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

// "6 hours", "90 minutes": the durations config may name.
const parseDuration = (text: string) =>
  Option.fromNullishOr(DURATION.exec(text.trim())).pipe(
    Option.flatMap((match) =>
      Option.map(Record.get(UNIT_MILLIS, match[2].replace(/s$/, "")), (millis) =>
        Duration.millis(Number(match[1]) * millis),
      ),
    ),
  );

const DurationText = (description: string) =>
  Schema.optionalKey(
    Schema.String.pipe(
      Schema.check(
        Schema.makeFilter(
          (text: string) =>
            Option.isSome(parseDuration(text)) || `"${text}" is not a duration, such as "6 hours"`,
        ),
      ),
    ).annotate({ description }),
  );

// The labels the SDK's issue-to-pull-request blocks put on issues and pull
// requests, by what each means.
export const LabelNames = Schema.Struct({
  eligible: Schema.String,
  inProgress: Schema.String,
  needsReview: Schema.String,
  changesRequested: Schema.String,
  approved: Schema.String,
  needsHuman: Schema.String,
  needsClarification: Schema.String,
  stale: Schema.String,
  // The automated path: a pull request merges only when it carries this.
  ship: Schema.String,
  // The hybrid path, for people reading GitHub: a person started the work. No block decides anything from it.
  hybrid: Schema.String,
});

export type LabelNames = typeof LabelNames.Type;

export const DEFAULT_LABEL_NAMES: LabelNames = {
  eligible: "auto:eligible",
  inProgress: "auto:in-progress",
  needsReview: "auto:needs-review",
  changesRequested: "auto:changes-requested",
  approved: "auto:approved",
  needsHuman: "auto:needs-human",
  needsClarification: "auto:needs-clarification",
  stale: "auto:stale",
  ship: "auto:ship",
  hybrid: "hybrid",
};

const name = Schema.optionalKey(Schema.String);

export const Labels = Schema.Struct({
  labels: Schema.optionalKey(
    Schema.Struct({
      eligible: name,
      inProgress: name,
      needsReview: name,
      changesRequested: name,
      approved: name,
      needsHuman: name,
      needsClarification: name,
      stale: name,
      ship: name,
      hybrid: name,
    }).annotate({ description: "The label names the SDK's blocks use, by what each means." }),
  ),
});

// The label names, each one the flow's settings give over the repo's.
export const labels = Effect.gen(function* () {
  const repo = yield* Repo;
  const own = yield* read(Labels);

  return { ...DEFAULT_LABEL_NAMES, ...repo.labels, ...own.labels } satisfies LabelNames;
});

const LOOK = {
  eligible: { color: "0e8a16", description: "Queued for an unattended run; removed on claim" },
  inProgress: { color: "fbca04", description: "An unattended run owns this issue" },
  needsReview: {
    color: "1d76db",
    description: "PR is open and green; waiting for a person to review it",
  },
  changesRequested: { color: "e99695", description: "Review comments posted; waiting for a push" },
  approved: { color: "0e8a16", description: "Approved by an agent review; a person merges" },
  needsHuman: {
    color: "b60205",
    description: "A loop cap or a rule stopped the run; a person takes over",
  },
  needsClarification: {
    color: "d876e3",
    description: "Questions are on the issue; answer, then requeue",
  },
  stale: { color: "7f8c8d", description: "No push before the staleness timeout" },
  ship: {
    color: "5319e7",
    description: "The automated path: chernabog implements, and merges once a review approves",
  },
  hybrid: {
    color: "bfd4f2",
    description: "The hybrid path: a person worked on it with an agent; a person merges",
  },
} satisfies Readonly<
  Record<keyof LabelNames, { readonly color: string; readonly description: string }>
>;

// The label set, with the look `chernabog labels` gives each.
export const labelSet = (names: LabelNames): ReadonlyArray<FlowLabel> =>
  Struct.keys(LOOK).map((key) => ({
    name: names[key],
    ...LOOK[key],
  }));

// For a flow's `labels`: the label set under the names its settings give.
export const declaredLabels = Effect.map(labels, labelSet);

export const Base = Schema.Struct({
  base: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The branch the flow's work starts from and its pull requests target, such as develop in git flow. Unset: the repo's default branch.",
    }),
  ),
});

// The integration base: the branch new work starts from and merges into. It
// is the flow's to choose, never the branch .chernabog/ is read from, which
// is GitHub's default; a flow that leaves it out targets that default (or
// config.yaml's deprecated baseBranch).
export const base = Effect.gen(function* () {
  const repo = yield* Repo;
  const own = yield* read(Base);

  return own.base ?? repo.baseBranch;
});

export const Ci = Schema.Struct({
  ciRounds: Count("Pushes to fix red CI before a person takes over."),
  ciTimeout: DurationText('How long CI may stay pending before a person looks, such as "2 hours".'),
  ciGates: Schema.optionalKey(
    Schema.Literals(["required", "every"]).annotate({
      description:
        "The checks that must pass: those the base branch requires (every check when it requires none, or GitHub won't say), or every check.",
    }),
  ),
  ciOptionalFailures: Schema.optionalKey(
    Schema.Literals(["hold", "ignore"]).annotate({
      description:
        "Whether a failing check that doesn't gate still makes CI red (hold), or is left alone (ignore).",
    }),
  ),
});

// The CI gate's policy, for Ci.verdict: required checks gate, and any
// failing check holds, unless the flow's settings say otherwise.
export const ciGate = Effect.map(read(Ci), (own) => ({
  gates: own.ciGates ?? "required",
  optionalFailures: own.ciOptionalFailures ?? "hold",
}));

export const ci = Effect.gen(function* () {
  const repo = yield* Repo;
  const own = yield* read(Ci);

  return {
    rounds: own.ciRounds ?? repo.limits.ciRounds,
    timeout: Option.getOrElse(
      Option.flatMap(Option.fromUndefinedOr(own.ciTimeout), parseDuration),
      () => repo.limits.ciTimeout,
    ),
  };
});

export const LocalGate = Schema.Struct({
  localGate: Schema.optionalKey(
    Strings.annotate({
      description: "Commands the change must pass before its pull request opens.",
    }),
  ),
  localGateRounds: Count(
    "Agent attempts to get the local gate passing before a person takes over.",
  ),
  install: Nullable(
    Schema.String.annotate({
      description: "Run in a fresh worktree before the agent starts. null for none.",
    }),
  ),
});

// A flow's install over the repo's; null for none.
const installOf = (own: typeof LocalGate.Type, repo: RepoSettings) =>
  Option.match(Option.fromUndefinedOr(own.install), {
    onNone: () => repo.install,
    onSome: Option.fromNullOr,
  });

export const localGate = Effect.gen(function* () {
  const repo = yield* Repo;
  const own = yield* read(LocalGate);

  return {
    commands: own.localGate ?? repo.localGate,
    rounds: own.localGateRounds ?? repo.limits.localGateRounds,
    install: installOf(own, repo),
  };
});

export const Reviewers = Schema.Struct({
  reviewers: Schema.optionalKey(
    Strings.annotate({
      description:
        "The reviewer pool, by GitHub login: a pull request with green CI asks one of them at random to review it, never its author. Each needs write access, since the reviewer merges on the automated path.",
    }),
  ),
  reviewRounds: Count("Re-reviews of one pull request before a person takes over."),
});

export const reviewers = Effect.gen(function* () {
  const repo = yield* Repo;
  const own = yield* read(Reviewers);

  return {
    pool: own.reviewers ?? repo.reviewers ?? [],
    rounds: own.reviewRounds ?? repo.limits.reviewRounds,
  };
});

export const Rules = Schema.Struct({
  humanOnly: Schema.optionalKey(
    Strings.annotate({
      description:
        "Decisions the agent must stop for and leave to a person, beyond the repo's and the machine's.",
    }),
  ),
  humanOnlyPaths: Schema.optionalKey(
    Strings.annotate({
      description:
        "Paths a change must not touch; one that does goes to a person instead of a pull request.",
    }),
  ),
  notes: Schema.optionalKey(Strings.annotate({ description: "Repo facts the agent should know." })),
});

// The rules an agent works by. humanOnly adds to the repo's and the machine's,
// so a flow's settings never drop a decision someone left to a person.
export const rules = Effect.gen(function* () {
  const repo = yield* Repo;
  const own = yield* read(Rules);

  return {
    humanOnly: [...repo.humanOnly, ...(own.humanOnly ?? [])],
    humanOnlyPaths: own.humanOnlyPaths ?? repo.humanOnlyPaths,
    notes: own.notes ?? repo.notes,
  };
});

export const Board = Schema.Struct({
  board: Nullable(
    Schema.Struct({
      projectNumber: Schema.Int,
      readyStatus: Schema.String,
      inProgressStatus: Schema.String,
    }).annotate({
      description:
        "The GitHub project board an issue moves across as it is claimed. null for none.",
    }),
  ),
});

export const board = Effect.gen(function* () {
  const repo = yield* Repo;
  const own = yield* read(Board);

  return Option.match(Option.fromUndefinedOr(own.board), {
    onNone: () => repo.board,
    onSome: Option.fromNullOr,
  });
});

export const Plans = Schema.Struct({
  planNodes: Count("The most tasks one plan may hold, its verify node aside."),
  planRounds: Count(
    "Times the agent is asked to fix a plan that fails its checks before a person takes over.",
  ),
});

export const plans = Effect.gen(function* () {
  const repo = yield* Repo;
  const own = yield* read(Plans);

  return {
    nodes: own.planNodes ?? repo.limits.planNodes,
    rounds: own.planRounds ?? repo.limits.planRounds,
  };
});

export const Stacks = Schema.Struct({
  stackDepth: Count(
    "The most layers one stack may hold before the run stops starting new ones and waits for the bottom to merge.",
  ),
});

export const stackDepth = Effect.gen(function* () {
  const repo = yield* Repo;
  const own = yield* read(Stacks);

  return own.stackDepth ?? repo.limits.stackDepth;
});

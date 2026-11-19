// The building blocks of the `epic` recipe: from an epic's sub-issues and the
// issues that block each, which open tasks may start, on the base branch or
// stacked on the work branch of the one task that blocks them, and why the
// rest wait. A closed blocker counts as done: the epic run closes a task only
// once its work reaches the base branch.

import { createHash } from "node:crypto";

import {
  activity,
  awaitSignal,
  Claims,
  GitHub,
  isPhaseData,
  type LinkedIssue,
  type PhaseRecord,
  planNodeMarker,
  printJson,
  type PullRequest,
  Repo,
  Run,
  RunLog,
  Skip,
  StepFailed,
  type WorkItem,
} from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Ci from "./ci.ts";
import * as Implement from "./implement.ts";
import { heldOnCi, issueItem, issueOf, routed } from "./implement.ts";
import * as Phases from "./phases.ts";
import { type Kind, VERIFY } from "./plan.ts";
import { LABELS as PLAN_LABELS } from "./plan-labels.ts";
import * as Settings from "./settings.ts";
import * as Stack from "./stack.ts";
import { epicValidity } from "./still-valid.ts";

export type { Kind } from "./plan.ts";

// A task that may start now, on `base`: the flow's integration base
// (Settings.base), or the work branch of the task it stacks on.
export type Ready = {
  readonly state: "ready";
  readonly base: string;
  readonly stackedOn: Option.Option<number>;
};

// A task that waits, and why, as a WorkItem's `held` says it, and the tasks it
// waits on.
export type Held = {
  readonly state: "held";
  readonly reason: string;
  readonly waitsOn: ReadonlyArray<number>;
};

export type Task = { readonly number: number; readonly title: string; readonly kind: Kind } & (
  Ready | Held
);

// Each open task of the epic, in GitHub's order, and its verify task apart.
export type Tasks = { readonly tasks: ReadonlyArray<Task>; readonly verify: Option.Option<Task> };

// Who takes a task, by the labels the plan gave it: auto:needs-human for a
// person, auto:eligible for an agent, and neither for a person with an agent.
export const kindOf = (labels: ReadonlyArray<string>, names: Settings.LabelNames): Kind => {
  if (labels.includes(names.needsHuman)) {
    return "human";
  }

  if (labels.includes(names.eligible)) {
    return "auto";
  }

  return "hybrid";
};

// Whether a sub-issue is the verify task the plan for this epic added.
export const isVerify = (epic: number, issue: LinkedIssue) =>
  Option.exists(
    planNodeMarker.read(issue.body),
    (marker) => marker.spec === epic && marker.key === VERIFY,
  );

const waitsOn = (blockers: ReadonlyArray<number>) =>
  `waits on ${blockers.map((blocker) => `#${blocker}`).join(", ")}`;

const ready = (base: string, stackedOn: Option.Option<number>): Ready => ({
  state: "ready",
  base,
  stackedOn,
});

const held = (reason: string, blockers: ReadonlyArray<number>): Held => ({
  state: "held",
  reason,
  waitsOn: blockers,
});

// A task held until `blockers` close.
const heldOn = (blockers: ReadonlyArray<number>) => held(waitsOn(blockers), blockers);

// The tasks an epic run started, whose claim took their queue label off, so
// they no longer read as auto: a task stacks on one as on an auto task.
export type TasksOptions = { readonly started?: ReadonlyArray<number> };

// The epic's open tasks, each ready or held: ready on the base branch with no
// open blocker; stacked on its blocker's work branch when that one open
// blocker is an auto task of this epic (or one `started`) with an open pull
// request, and the stack stays within limits.stackDepth; held otherwise. The
// verify task is ready only once every other sub-issue is closed.
export const tasks = (epic: number, options: TasksOptions = {}) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const labelNames = yield* Settings.labels;
    const stackDepth = yield* Settings.stackDepth;
    const base = yield* Settings.base;
    const open = (yield* github.subIssues(epic)).filter((issue) => issue.state === "open");
    const verify = open.find((issue) => isVerify(epic, issue));
    const work = open.filter((issue) => !isVerify(epic, issue));

    // The epic's open auto tasks, and those started, the only ones another task stacks on.
    const auto = new Set(
      work
        .filter(
          (issue) =>
            kindOf(issue.labels, labelNames) === "auto" ||
            (options.started ?? []).includes(issue.number),
        )
        .map((issue) => issue.number),
    );

    const byBranch = new Map(work.map((issue) => [Claims.branchFor(issue.number), issue.number]));
    const pulls = new Map<number, Option.Option<PullRequest>>();

    // The open pull request from a task's work branch, asked once a call.
    const pullOf = (task: number) =>
      Effect.gen(function* () {
        const known = Option.fromUndefinedOr(pulls.get(task));

        if (Option.isSome(known)) {
          return known.value;
        }

        const found = Option.filter(
          yield* github.pullRequestForBranch(Claims.branchFor(task)),
          (pull) => pull.state === "open",
        );

        pulls.set(task, found);

        return found;
      });

    // The layers in the stack `pull` tops: itself, and each open task's pull
    // request below it, by its base branch.
    const depthOf = (pull: PullRequest) =>
      Effect.gen(function* () {
        let depth = 1;
        let top = pull;

        for (let hops = 0; hops < work.length; hops++) {
          const below = Option.fromUndefinedOr(byBranch.get(top.baseRef));

          if (Option.isNone(below)) {
            break;
          }

          const next = yield* pullOf(below.value);

          if (Option.isNone(next)) {
            break;
          }

          depth += 1;
          top = next.value;
        }

        return depth;
      });

    const stateOf = (task: LinkedIssue) =>
      Effect.gen(function* () {
        const blockers = (yield* github.blockedBy(task.number)).filter(
          (blocker) => blocker.state === "open",
        );

        if (blockers.length === 0) {
          return ready(base, Option.none());
        }

        if (blockers.length > 1) {
          return heldOn(blockers.map((blocker) => blocker.number));
        }

        const [blocker] = blockers;

        if (!auto.has(blocker.number)) {
          return heldOn([blocker.number]);
        }

        const pull = yield* pullOf(blocker.number);

        if (Option.isNone(pull)) {
          return heldOn([blocker.number]);
        }

        if ((yield* depthOf(pull.value)) + 1 > stackDepth) {
          return held(`waits for #${blocker.number}'s stack to merge`, [blocker.number]);
        }

        return ready(Claims.branchFor(blocker.number), Option.some(blocker.number));
      });

    const taskOf = (issue: LinkedIssue, state: Ready | Held): Task => ({
      number: issue.number,
      title: issue.title,
      kind: kindOf(issue.labels, labelNames),
      ...state,
    });

    const found: Array<Task> = [];

    for (const issue of work) {
      found.push(taskOf(issue, yield* stateOf(issue)));
    }

    const verifyState = (issue: LinkedIssue) => {
      const others = open.filter((other) => other.number !== issue.number);

      if (others.length === 0) {
        return taskOf(issue, ready(base, Option.none()));
      }

      return taskOf(issue, heldOn(others.map((other) => other.number)));
    };

    return {
      tasks: found,
      verify: Option.map(Option.fromUndefinedOr(verify), verifyState),
    } satisfies Tasks;
  });

// Claims the epic for this run with its claim ref (Claims.epic), or skips the
// run when another run holds it. Safe to repeat. A flow lets it go with
// `Claims.releasing(Claims.epic(epic))`.
export const claim = (epic: number) =>
  activity(
    "claim-epic",
    Effect.gen(function* () {
      const item = Claims.epic(epic);
      const claimed = yield* Claims.acquire(item);

      if (!claimed.acquired) {
        return yield* new Skip({
          reason: `#${epic} is already claimed (${Claims.describeHolder(item, claimed.holder)})`,
        });
      }
    }),
  );

// Whether the epic is still this run's, for a flow's stillValid: it is open,
// and no other run holds its claim. A run whose epic is gone ends as superseded.
export const stillValid = (item: WorkItem) => issueOf(item).pipe(Effect.flatMap(epicValidity));

// Where one of the epic's sub-issues stands, as the epic's status comment
// lists it: ready to start (on `base`, `stackedOn` a task), held with its
// reason, in review as `pullRequest`, a person's (with the reason), or done:
// merged, or closed without a merge.
export const Layer = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  state: Schema.Literals(["ready", "held", "in-review", "person", "merged", "closed"]),
  base: Schema.optionalKey(Schema.String),
  stackedOn: Schema.optionalKey(Schema.Finite),
  reason: Schema.optionalKey(Schema.String),
  pullRequest: Schema.optionalKey(Schema.Finite),
  // A held layer's: the sub-issues it waits on. None in a progress read before
  // layers kept it.
  waitsOn: Schema.optionalKey(Schema.Array(Schema.Finite)),
});

export type Layer = typeof Layer.Type;

// Every sub-issue of the epic as a layer, in GitHub's order, and the
// fingerprint of the epic it was read from.
export const Progress = Schema.Struct({
  layers: Schema.Array(Layer),
  fingerprint: Schema.String,
});

export type Progress = typeof Progress.Type;

// Whether every sub-issue of the epic is closed.
export const finished = (progress: Progress) =>
  progress.layers.every((layer) => layer.state === "merged" || layer.state === "closed");

// The layers the run may start now.
export const startable = (progress: Progress) =>
  progress.layers.filter((layer) => layer.state === "ready");

// A layer's state in a few words: `ready`, `stacked on #12`, `held: waits on
// #12, #13`, `in review: #31`, `merged`.
export const describeLayer = (layer: Layer) => {
  const on = Option.match(Option.fromUndefinedOr(layer.stackedOn), {
    onNone: () => "",
    onSome: (below) => `, stacked on #${below}`,
  });

  switch (layer.state) {
    case "ready":
      return Option.match(Option.fromUndefinedOr(layer.stackedOn), {
        onNone: () => "ready",
        onSome: (below) => `stacked on #${below}`,
      });
    case "held":
      return `held: ${layer.reason ?? ""}`;
    case "in-review":
      return `in review: #${layer.pullRequest ?? 0}${on}`;
    case "person":
      return `a person's: ${layer.reason ?? ""}`;
    default:
      return layer.state;
  }
};

// What a sub-issue the run doesn't implement waits on: answers to its
// questions, a person, or a person with an agent.
const personReason = (labels: ReadonlyArray<string>, names: Settings.LabelNames) => {
  if (labels.includes(names.needsClarification)) {
    return "waits for answers to its questions";
  }

  if (labels.includes(names.needsHuman)) {
    return "needs a person";
  }

  return "for a person with an agent (`chernabog start`)";
};

// The pull request from a task's work branch, open or not.
const pullFor = (task: number) =>
  GitHub.use((github) => github.pullRequestForBranch(Claims.branchFor(task)));

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

// A digest of what the epic's run waits on: each sub-issue's state and kind,
// and each layer's pull request: its state, head and reviews. A push, a
// review, a merge or a close changes it, as does a task closed or relabelled.
export const fingerprint = (epic: number) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const labelNames = yield* Settings.labels;
    const parts: Array<string> = [];

    for (const issue of yield* github.subIssues(epic)) {
      parts.push(`#${issue.number}:${issue.state}:${kindOf(issue.labels, labelNames)}`);

      for (const pull of Option.toArray(yield* pullFor(issue.number))) {
        const reviews = yield* github.reviews(pull.number);
        parts.push(`pr${pull.number}:${pull.state}:${pull.headSha}:${reviews.length}`);
      }
    }

    return digest(parts.join("\n"));
  });

// Where each of the epic's sub-issues stands, for this run: the tasks whose
// claim it holds are its own, in review once their pull request is open; an
// open task it hasn't started and that isn't an agent's is a person's; the
// rest are ready or held, as `tasks` says, stacking on the run's own too.
export const progressOf = (epic: number) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const labelNames = yield* Settings.labels;
    const run = yield* Run;
    const all = yield* github.subIssues(epic);
    const started: Array<number> = [];

    for (const issue of all.filter((sub) => sub.state === "open")) {
      if (
        Option.exists(
          yield* Claims.holder(Claims.issue(issue.number)),
          (holder) => holder.runId === run.runId,
        )
      ) {
        started.push(issue.number);
      }
    }

    const found = yield* tasks(epic, { started });

    const byNumber = new Map(
      [...found.tasks, ...Option.toArray(found.verify)].map((task) => [task.number, task]),
    );

    const byBranch = new Map(all.map((issue) => [Claims.branchFor(issue.number), issue.number]));

    // Where an open sub-issue without an open pull request stands.
    const waiting = (issue: LinkedIssue, head: Pick<Layer, "number" | "title">) =>
      Option.map(Option.fromUndefinedOr(byNumber.get(issue.number)), (task): Layer => {
        if (task.kind !== "auto" && !started.includes(issue.number)) {
          return { ...head, state: "person", reason: personReason(issue.labels, labelNames) };
        }

        if (task.state === "held") {
          return { ...head, state: "held", reason: task.reason, waitsOn: task.waitsOn };
        }

        return Option.match(task.stackedOn, {
          onNone: (): Layer => ({ ...head, state: "ready", base: task.base }),
          onSome: (below): Layer => ({
            ...head,
            state: "ready",
            base: task.base,
            stackedOn: below,
          }),
        });
      });

    // Where a sub-issue stands, from its pull request if it has one.
    const layerOf = (issue: LinkedIssue, pull: Option.Option<PullRequest>) => {
      const head = { number: issue.number, title: issue.title };

      if (issue.state === "closed") {
        return Option.some(
          Option.match(
            Option.filter(pull, (closed) => closed.state === "merged"),
            {
              onNone: (): Layer => ({ ...head, state: "closed" }),
              onSome: (merged): Layer => ({ ...head, state: "merged", pullRequest: merged.number }),
            },
          ),
        );
      }

      return Option.match(
        Option.filter(pull, (open) => open.state === "open"),
        {
          onNone: () => waiting(issue, head),
          onSome: (open) =>
            Option.some(
              Option.match(Option.fromUndefinedOr(byBranch.get(open.baseRef)), {
                onNone: (): Layer => ({ ...head, state: "in-review", pullRequest: open.number }),
                onSome: (below): Layer => ({
                  ...head,
                  state: "in-review",
                  pullRequest: open.number,
                  stackedOn: below,
                }),
              }),
            ),
        },
      );
    };

    const layers: Array<Layer> = [];

    for (const issue of all) {
      for (const layer of Option.toArray(layerOf(issue, yield* pullFor(issue.number)))) {
        layers.push(layer);
      }
    }

    return { layers, fingerprint: yield* fingerprint(epic) } satisfies Progress;
  });

// Reads where the epic stands, as the step `epic-tasks-<round>`, and writes
// each held task and its reason to the run log.
export const progress = (epic: number, round: number) =>
  activity(
    `epic-tasks-${round}`,
    Effect.gen(function* () {
      const log = yield* RunLog;
      const read = yield* progressOf(epic);

      for (const layer of read.layers.filter((each) => each.state === "held")) {
        yield* log.log(`#${layer.number} is held: ${layer.reason ?? ""}`);
      }

      return read;
    }),
    Progress,
  );

// The status comment's marker: the fingerprint of the epic it was written
// from, by which the run finds its comment. The trigger reads the epic's
// waiting record, not this (ADR 0021, decision 3).
export const StatusMarker = Schema.Struct({ fingerprint: Schema.String });

export type StatusMarker = typeof StatusMarker.Type;

const STATUS_PATTERN = /<!-- chernabog-epic-status (\{.*?\}) -->/;
const statusCodec = Schema.fromJsonString(StatusMarker);

export const statusMarker = {
  write: (value: StatusMarker) =>
    `<!-- chernabog-epic-status ${Schema.encodeSync(statusCodec)(value)} -->`,
  read: (body: string): Option.Option<StatusMarker> =>
    Option.fromNullishOr(body.match(STATUS_PATTERN)).pipe(
      Option.flatMap((match) => Schema.decodeOption(statusCodec)(match[1])),
    ),
};

// The epic's status comment: each sub-issue and where it stands.
export const statusComment = (read: Progress) =>
  [
    "**Chernabog's epic run.** Where each task stands:",
    "",
    ...read.layers.map((layer) => `- #${layer.number} ${layer.title}: ${describeLayer(layer)}`),
    "",
    statusMarker.write({ fingerprint: read.fingerprint }),
  ].join("\n");

// The persona's latest status comment on the epic, if it wrote one.
const latestStatus = (epic: number) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const login = yield* github.login;

    return Option.fromUndefinedOr(
      (yield* github.comments(epic)).findLast(
        (comment) => comment.author === login && Option.isSome(statusMarker.read(comment.body)),
      ),
    );
  });

// Writes where the epic stands into its one status comment, editing the one
// there or posting it the first time, as the step `epic-status-<round>`.
export const postStatus = (epic: number, round: number, read: Progress) =>
  activity(
    `epic-status-${round}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      const body = statusComment(read);

      yield* Option.match(yield* latestStatus(epic), {
        onNone: () => github.comment(epic, body),
        onSome: (found) =>
          github
            .request(
              "PATCH",
              `/repos/${repo.slug}/issues/comments/${found.id}`,
              Option.some({ body }),
            )
            .pipe(Effect.asVoid),
      });
    }),
  );

// The signal the trigger gives an epic whose layers changed since its run
// parked: a push, a review, a merge or a close.
export const LAYER_CHANGED = "layer-changed";

// How long a parked epic waits before a run looks at it again with no layer
// changed, for what changes no layer: a person's task closed, say.
export const LOOK_AGAIN_AFTER = "1 day";

const Pairs = Schema.Array(Schema.Tuple([Schema.Finite, Schema.Finite]));

// What a run keeps of the tasks it started, for the run that takes the epic
// up after it parks: each task's attempts so far, the tasks read as something
// other than ready since their attempt (handed back, so they may start
// again), and those whose attempt ended with a person.
// A task whose lane ended on its pull request's pending CI (audit W7): the
// lane can't park on its own, so it leaves the round, and the epic's run
// takes it up once CI settles (takeUpCi), from the round of CI it waits on,
// counting ciTimeout from `since`, when that round's wait began.
export const PendingCi = Schema.Struct({
  issue: Schema.Finite,
  pullRequest: Schema.Finite,
  lane: Schema.String,
  branch: Schema.String,
  base: Schema.optionalKey(Schema.String),
  round: Schema.Finite,
  since: Schema.String,
});

export type PendingCi = typeof PendingCi.Type;

export const TaskKeep = Schema.Struct({
  attempts: Pairs,
  handedBack: Schema.Array(Schema.Finite),
  withPerson: Schema.Array(Schema.Finite),
  // Tasks whose CI was pending when their lane ended. None in a record from
  // before lanes left on CI.
  ci: Schema.optionalKey(Schema.Array(PendingCi)),
});

export type TaskKeep = typeof TaskKeep.Type;

// What a run keeps of carrying layers up and landing them, by pull request:
// each layer's refresh attempt, the base head it last brought each up to,
// the layers whose refresh went to a person, the layer below each was last
// seen stacked on, and those brought up to date with that one's merge.
// A layer whose refresh (Stack.refreshLayer) left on its pull request's
// pending CI (audit W7): the run can't park on one layer, so the refresh
// ends there, the layers above it wait, and its review waits too, until a
// round takes it up once CI settles (takeUpRefreshes). It keeps the layer's
// task, its pull request, the base head it was brought up to, the layer below
// when it caught up with that one's merge (Stack.LayerRefresh's lower), and
// what the refresh left (Stack.RefreshLeft): the round of CI, the base, when
// that round's wait began, and what it says to a reviewer asked again.
export const PendingRefresh = Schema.Struct({
  layer: Schema.Finite,
  pullRequest: Schema.Finite,
  baseSha: Schema.String,
  lower: Schema.optionalKey(Schema.Finite),
  ...Stack.RefreshLeft.fields,
});

export type PendingRefresh = typeof PendingRefresh.Type;

export const LayerKeep = Schema.Struct({
  attempts: Pairs,
  recorded: Schema.Array(Schema.Tuple([Schema.Finite, Schema.String])),
  withPerson: Schema.Array(Schema.Finite),
  below: Pairs,
  caughtUp: Schema.Array(Schema.Finite),
  // Refreshes left on pending CI. None in a record from before refreshes left.
  ci: Schema.optionalKey(Schema.Array(PendingRefresh)),
});

export type LayerKeep = typeof LayerKeep.Type;

// The most bytes, as JSON, the refreshes left on pending CI take of the
// epic's 4 KB record: a refresh that would take them past it waits for its
// CI inside the run instead, so the rest of the record keeps its room: six
// layers at the least, each keeping SAID_SIZE characters of what it says,
// and nine with only the line that says what it merged.
export const REFRESH_CI_SIZE = 2048;

const encodeRefreshes = Schema.encodeSync(Schema.Array(PendingRefresh));

// Whether these refreshes left on pending CI fit their share of the record.
export const fitsRefreshCi = (pending: ReadonlyArray<PendingRefresh>) =>
  new TextEncoder().encode(printJson(encodeRefreshes(pending))).length <= REFRESH_CI_SIZE;

// Whether a refresh of this layer may leave on pending CI beside those
// already left: whether they fit, with the most it could keep of its own.
export const roomForRefresh = (
  pending: ReadonlyArray<PendingRefresh>,
  layer: Omit<PendingRefresh, "round" | "since" | "said">,
) =>
  fitsRefreshCi([
    ...pending,
    { ...layer, round: 99, since: "2026-01-01T00:00:00.000Z", said: "x".repeat(Stack.SAID_SIZE) },
  ]);

// What the epic's waiting record carries (ADR 0021, decision 4): the
// fingerprint of the epic as the parked run last read it, which the trigger
// compares, and what the run kept between rounds. `layers` is left out when
// keeping it would take the record past its 4 KB.
export const Waiting = Schema.Struct({
  fingerprint: Schema.String,
  tasks: TaskKeep,
  layers: Schema.optionalKey(LayerKeep),
});

export type Waiting = typeof Waiting.Type;

const encodeWaiting = Schema.encodeSync(Waiting);
const decodeWaiting = Schema.decodeUnknownOption(Waiting);

const NOTHING_KEPT: TaskKeep = { attempts: [], handedBack: [], withPerson: [] };

// `waiting` as record data, as much of it as a record takes: with only the
// refreshes the layers' upkeep left on pending CI, then with only what was
// left on pending CI, the tasks' and the refreshes', then without the
// layers' upkeep, then with neither, when it is too big. What was left on
// pending CI goes last: nothing but this record takes it up again.
export const waitingData = (waiting: Waiting) => {
  const { layers: _layers, ...tasksOnly } = waiting;
  const least: Waiting = { fingerprint: waiting.fingerprint, tasks: NOTHING_KEPT };

  const refreshesOnly: Waiting = {
    ...tasksOnly,
    layers: {
      attempts: [],
      recorded: [],
      withPerson: [],
      below: [],
      caughtUp: [],
      ci: waiting.layers?.ci ?? [],
    },
  };

  const pendingCiOnly: Waiting = {
    ...refreshesOnly,
    tasks: { ...NOTHING_KEPT, ci: waiting.tasks.ci ?? [] },
  };

  return encodeWaiting(
    Option.getOrElse(
      Arr.findFirst([waiting, refreshesOnly, pendingCiOnly, tasksOnly], (kept) =>
        isPhaseData(encodeWaiting(kept)),
      ),
      () => least,
    ),
  );
};

// Records that the run parks waiting for a layer to change, as the step
// `epic-waiting-<round>`, then parks until one does or `after` passes. A
// daemon's run or a CI job's ends at the park, and Epic.queued offers the
// epic to a new run from this record once a layer changes or `after` passes.
// Each park writes its round's record, even over one this run wrote: a
// signal may wake the run before the daemon ends it, and the run then parks
// again with a new fingerprint and what it kept since.
export const park = (
  epic: number,
  round: number,
  waiting: Waiting,
  after: Duration.Input = LOOK_AGAIN_AFTER,
) =>
  Effect.gen(function* () {
    yield* activity(
      `epic-waiting-${round}`,
      Phases.record(Claims.epic(epic), Phases.PHASES.epic.waiting, waitingData(waiting), {
        always: true,
      }),
    );

    return yield* awaitSignal([LAYER_CHANGED], { id: `epic-${round}`, timeout: after });
  });

// Records that every task of the epic is closed, as the step
// `epic-finished-<round>`: the round that read it so.
export const recordFinished = (epic: number, round: number) =>
  activity(`epic-finished-${round}`, Phases.record(Claims.epic(epic), Phases.PHASES.epic.finished));

const ResumedItem = Schema.Struct({ resumeEpic: Schema.Unknown });

// What a work item from queued carries of the run that parked on the epic;
// none for an epic no run parked on.
export const resuming = (item: WorkItem): Option.Option<Waiting> =>
  Option.flatMap(Schema.decodeUnknownOption(ResumedItem)(item.data), (data) =>
    decodeWaiting(data.resumeEpic),
  );

// The epic's waiting record, as a parked run wrote it, and when; none for an
// epic with any other record, or none.
const parkedOn = (all: ReadonlyMap<string, PhaseRecord>, epic: number) =>
  Option.flatMap(
    Option.filter(
      Phases.recordOf(all, Claims.epic(epic)),
      (record) => record.phase === Phases.PHASES.epic.waiting,
    ),
    (record) =>
      Option.map(Option.flatMap(record.data, decodeWaiting), (waiting) => ({
        waiting,
        since: record.at,
      })),
  );

// Why a parked epic waits on CI: the first of its tasks' pull requests, or
// of its layers' refreshes, whose CI is still pending with time left. None
// when one has settled or run past ciTimeout, for the run that takes the
// epic up to take it up, or when none waits.
const waitingOnCiOf = (waiting: Waiting) =>
  Effect.gen(function* () {
    const pending = [
      ...(waiting.tasks.ci ?? []).map((task) => ({ ...task })),
      ...(waiting.layers?.ci ?? []).map((refresh) => ({ ...refresh, issue: refresh.layer })),
    ];

    const reasons: Array<string> = [];

    for (const one of pending) {
      const why = yield* heldOnCi(one.pullRequest, Option.some({ since: one.since }));

      if (Option.isNone(why)) {
        return { settled: true, held: Option.none<string>() };
      }

      reasons.push(`#${one.issue}: ${why.value}`);
    }

    return { settled: false, held: Arr.head(reasons) };
  });

// Open epics (auto:epic), oldest first, as work items keyed by the epic's
// issue, each routed by its assignees. The epic's record, not its status
// comment, says whether a run parked on it (ADR 0021, decision 3): one parked
// (waiting) is offered only once a layer changed since, which carries
// LAYER_CHANGED and wakes a run still parked, once a task or a layer's
// refresh it left on pending CI has CI green or red, or past ciTimeout, or
// once `after` passed since it parked; the new run takes up what the parked
// one kept. One whose CI is all still pending is held, with why. Any other epic
// is offered while it has an open sub-issue.
export const queuedAfter = (after: Duration.Input) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const all = yield* Phases.records;
    const now = yield* DateTime.now;
    const items: Array<WorkItem> = [];

    for (const epic of yield* github.issuesLabelled(PLAN_LABELS.epic)) {
      if (epic.state === "closed") {
        continue;
      }

      const parked = parkedOn(all, epic.number);

      if (Option.isNone(parked)) {
        if ((yield* github.subIssues(epic.number)).some((task) => task.state === "open")) {
          items.push(yield* routed(epic, issueItem(epic)));
        }

        continue;
      }

      const { since, waiting } = parked.value;
      const changed = waiting.fingerprint !== (yield* fingerprint(epic.number));
      const tasksCi = yield* waitingOnCiOf(waiting);

      const due = DateTime.isLessThanOrEqualTo(
        DateTime.addDuration(since, Duration.fromInputUnsafe(after)),
        now,
      );

      const item: WorkItem = {
        ...issueItem(epic),
        data: { issue: epic.number, resumeEpic: encodeWaiting(waiting) },
      };

      if (!changed && !due && !tasksCi.settled) {
        // Held, with why, while a task's CI, or a refresh's, is still pending.
        for (const why of Option.toArray(tasksCi.held)) {
          items.push({ ...item, held: why });
        }

        continue;
      }

      // A layer changed: also a wake, for a run still parked on the epic.
      if (changed) {
        items.push(yield* routed(epic, { ...item, signals: [LAYER_CHANGED] }));
        continue;
      }

      items.push(yield* routed(epic, item));
    }

    return items;
  });

// queuedAfter, looking at a parked epic again after LOOK_AGAIN_AFTER.
export const queued = queuedAfter(LOOK_AGAIN_AFTER);

// Where a task's lane, in an epic document, leaves its pending CI for the
// lane's ending to carry (epic.recordEndings): set by the lane's scope, and
// read by a wait for CI in it, which then ends the lane (leaveLane). None
// outside an epic's lane.
export type LaneCiSlot = {
  // The lane's task.
  readonly issue: number;
  readonly left: Ref.Ref<Option.Option<PendingCi>>;
};

export const LaneCi = Context.Reference<Option.Option<LaneCiSlot>>("@chernabog/sdk/Epic/LaneCi", {
  defaultValue: () => Option.none(),
});

// What a task's lane records of its pull request's pending CI as it leaves
// the round, as the step `ci-left-<round>#<lane>`: when the round's wait
// began, so ciTimeout counts across the runs that take the epic up.
export const leftOnCi = (task: Omit<PendingCi, "since" | "round">, round: number) =>
  activity(
    `ci-left-${round}#${task.lane}`,
    Effect.map(DateTime.now, (now): PendingCi => ({
      ...task,
      round,
      since: DateTime.formatIso(now),
    })),
    PendingCi,
  ).pipe(Effect.orDie);

// Ends a task's lane in an epic document on its pull request's pending CI,
// which the lane's scope (LaneCi) hands to the next round. It ends as a lane
// skipped does, so the steps after it, its hand-off, don't run.
export const leaveLane = (pending: PendingCi) =>
  Effect.gen(function* () {
    for (const slot of Option.toArray(yield* LaneCi)) {
      yield* Ref.set(slot.left, Option.some(pending));
    }

    return yield* new Skip({
      reason: `#${pending.issue} waits on CI for #${pending.pullRequest}; the epic takes it up once it settles`,
    });
  });

const TaskCi = Schema.Struct({
  state: Schema.Literals(["pending", "settled", "timed-out", "gone"]),
  url: Schema.String,
});

// Where a task, or a layer's refresh, left on pending CI stands: its pull
// request closed or merged since (gone), its CI still pending with time
// left, past ciTimeout from when its round began (timed-out), or green or
// red (settled).
const taskCi = (task: { readonly pullRequest: number; readonly since: string }) =>
  Effect.gen(function* () {
    const pull = yield* GitHub.use((github) => github.pullRequest(task.pullRequest)).pipe(
      Effect.asSome,
      Effect.catchTag("NotFound", () => Effect.succeedNone),
    );

    const open = Option.filter(pull, (found) => found.state === "open");

    if (Option.isNone(open)) {
      return { state: "gone", url: "" } satisfies typeof TaskCi.Type;
    }

    const { url } = open.value;
    const reading = yield* Ci.pullRequestState(task.pullRequest);

    if (reading.state !== "pending") {
      return { state: "settled", url } satisfies typeof TaskCi.Type;
    }

    const { timeout } = yield* Settings.ci;
    const since = DateTime.make(task.since);
    const now = yield* DateTime.now;

    if (
      Option.exists(since, (began) =>
        DateTime.isLessThanOrEqualTo(DateTime.addDuration(began, timeout), now),
      )
    ) {
      return { state: "timed-out", url } satisfies typeof TaskCi.Type;
    }

    return { state: "pending", url } satisfies typeof TaskCi.Type;
  });

// How a task taken up ended: handed off, left on CI again (after a fix, or
// still pending), or with a person.
type TakenUp =
  | { readonly kind: "done" }
  | { readonly kind: "left"; readonly pending: PendingCi }
  | { readonly kind: "person"; readonly issue: number };

// Takes one task up from where its lane left it: in a worktree on its
// branch, waits on from its round of CI with ids of this round's
// (`<lane>-r<round>`), fixing red in its session, and hands the pull request
// off once CI is green, as the lane would have. A reading still pending
// after a fix leaves it again.
const takeUp = (task: PendingCi, url: string, round: number, late: boolean) =>
  Effect.gen(function* () {
    const id = `${task.lane}-r${round}`;

    const toPerson = (reason: string) =>
      Implement.handToHuman(task.issue, reason, Option.some(task.pullRequest), { id }).pipe(
        Effect.tap(() => activity(`release-claim#${id}`, Claims.release(Claims.issue(task.issue)))),
        Effect.as<TakenUp>({ kind: "person", issue: task.issue }),
      );

    if (late) {
      const { timeout } = yield* Settings.ci;

      return yield* toPerson(
        `CI on #${task.pullRequest} is still pending after ${Duration.format(timeout)}`,
      );
    }

    return yield* Effect.gen(function* () {
      const base = Option.match(Option.fromUndefinedOr(task.base), {
        onNone: () => ({}),
        onSome: (on) => ({ base: on }),
      });

      const worktree = yield* Implement.prepareWorktree(task.branch, { ...base, id });
      const session = yield* Implement.sessionFor({ id: task.lane });

      const left = yield* Implement.waitForCiLeaving(
        task.pullRequest,
        worktree,
        { ...session, branch: task.branch, ...base },
        { id, firstRound: task.round },
      );

      if (Option.isSome(left)) {
        return { kind: "left", pending: yield* leftOnCi(task, left.value) } satisfies TakenUp;
      }

      yield* Implement.handOff(
        task.issue,
        { number: task.pullRequest, url },
        Implement.resumedOutcome,
        { needsReview: true, id },
      );

      return { kind: "done" } satisfies TakenUp;
    }).pipe(
      Effect.catchTags({
        NeedsHuman: (needsHuman) => toPerson(needsHuman.reason),
        NothingCommitted: (nothing) => toPerson(`nothing to push on ${nothing.branch}`),
        PushRejected: (rejected) => toPerson(rejected.message),
        CiTimedOut: (timedOut) => toPerson(timedOut.message),
        // A pull request closed, or a task deleted, under the run: nothing to take up.
        PullRequestClosed: () => Effect.succeed<TakenUp>({ kind: "done" }),
        NotFound: () => Effect.succeed<TakenUp>({ kind: "done" }),
        StepFailed: (failed) => toPerson(`${failed.step}: ${failed.message}`),
      }),
    );
  });

const leftAgain = (one: TakenUp): ReadonlyArray<PendingCi> => {
  if (one.kind !== "left") {
    return [];
  }

  return [one.pending];
};

const wentToPerson = (one: TakenUp): ReadonlyArray<number> => {
  if (one.kind !== "person") {
    return [];
  }

  return [one.issue];
};

// What a round's take-up of the tasks left on pending CI leaves: whether it
// took any up (and so the round reads the epic again), the tasks still left
// on CI, and those that went to a person.
export type TasksCi = {
  readonly taken: boolean;
  readonly pending: ReadonlyArray<PendingCi>;
  readonly withPerson: ReadonlyArray<number>;
};

// Takes up, as a step of the round each (`task-ci-<round>#<lane>`), the tasks
// whose lanes left on pending CI whose CI has since settled or run past
// ciTimeout, `concurrency` at once; those still pending stay left, and one
// whose pull request closed is dropped. The recipe and the epic document
// (epic.settleCi) take them up alike.
export const takeUpCi = (round: number, pending: ReadonlyArray<PendingCi>, concurrency: number) =>
  Effect.gen(function* () {
    type Due = { readonly task: PendingCi; readonly url: string; readonly late: boolean };

    const still: Array<PendingCi> = [];
    const due: Array<Due> = [];

    for (const task of pending) {
      const read = yield* activity(
        `task-ci-${round}#${task.lane}`,
        taskCi(task).pipe(
          Effect.catchTag("GitHubError", (error) =>
            Effect.fail(new StepFailed({ step: `task-ci-${round}`, message: error.message })),
          ),
        ),
        TaskCi,
      );

      if (read.state === "pending") {
        still.push(task);
      }

      if (read.state === "settled" || read.state === "timed-out") {
        due.push({ task, url: read.url, late: read.state === "timed-out" });
      }
    }

    const ended = yield* Effect.forEach(due, (one) => takeUp(one.task, one.url, round, one.late), {
      concurrency: Math.max(1, concurrency),
    });

    return {
      taken: due.length > 0,
      pending: [...still, ...ended.flatMap(leftAgain)],
      withPerson: ended.flatMap(wentToPerson),
    } satisfies TasksCi;
  });

// How a refresh taken up ended: CI green and its review settled, left on CI
// again (after a fix), with a person, or its pull request gone.
type RefreshTaken =
  | { readonly kind: "done" }
  | { readonly kind: "left"; readonly pending: PendingRefresh }
  | { readonly kind: "person" }
  | { readonly kind: "gone" };

// Takes one refresh up from where it left its layer: in a worktree on the
// layer's branch, waits on from its round of CI with ids of this round's
// (`<pull request>-r<round>`), fixing red in the author's session, then asks
// the reviewer again unless the head only merged the base, as the refresh
// would have (Stack.finishRefresh). Past ciTimeout, or failing as a refresh
// does, it goes to a person, as a refresh would.
const takeUpRefresh = (left: PendingRefresh, round: number, late: boolean) =>
  Effect.gen(function* () {
    const id = `${left.pullRequest}-r${round}`;
    const branch = Claims.branchFor(left.layer);

    const toPerson = (reason: string) =>
      Stack.refreshToPerson(left.pullRequest, id, reason).pipe(
        Effect.as<RefreshTaken>({ kind: "person" }),
      );

    if (late) {
      const { timeout } = yield* Settings.ci;

      return yield* toPerson(
        `CI on #${left.pullRequest} is still pending after ${Duration.format(timeout)}`,
      );
    }

    return yield* Effect.gen(function* () {
      const worktree = yield* Implement.prepareWorktree(branch, {
        base: left.base,
        id: `refresh-${id}`,
      });

      const again = yield* Stack.finishRefresh(worktree, { ...left, branch }, { id });

      if (Option.isSome(again)) {
        return { kind: "left", pending: { ...left, ...again.value } } satisfies RefreshTaken;
      }

      return { kind: "done" } satisfies RefreshTaken;
    }).pipe(
      Effect.catchTags({
        NeedsHuman: (needsHuman) => toPerson(needsHuman.reason),
        NothingCommitted: (nothing) => toPerson(`nothing to push on ${nothing.branch}`),
        PushRejected: (rejected) => toPerson(rejected.message),
        CiTimedOut: (timedOut) => toPerson(timedOut.message),
        StepFailed: (failed) => toPerson(`${failed.step}: ${failed.message}`),
        // A layer closed or gone under the run: nothing to take up.
        PullRequestClosed: () => Effect.succeed<RefreshTaken>({ kind: "gone" }),
        NotFound: () => Effect.succeed<RefreshTaken>({ kind: "gone" }),
      }),
    );
  });

// What a round's take-up of the refreshes left on pending CI leaves: whether
// it took any up (and so the round reads the epic again), the refreshes still
// left, those whose CI went green and review settled (carried), and the pull
// requests of those that went to a person.
export type RefreshesCi = {
  readonly taken: boolean;
  readonly pending: ReadonlyArray<PendingRefresh>;
  readonly carried: ReadonlyArray<PendingRefresh>;
  readonly withPerson: ReadonlyArray<number>;
};

// Takes up, bottom to top as they were left, as a step of the round each
// (`refresh-ci-<round>#<pull request>`), the refreshes whose CI has since
// settled or run past ciTimeout; those still pending stay left, and one whose
// pull request closed is dropped. The recipe's stack upkeep and the epic
// document's (stack.carryUp) take them up alike, first in the round.
export const takeUpRefreshes = (round: number, pending: ReadonlyArray<PendingRefresh>) =>
  Effect.gen(function* () {
    const still: Array<PendingRefresh> = [];
    const carried: Array<PendingRefresh> = [];
    const withPerson: Array<number> = [];
    let taken = false;

    for (const left of pending) {
      const read = yield* activity(
        `refresh-ci-${round}#${left.pullRequest}`,
        taskCi(left).pipe(
          Effect.catchTag("GitHubError", (error) =>
            Effect.fail(new StepFailed({ step: `refresh-ci-${round}`, message: error.message })),
          ),
        ),
        TaskCi,
      );

      if (read.state === "pending") {
        still.push(left);
        continue;
      }

      if (read.state === "gone") {
        continue;
      }

      taken = true;
      const ended = yield* takeUpRefresh(left, round, read.state === "timed-out");

      switch (ended.kind) {
        case "left":
          still.push(ended.pending);
          break;
        case "done":
          carried.push(left);
          break;
        case "person":
          withPerson.push(left.pullRequest);
          break;
        default:
          break;
      }
    }

    return { taken, pending: still, carried, withPerson } satisfies RefreshesCi;
  });

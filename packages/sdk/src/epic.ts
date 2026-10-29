// The building blocks of the `epic` recipe: from an epic's sub-issues and the
// issues that block each, which open tasks may start, on the base branch or
// stacked on the work branch of the one task that blocks them, and why the
// rest wait. A closed blocker counts as done: the epic run closes a task only
// once its work reaches the base branch.

import { createHash } from "node:crypto";

import {
  activity,
  Claims,
  GitHub,
  type LinkedIssue,
  planNodeMarker,
  type PullRequest,
  Repo,
  Run,
  RunLog,
  Skip,
  type WorkItem,
} from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { issueItem, issueOf } from "./implement.ts";
import { type Kind, VERIFY } from "./plan.ts";
import { LABELS as PLAN_LABELS } from "./plan-labels.ts";
import * as Settings from "./settings.ts";
import { epicValidity } from "./still-valid.ts";

export type { Kind } from "./plan.ts";

// A task that may start now, on `base`: the repo's base branch, or the work
// branch of the task it stacks on.
export type Ready = {
  readonly state: "ready";
  readonly base: string;
  readonly stackedOn: Option.Option<number>;
};

// A task that waits, and why, as a WorkItem's `held` says it.
export type Held = { readonly state: "held"; readonly reason: string };

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

const held = (reason: string): Held => ({ state: "held", reason });

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
    const repo = yield* Repo;
    const labelNames = yield* Settings.labels;
    const stackDepth = yield* Settings.stackDepth;
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
          return ready(repo.baseBranch, Option.none());
        }

        if (blockers.length > 1) {
          return held(waitsOn(blockers.map((blocker) => blocker.number)));
        }

        const [blocker] = blockers;

        if (!auto.has(blocker.number)) {
          return held(waitsOn([blocker.number]));
        }

        const pull = yield* pullOf(blocker.number);

        if (Option.isNone(pull)) {
          return held(waitsOn([blocker.number]));
        }

        if ((yield* depthOf(pull.value)) + 1 > stackDepth) {
          return held(`waits for #${blocker.number}'s stack to merge`);
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
        return taskOf(issue, ready(repo.baseBranch, Option.none()));
      }

      return taskOf(issue, held(waitsOn(others.map((other) => other.number))));
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
          return { ...head, state: "held", reason: task.reason };
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
// from, so the trigger can tell when a layer has changed since.
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
// last wrote its status: a push, a review, a merge or a close.
export const LAYER_CHANGED = "layer-changed";

// Open epics (auto:epic) with an open sub-issue, oldest first, as work items
// keyed by the epic's issue; each whose fingerprint differs from its status
// comment's carries LAYER_CHANGED, which wakes its parked run. An epic whose
// last task closed since is reported only to wake its run, to end it.
export const queued = Effect.gen(function* () {
  const github = yield* GitHub;
  const items: Array<WorkItem> = [];

  for (const epic of yield* github.issuesLabelled(PLAN_LABELS.epic)) {
    if (epic.state === "closed") {
      continue;
    }

    const open = (yield* github.subIssues(epic.number)).some((task) => task.state === "open");

    const recorded = Option.flatMap(yield* latestStatus(epic.number), (found) =>
      statusMarker.read(found.body),
    );

    const changed =
      Option.isSome(recorded) && recorded.value.fingerprint !== (yield* fingerprint(epic.number));

    const item = issueItem(epic);

    if (changed && open) {
      items.push({ ...item, signals: [LAYER_CHANGED] });
    } else if (changed) {
      items.push({ ...item, signals: [LAYER_CHANGED], wakeOnly: true });
    } else if (open) {
      items.push(item);
    }
  }

  return items;
});

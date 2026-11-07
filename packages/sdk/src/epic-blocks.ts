// The epic's blocks: working through a stack of tasks round after round. What
// the recipe keeps in maps between rounds goes through its document as state,
// each block taking the state it reads and giving back the state it leaves.

import {
  activity,
  awaitSignal,
  Claims,
  Git,
  GitHub,
  Lanes,
  NeedsHuman,
  Repo,
  reportAs,
  Run,
  Skip,
  type WorkItem,
  Worktree,
} from "@chernabog/core";
import * as Brand from "effect/Brand";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  BaseBranch,
  type BranchName,
  type Committed,
  defineBlock,
  defineSource,
  type FailureContext,
  type IssueNumber,
  IssueNumber as IssueNumberOf,
  LaneId,
  pullRequestRef,
  ToPerson,
  type WorktreePath,
} from "./block.ts";
import * as Epic from "./epic.ts";
import * as Implement from "./implement.ts";
import * as Plan from "./plan.ts";
import * as PullRequest from "./pull-request.ts";
import * as Routing from "./routing.ts";
import * as Settings from "./settings.ts";
import * as Stack from "./stack.ts";

export type EpicNumber = number & Brand.Brand<"EpicNumber">;

const EpicNumber = Brand.nominal<EpicNumber>();

// Tasks implemented at once, unless the flow's atOnce setting says otherwise.
const AT_ONCE = 2;

// What config.yaml may set for this flow alone, under flows.<name>.settings.
const Own = Schema.Struct({
  atOnce: Schema.optionalKey(
    Schema.Int.annotate({
      description: `How many of the epic's ready tasks the run implements at once. Default: ${AT_ONCE}.`,
    }),
  ),
  ship: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Whether the epic's layers are on the automated path: each pull request the run opens is labelled auto:ship, and the run merges each approved layer once the layers below it have merged.",
    }),
  ),
});

// The id a task's steps carry on an attempt: `task-12` the first time,
// `task-12-2` once a person has handed it back.
const attemptId = (issue: number, attempt: number) => {
  if (attempt === 1) {
    return `task-${issue}`;
  }

  return `task-${issue}-${attempt}`;
};

// How the run's pull requests are queued: by auto:ship when its layers ship,
// which labels each pull request auto:ship too, the automated path.
const queuedAs = (ships: boolean) =>
  Effect.gen(function* () {
    if (!ships) {
      return {};
    }

    return { label: (yield* Settings.labels).ship };
  });

// Lets the task's claim go once its attempt ends with a person, as a step of
// the attempt's own, so a later attempt lets it go again.
const releaseTask = (issue: number, id: string) =>
  activity(`release-claim#${id}`, Claims.release(Claims.issue(issue)));

// Where a stacked task's pull request goes once its work is done, as the step
// `task-base#<id>`: its base, or, when the layer below merged while the task
// was implemented (and its branch was deleted with it), the branch that one
// merged into, and as far down as the layers below it merged too (#249). The
// work is brought up to date with the new base as a stack's layer is
// (Stack.updateFromBase): a squash or rebase of the layer below is recorded as
// already here, so its review shows only the task's change, and its edits of
// lines that layer added are no conflict. A merge that conflicts is undone and
// left to resolve-conflicts, as any conflict with its base is. `step` is
// `task-base#<id>`, or `task-base-2#<id>` when GitHub refused that base.
const TaskBase = Schema.Struct({ base: Schema.String });

const settleBase = (step: string, claimed: Option.Option<string>, worktree: string) =>
  activity(
    step,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const integration = yield* Settings.base;
      const base = Option.getOrElse(claimed, () => integration);
      let target = base;
      // The merged pull request whose base is `target`.
      let lower = Option.none<number>();

      while (target !== integration) {
        const below = Option.filter(
          yield* github.pullRequestForBranch(target),
          (pull) => pull.state === "merged",
        );

        if (Option.isNone(below)) {
          break;
        }

        target = below.value.baseRef;
        lower = Option.some(below.value.number);
      }

      if (Option.isNone(lower)) {
        return { base };
      }

      const updated = yield* Stack.updateFromBase(worktree, { lower: lower.value });

      if (!updated.clean) {
        const git = yield* Git;
        yield* git.run(["merge", "--abort"], worktree).pipe(Effect.ignore);
      }

      return { base: updated.base };
    }),
    TaskBase,
  );

// Whether the branch a task's pull request was refused on is gone, as the
// step `task-base-gone#<id>`: the layer below merged, and GitHub deleted its
// branch, between settleBase and the pull request (#320).
const baseGone = (id: string, base: string) =>
  activity(
    `task-base-gone#${id}`,
    Effect.gen(function* () {
      const github = yield* GitHub;

      return Option.isNone(yield* github.branchSha(base));
    }),
    Schema.Boolean,
  );

// What the run reads of a stacked layer before it carries the layers below up
// to it, as the step `stack-base-<round>#<pull request>`: the branch it is
// built on and that branch's head, none once it is gone, and whether a person
// has the layer. The saved head is the layer's recorded base, so a replay
// compares as the run first did.
const StackBase = Schema.Struct({
  base: Schema.String,
  baseSha: Schema.Option(Schema.String),
  withPerson: Schema.Boolean,
});

const readBase = (round: number, pullRequest: number) =>
  activity(
    `stack-base-${round}#${pullRequest}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const labelNames = yield* Settings.labels;
      const pull = yield* github.pullRequest(pullRequest);

      return {
        base: pull.baseRef,
        baseSha: yield* github.branchSha(pull.baseRef),
        withPerson: pull.labels.includes(labelNames.needsHuman),
      };
    }).pipe(
      // A pull request gone under the run leaves nothing to bring up to date.
      Effect.catchTag("NotFound", () =>
        Effect.succeed({ base: "", baseSha: Option.none<string>(), withPerson: false }),
      ),
    ),
    StackBase,
  );

// The run's worktree on the layer's branch, brought up to its remote, as the
// step `prepare-worktree#refresh-<key>`. After a hand-back it is reset to the
// remote: the refresh that went to a person may have left a merge unfinished
// there, and the person may have pushed the layer on.
const refreshWorktree = (branch: string, key: string, attempt: number) =>
  activity(
    `prepare-worktree#refresh-${key}`,
    Effect.gen(function* () {
      const run = yield* Run;
      const git = yield* Git;
      const path = yield* (yield* Worktree).ensure(branch, { runId: run.runId });

      if (attempt > 1) {
        yield* git.run(["fetch", "--quiet", "origin", branch], path);
        yield* git.run(["reset", "--quiet", "--hard", `origin/${branch}`], path);
        yield* git.run(["clean", "-fdq"], path);
      } else {
        yield* git.pull(path, branch);
      }

      return path;
    }),
    Schema.String,
  );

// Hands a layer whose refresh needs a person to one: labelled auto:needs-human,
// with the reason. Keyed by the refresh, so a later one goes to a person too.
const refreshToPerson = (pullRequest: number, key: string, reason: string) =>
  activity(
    `needs-human#refresh-${key}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const labelNames = yield* Settings.labels;
      yield* github.addLabel(pullRequest, labelNames.needsHuman);
      yield* github.comment(
        pullRequest,
        `Chernabog stopped bringing this layer up to date with its base and needs a person: ${reason}`,
      );
    }),
  ).pipe(Effect.as(`#${pullRequest}: ${reason}`));

// What one refresh did: whether the layer was carried, whether it pushed,
// and whether it went to a person.
type Carried = { readonly carried: boolean; readonly pushed: boolean; readonly toPerson: boolean };

// Brings one layer up to date with its base at `baseSha` (Stack.refreshLayer):
// merges it in, adjusts the layer when the base changed what it builds on,
// pushes and waits for CI. `lower`, once the layer below has merged, is its
// pull request, so a squash of it is reconciled rather than merged again. One that needs a person is handed to one, and
// reads as not carried, so the layers above it wait. Every step is keyed by
// the pull request, the base's sha and, after a hand-back, the attempt, so the
// refresh after one runs again rather than replaying the outcome it saved.
const refresh = (
  layer: Epic.Layer,
  pullRequest: number,
  base: string,
  baseSha: string,
  attempt: number,
  lower: Option.Option<number> = Option.none(),
) => {
  const again = Option.match(
    Option.filter(Option.some(attempt), (count) => count > 1),
    { onNone: () => "", onSome: (count) => `-${count}` },
  );

  const key = `${pullRequest}-${baseSha.slice(0, 12)}${again}`;

  const toPerson = (reason: string) =>
    refreshToPerson(pullRequest, key, reason).pipe(
      Effect.as<Carried>({ carried: false, pushed: false, toPerson: true }),
    );

  return Effect.gen(function* () {
    const branch = Claims.branchFor(layer.number);
    const worktree = yield* refreshWorktree(branch, key, attempt);

    const refreshed = yield* Stack.refreshLayer(worktree, {
      pullRequest,
      branch,
      base,
      baseSha,
      attempt,
      ...Option.match(lower, { onNone: () => ({}), onSome: (below) => ({ lower: below }) }),
    });

    return { carried: true, pushed: !refreshed.upToDate, toPerson: false } satisfies Carried;
  }).pipe(
    Effect.catchTags({
      NeedsHuman: (needsHuman) => toPerson(needsHuman.reason),
      StepFailed: (failed) => toPerson(`${failed.step}: ${failed.message}`),
      NothingCommitted: (nothing) => toPerson(`nothing to push on ${nothing.branch}`),
      PushRejected: (rejected) => toPerson(rejected.message),
      CiTimedOut: (timedOut) => toPerson(timedOut.message),
      // A layer closed or gone under the run has nothing above it to carry.
      PullRequestClosed: () =>
        Effect.succeed<Carried>({ carried: false, pushed: false, toPerson: false }),
      NotFound: () => Effect.succeed<Carried>({ carried: false, pushed: false, toPerson: false }),
    }),
  );
};

// The epic's layers in review on the branch of another in review, bottom to
// top: each after the one it is stacked on.
const stackedLayers = (progress: Epic.Progress) => {
  const inReview = new Map(
    progress.layers
      .filter(
        (layer) =>
          layer.state === "in-review" && Option.isSome(Option.fromUndefinedOr(layer.pullRequest)),
      )
      .map((layer) => [layer.number, layer]),
  );

  const depthOf = (layer: Epic.Layer) => {
    let depth = 0;
    let below = Option.fromUndefinedOr(layer.stackedOn);

    while (Option.isSome(below) && inReview.has(below.value) && depth < inReview.size) {
      depth += 1;
      below = Option.fromUndefinedOr(inReview.get(below.value)?.stackedOn);
    }

    return depth;
  };

  return [...inReview.values()]
    .filter((layer) => depthOf(layer) > 0)
    .toSorted((left, right) => depthOf(left) - depthOf(right));
};

// What the run keeps between rounds about carrying layers up and landing
// them, by pull request: the base head it last brought each layer up to, its
// refresh attempt, the layers whose refresh it handed to a person, the layer
// below each was last seen stacked on, and the layers it has brought up to
// date with that one's merge. Rebuilt from the rounds' saved results
// whenever the run resumes.
export type Upkeep = {
  readonly attempts: Map<number, number>;
  readonly recorded: Map<number, string>;
  readonly withPerson: Set<number>;
  readonly below: Map<number, number>;
  readonly caughtUp: Set<number>;
};

const copyOf = (upkeep: Upkeep): Upkeep => ({
  attempts: new Map(upkeep.attempts),
  recorded: new Map(upkeep.recorded),
  withPerson: new Set(upkeep.withPerson),
  below: new Map(upkeep.below),
  caughtUp: new Set(upkeep.caughtUp),
});

// Carries each layer's change up its stack, bottom to top: a layer whose base
// branch's head is not the one it was last brought up to is refreshed, then
// the one above it reads its own base, now moved too. A layer a person has,
// or whose refresh went to one, waits, and so do the layers above it; the
// rest of the epic carries on. A layer the run handed to a person and that
// no longer carries auto:needs-human is handed back: its next refresh is a
// new attempt. Whether anything was pushed.
const carryUp = (round: number, progress: Epic.Progress, kept: Upkeep) =>
  Effect.gen(function* () {
    const upkeep = copyOf(kept);
    const { attempts, recorded, withPerson } = upkeep;
    const waiting = new Set<number>();
    let pushed = false;

    for (const layer of stackedLayers(progress)) {
      const pullRequest = layer.pullRequest ?? 0;

      if (Option.exists(Option.fromUndefinedOr(layer.stackedOn), (below) => waiting.has(below))) {
        waiting.add(layer.number);
        continue;
      }

      const read = yield* readBase(round, pullRequest);

      if (read.withPerson || Option.isNone(read.baseSha)) {
        waiting.add(layer.number);
        continue;
      }

      if (withPerson.delete(pullRequest)) {
        attempts.set(pullRequest, (attempts.get(pullRequest) ?? 1) + 1);
      }

      const baseSha = read.baseSha.value;

      if (recorded.get(pullRequest) === baseSha) {
        continue;
      }

      const attempt = attempts.get(pullRequest) ?? 1;
      const refreshed = yield* refresh(layer, pullRequest, read.base, baseSha, attempt);

      if (refreshed.toPerson) {
        withPerson.add(pullRequest);
      }

      if (!refreshed.carried) {
        waiting.add(layer.number);
        continue;
      }

      recorded.set(pullRequest, baseSha);
      pushed = pushed || refreshed.pushed;
    }

    return { moved: pushed, stack: upkeep };
  });

// What the run reads of a layer before it lands it, as the step
// `land-read-<round>#<pull request>`: the branch it is on, whether it ships,
// whether a person has it, and where it lands: the branch the layer below
// merged into once that one has, the flow's integration base otherwise, and
// that branch's head.
const Landing = Schema.Struct({
  base: Schema.String,
  ships: Schema.Boolean,
  withPerson: Schema.Boolean,
  target: Schema.String,
  targetSha: Schema.Option(Schema.String),
});

const readLanding = (round: number, pullRequest: number, lower: Option.Option<number>) =>
  activity(
    `land-read-${round}#${pullRequest}`,
    Effect.gen(function* () {
      const github = yield* GitHub;
      const labelNames = yield* Settings.labels;
      const pull = yield* github.pullRequest(pullRequest);

      const target = yield* Option.match(lower, {
        onNone: () => Settings.base,
        onSome: (below) => Effect.map(github.pullRequest(below), (merged) => merged.baseRef),
      });

      return {
        base: pull.baseRef,
        ships: PullRequest.ships(pull, labelNames),
        withPerson: pull.labels.includes(labelNames.needsHuman),
        target,
        targetSha: yield* github.branchSha(target),
      };
    }).pipe(
      // A pull request gone under the run leaves nothing to land.
      Effect.catchTag("NotFound", () =>
        Effect.succeed({
          base: "",
          ships: false,
          withPerson: false,
          target: "",
          targetSha: Option.none<string>(),
        }),
      ),
    ),
    Landing,
  );

// Moves the layer onto `target`, the branch the layer below merged into, as
// GitHub does by itself when the merged branch is deleted.
const retarget = (round: number, pullRequest: number, target: string) =>
  activity(
    `retarget-${round}#${pullRequest}`,
    Effect.gen(function* () {
      const repo = yield* Repo;

      yield* (yield* GitHub).request(
        "PATCH",
        `/repos/${repo.slug}/pulls/${pullRequest}`,
        Option.some({ base: target }),
      );
    }),
  );

// The pull request of the layer below a layer that has merged, if the layer
// was stacked on one: the one it is stacked on now, or, once GitHub moved it
// onto the base, the one the run last saw it stacked on.
const mergedBelow = (layer: Epic.Layer, progress: Epic.Progress, upkeep: Upkeep) => {
  const pullRequest = layer.pullRequest ?? 0;

  const lower = Option.orElse(
    Option.flatMap(Option.fromUndefinedOr(layer.stackedOn), (below) =>
      Option.fromUndefinedOr(progress.layers.find((other) => other.number === below)?.pullRequest),
    ),
    () => Option.fromUndefinedOr(upkeep.below.get(pullRequest)),
  );

  return Option.filter(lower, (below) =>
    progress.layers.some((other) => other.pullRequest === below && other.state === "merged"),
  );
};

// Whether the layer is still stacked on a layer that has not merged, and so
// waits; the run remembers which one, for after GitHub moves it onto the base.
const stillStacked = (layer: Epic.Layer, progress: Epic.Progress, upkeep: Upkeep) => {
  const on = Option.flatMap(Option.fromUndefinedOr(layer.stackedOn), (number) =>
    Option.fromUndefinedOr(progress.layers.find((other) => other.number === number)),
  );

  if (!Option.exists(on, (lower) => lower.state !== "merged")) {
    return false;
  }

  const lower = Option.flatMap(on, (found) => Option.fromUndefinedOr(found.pullRequest));

  for (const [pullRequest, below] of Option.toArray(
    Option.all([Option.fromUndefinedOr(layer.pullRequest), lower]),
  )) {
    upkeep.below.set(pullRequest, below);
  }

  return true;
};

// Brings a layer whose layer below merged up to date with the branch that one
// merged into, first moving it there unless GitHub already has. Whether the
// layer may merge in this round: it was already up to date, and not moved.
const catchUp = (
  round: number,
  layer: Epic.Layer,
  pullRequest: number,
  read: typeof Landing.Type,
  lower: number,
  upkeep: Upkeep,
) =>
  Effect.gen(function* () {
    const moved = read.base !== read.target;

    if (moved) {
      yield* retarget(round, pullRequest, read.target);
    }

    const refreshed = yield* refresh(
      layer,
      pullRequest,
      read.target,
      Option.getOrElse(read.targetSha, () => ""),
      upkeep.attempts.get(pullRequest) ?? 1,
      Option.some(lower),
    );

    if (refreshed.toPerson) {
      upkeep.withPerson.add(pullRequest);
    }

    if (refreshed.carried) {
      upkeep.caughtUp.add(pullRequest);
    }

    return {
      moved: moved || refreshed.pushed,
      mayMerge: refreshed.carried && !moved && !refreshed.pushed,
    };
  });

// Merges the layer when PullRequest.merge finds that safe, as a step of this
// round; a refusal leaves it for a later round. Whether it merged.
const tryMerge = (round: number, pullRequest: number) =>
  PullRequest.merge(pullRequest, { method: "squash", id: `land-${round}` }).pipe(
    Effect.as(true),
    Effect.catchTags({
      MergeRefused: () => Effect.succeed(false),
      PullRequestClosed: () => Effect.succeed(false),
      NotFound: () => Effect.succeed(false),
    }),
  );

// Lands one layer in review, if it ships and may: brought up to date once its
// layer below merged, and merged once it is on the base. Whether it moved.
const landLayer = (
  round: number,
  layer: Epic.Layer,
  pullRequest: number,
  progress: Epic.Progress,
  upkeep: Upkeep,
) =>
  Effect.gen(function* () {
    if (stillStacked(layer, progress, upkeep)) {
      return false;
    }

    const pending = Option.filter(
      mergedBelow(layer, progress, upkeep),
      () => !upkeep.caughtUp.has(pullRequest),
    );

    const read = yield* readLanding(round, pullRequest, pending);

    if (!read.ships || read.withPerson || Option.isNone(read.targetSha)) {
      return false;
    }

    // A layer whose refresh went to a person, and that a person handed back.
    if (upkeep.withPerson.delete(pullRequest)) {
      upkeep.attempts.set(pullRequest, (upkeep.attempts.get(pullRequest) ?? 1) + 1);
    }

    if (Option.isSome(pending)) {
      const caught = yield* catchUp(round, layer, pullRequest, read, pending.value, upkeep);

      if (!caught.mayMerge) {
        return caught.moved;
      }
    } else if (read.base !== read.target) {
      return false;
    }

    return yield* tryMerge(round, pullRequest);
  });

// Lands the epic's layers on the automated path, each once the layers below
// it have merged. A layer whose layer below merged is moved onto the branch
// that one merged into, unless GitHub already moved it, and brought up to
// date with it, the squash reconciled; a layer on the base is merged when
// PullRequest.merge finds that safe, as it does once its approval stands and
// its checks are green. A layer still stacked on an open one waits, and so
// does one a person has. A refused merge is tried again in a later round, or
// merged by the review flows on their approval. Whether anything moved.
const land = (round: number, progress: Epic.Progress, kept: Upkeep) =>
  Effect.gen(function* () {
    const upkeep = copyOf(kept);
    let moved = false;

    for (const layer of progress.layers.filter((one) => one.state === "in-review")) {
      for (const pullRequest of Option.toArray(Option.fromUndefinedOr(layer.pullRequest))) {
        const landed = yield* landLayer(round, layer, pullRequest, progress, upkeep);
        moved = moved || landed;
      }
    }

    return { moved, stack: upkeep };
  });

// What the run keeps between rounds about its tasks: each one's attempts,
// those a person handed back, those whose attempt ended with a person, and the
// sub-issues each waited on, as the rounds read them.
export type TaskState = {
  readonly attempts: ReadonlyMap<number, number>;
  readonly handedBack: ReadonlySet<number>;
  readonly withPerson: ReadonlySet<number>;
  readonly waitedOn: ReadonlyMap<number, ReadonlySet<number>>;
};

// How a task's attempt ended, for the next round to read.
export type LaneEnding = { readonly issue: number; readonly withPerson: boolean };

// A task to start: its lane carries its attempt.
export type TaskStart = {
  readonly issue: IssueNumber;
  readonly base: Option.Option<BaseBranch>;
  readonly lane: LaneId;
};

// The tasks' state as a round leaves it once it has started some, which can't
// go on to the next round: epic.recordEndings says how each lane ended first.
export type TasksStarted = { readonly started: TaskState };

// What a loop starts with, by the name a document uses it by.
export const loopStates = {
  "epic.tasks": (): TaskState => ({
    attempts: new Map(),
    handedBack: new Set(),
    withPerson: new Set(),
    waitedOn: new Map(),
  }),
  "stack.upkeep": (): Upkeep => ({
    attempts: new Map(),
    recorded: new Map(),
    withPerson: new Set(),
    below: new Map(),
    caughtUp: new Set(),
  }),
};

// The lanes of a task's attempts in this run so far, by the ids its steps
// carry (`task-12`, `task-12-2`): none for one it never started, as a person's.
const lanesOf = (task: number, attempts: ReadonlyMap<number, number>) =>
  Array.from({ length: attempts.get(task) ?? 0 }, (_, index) => attemptId(task, index + 1));

// The ones to start now, by what the round read. A task the run attempted
// starts again only once it has read as something other than ready since, as
// one a person handed back with auto:eligible after its questions or a
// hand-off has; one still ready after its attempt, as one another run holds,
// waits. An attempt that ended with a person counts as read so: a round runs
// only once every task started with it ends, so a person may hand the task
// back before any round reads it with them (#249).
const planStarts = (progress: Epic.Progress, tasks: TaskState) => {
  const attempts = new Map(tasks.attempts);
  const handedBack = new Set(tasks.handedBack);
  const withPerson = new Set(tasks.withPerson);

  for (const layer of progress.layers) {
    if (attempts.has(layer.number) && (layer.state !== "ready" || withPerson.has(layer.number))) {
      handedBack.add(layer.number);
      withPerson.delete(layer.number);
    }
  }

  const ready = Epic.startable(progress).filter(
    (task) => !attempts.has(task.number) || handedBack.has(task.number),
  );

  const starts = ready.map((task) => {
    const attempt = (attempts.get(task.number) ?? 0) + 1;
    attempts.set(task.number, attempt);
    handedBack.delete(task.number);

    return {
      issue: IssueNumberOf(task.number),
      base: Option.map(Option.fromUndefinedOr(task.base), BaseBranch),
      lane: LaneId(attemptId(task.number, attempt)),
      attempt,
    };
  });

  return { attempts, handedBack, withPerson, waitedOn: tasks.waitedOn, starts };
};

// Publishes a task's work: its branch pushed, its pull request opened on the
// base it settled. The layer below can merge, and its branch go, after its
// base is settled and before the pull request opens: GitHub then refuses the
// base. The base is settled again, on what that layer merged into, and the
// pull request opened there, once (#320).
const publish = (input: {
  readonly issue: IssueNumber;
  readonly epic: EpicNumber;
  readonly worktree: WorktreePath;
  readonly branch: BranchName;
  readonly base: Option.Option<BaseBranch>;
  readonly outcome: Implement.ImplementOutcome;
  readonly ship: boolean;
  readonly lane: LaneId;
}) =>
  Effect.gen(function* () {
    const { branch, epic, issue, lane: id, outcome, worktree } = input;
    const queued = yield* queuedAs(input.ship);

    const pushAndOpen = (step: string, onBase: string, openId: string) =>
      Effect.gen(function* () {
        yield* Implement.push(`${step}#${id}`, worktree, branch, { base: onBase });

        const opened = yield* Implement.openPullRequest(issue, outcome, {
          base: onBase,
          id: openId,
          partOf: epic,
          ...queued,
        });

        return { pr: pullRequestRef(opened), base: Option.some(BaseBranch(onBase)) };
      });

    const settled = yield* settleBase(`task-base#${id}`, input.base, worktree);

    return yield* pushAndOpen("push", settled.base, id).pipe(
      Effect.catchTag("StepFailed", (refused) =>
        Effect.gen(function* () {
          if (refused.step !== `open-pull-request#${id}` || !(yield* baseGone(id, settled.base))) {
            return yield* refused;
          }

          const again = yield* settleBase(`task-base-2#${id}`, Option.some(settled.base), worktree);

          if (again.base === settled.base) {
            return yield* refused;
          }

          // openPullRequest names its step `open-pull-request#<id>`
          // alone, so the retry's id carries the round.
          return yield* pushAndOpen("push-2", again.base, `${id}-base-2`);
        }),
      ),
    );
  });

export const epicBlocks = {
  "epic.claim": defineBlock({
    name: "epic.claim",
    about: "Claims the epic, so only this run works through it.",
    inputKinds: { epic: "EpicNumber" },
    outputKinds: "nothing",
    outcomeKinds: {},
    inputs: { epic: "required" },
    run: (input: { readonly epic: EpicNumber }) => Epic.claim(input.epic),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {},
    mustRoute: [],
    contributes: { settings: Settings.Base.fields },
  }),

  // Whether this run's layers ship, read once, so a replay decides the same.
  "epic.ships": defineBlock({
    name: "epic.ships",
    about: "Reads the ship setting once: whether the epic's layers are on the automated path.",
    inputKinds: {},
    outputKinds: { value: "boolean, for `if` or stack.publish" },
    outcomeKinds: {},
    inputs: {},
    run: (_: Record<never, never>) =>
      activity(
        "ships",
        Effect.map(Settings.read(Own), (own) => own.ship === true),
        Schema.Boolean,
      ).pipe(Effect.map((value) => ({ value }))),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {},
    mustRoute: [],
    contributes: { settings: Own.fields },
  }),

  // How many tasks the run implements at once, at least one, read once.
  "epic.atOnce": defineBlock({
    name: "epic.atOnce",
    about: "Reads the atOnce setting once: how many tasks run at once, at least one.",
    inputKinds: {},
    outputKinds: { value: "number, for forEach atOnce" },
    outcomeKinds: {},
    inputs: {},
    run: (_: Record<never, never>) =>
      activity(
        "at-once",
        Effect.map(Settings.read(Own), (own) => Math.max(1, own.atOnce ?? AT_ONCE)),
        Schema.Int,
      ).pipe(Effect.map((value) => ({ value }))),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {},
    mustRoute: [],
    contributes: { settings: Own.fields },
  }),

  "epic.progress": defineBlock({
    name: "epic.progress",
    about: "Reads where the epic stands this round.",
    inputKinds: { epic: "EpicNumber", round: "the round" },
    outputKinds: {
      layers: "every sub-issue, with its state",
      fingerprint: "what the status comment compares",
    },
    outcomeKinds: {},
    needs: ["epic.claim"],
    inputs: { epic: "required", round: "required" },
    run: (input: { readonly epic: EpicNumber; readonly round: number }) =>
      Epic.progress(input.epic, input.round),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "epic.postStatus": defineBlock({
    name: "epic.postStatus",
    about: "Keeps one status comment on the epic up to date.",
    inputKinds: { epic: "EpicNumber", round: "the round", progress: "from epic.progress" },
    outputKinds: "nothing",
    outcomeKinds: {},
    before: ["epic.finished"],
    inputs: { epic: "required", round: "required", progress: "required" },
    run: (input: {
      readonly epic: EpicNumber;
      readonly round: number;
      readonly progress: Epic.Progress;
    }) => Epic.postStatus(input.epic, input.round, input.progress),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  // What each layer waits on as this round reads it: the sub-issues a held one
  // waits on, and the one a stacked one is stacked on.
  "epic.noteWaits": defineBlock({
    name: "epic.noteWaits",
    about: "Notes what each task waits on this round, for the run's lanes.",
    inputKinds: { progress: "from epic.progress", tasks: "the epic.tasks state" },
    outputKinds: { tasks: "the epic.tasks state, updated" },
    outcomeKinds: {},
    stepNames: [],
    inputs: { progress: "required", tasks: "required" },
    run: (input: { readonly progress: Epic.Progress; readonly tasks: TaskState }) =>
      Effect.sync(() => {
        const waitedOn = new Map(input.tasks.waitedOn);

        for (const layer of input.progress.layers) {
          const on = [
            ...(layer.waitsOn ?? []),
            ...Option.toArray(Option.fromUndefinedOr(layer.stackedOn)),
          ];

          if (on.length > 0) {
            waitedOn.set(layer.number, new Set([...(waitedOn.get(layer.number) ?? []), ...on]));
          }
        }

        return { tasks: { ...input.tasks, waitedOn } };
      }),
    failures: {},
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  // Whether every task is closed, which ends the run.
  "epic.finished": defineBlock({
    name: "epic.finished",
    about: "Whether every task is closed.",
    inputKinds: { epic: "EpicNumber", progress: "from epic.progress" },
    outputKinds: { finished: "boolean", summary: "a summary, for `end`'s summary" },
    outcomeKinds: { finished: "a summary, for `end`'s summary" },
    stepNames: [],
    inputs: { epic: "required", progress: "required" },
    run: (input: { readonly epic: EpicNumber; readonly progress: Epic.Progress }) =>
      Effect.succeed({
        finished: Epic.finished(input.progress),
        summary: `#${input.epic}: every task is closed`,
      }),
    failures: {},
    outcomes: {
      finished: (read: { readonly finished: boolean; readonly summary: string }) =>
        Option.liftPredicate(read.summary, () => read.finished),
    },
    mustRoute: ["finished"],
    contributes: {},
  }),

  "stack.carryUp": defineBlock({
    name: "stack.carryUp",
    about:
      "Carries a moved layer's change up its stack, bottom to top. A layer that needs a person holds the ones above it.",
    inputKinds: {
      round: "the round",
      progress: "from epic.progress",
      stack: "the stack.upkeep state",
    },
    outputKinds: {
      moved: "boolean: whether it pushed anything",
      stack: "the stack.upkeep state, updated",
    },
    outcomeKinds: { moved: "the stack.upkeep state, updated" },
    before: ["stack.land", "epic.startable"],
    inputs: { round: "required", progress: "required", stack: "required" },
    run: (input: {
      readonly round: number;
      readonly progress: Epic.Progress;
      readonly stack: Upkeep;
    }) => carryUp(input.round, input.progress, input.stack),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {
      moved: (carried: { readonly moved: boolean; readonly stack: Upkeep }) =>
        Option.liftPredicate(carried.stack, () => carried.moved),
    },
    mustRoute: ["moved"],
    progressOn: ["moved"],
    contributes: { settings: Settings.Stacks.fields },
  }),

  "stack.land": defineBlock({
    name: "stack.land",
    about: "Lands the layers that may, each once those below it have merged.",
    inputKinds: {
      round: "the round",
      progress: "from epic.progress",
      stack: "the stack.upkeep state",
    },
    outputKinds: {
      moved: "boolean: whether anything moved",
      stack: "the stack.upkeep state, updated",
    },
    outcomeKinds: { moved: "the stack.upkeep state, updated" },
    before: ["epic.startable"],
    inputs: { round: "required", progress: "required", stack: "required" },
    run: (input: {
      readonly round: number;
      readonly progress: Epic.Progress;
      readonly stack: Upkeep;
    }) => land(input.round, input.progress, input.stack),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {
      moved: (landed: { readonly moved: boolean; readonly stack: Upkeep }) =>
        Option.liftPredicate(landed.stack, () => landed.moved),
    },
    mustRoute: ["moved"],
    progressOn: ["moved"],
    contributes: { settings: Settings.MergeHold.fields },
  }),

  "epic.startable": defineBlock({
    name: "epic.startable",
    about:
      "Decides which tasks to start this round: those ready that haven't been attempted, or that a person handed back.",
    inputKinds: { progress: "from epic.progress", tasks: "the epic.tasks state" },
    outputKinds: {
      tasks: "the epic.tasks state, updated, for a round that starts nothing",
      started: "the tasks as they were started, for epic.recordEndings",
      starts: "the tasks to start, for forEach: issue, base, lane",
    },
    outcomeKinds: { none: "the epic.tasks state, updated" },
    stepNames: [],
    inputs: { progress: "required", tasks: "required" },
    run: (input: { readonly progress: Epic.Progress; readonly tasks: TaskState }) =>
      Effect.gen(function* () {
        const { starts, ...tasks } = planStarts(input.progress, input.tasks);

        // Each lane waited on the lanes of the tasks it waited on, and a later
        // attempt on the one before it. Declaring it again, as a resumed run
        // does, changes nothing.
        for (const start of starts) {
          yield* Lanes.declare(start.lane, [
            ...[...(tasks.waitedOn.get(start.issue) ?? [])].flatMap((below) =>
              lanesOf(below, tasks.attempts),
            ),
            ...Option.toArray(
              Option.map(
                Option.liftPredicate(start.attempt, (count) => count > 1),
                (count) => attemptId(start.issue, count - 1),
              ),
            ),
          ]);
        }

        return { tasks, started: { started: tasks }, starts };
      }),
    failures: {},
    outcomes: {
      none: (planned: { readonly tasks: TaskState; readonly starts: ReadonlyArray<TaskStart> }) =>
        Option.liftPredicate(planned.tasks, () => planned.starts.length === 0),
    },
    mustRoute: ["none"],
    // Any task it starts is a new attempt.
    progressUnless: "none",
    contributes: {},
  }),

  // Parks until a layer changes, or a day passes, for what changes no layer: a
  // person's task closed, say.
  "epic.park": defineBlock({
    name: "epic.park",
    fixed: ["lookAgainAfter"],
    about: "Parks the run until a layer changes, or `lookAgainAfter` passes.",
    inputKinds: { round: "the round", lookAgainAfter: 'how long: "1 day"' },
    outputKinds: "which came first",
    outcomeKinds: {},
    inputs: { round: "required", lookAgainAfter: "required" },
    run: (input: { readonly round: number; readonly lookAgainAfter: "1 day" }) =>
      awaitSignal([Epic.LAYER_CHANGED], {
        id: `epic-${input.round}`,
        timeout: input.lookAgainAfter,
      }),
    failures: { NeedsHuman: "told", Skip: "skip", StepFailed: "fail" },
    outcomes: {},
    mustRoute: [],
    waits: true,
    contributes: {},
  }),

  "epic.recordEndings": defineBlock({
    name: "epic.recordEndings",
    about: "Records how each lane ended, for the next round to read.",
    inputKinds: {
      tasks: "the started output of epic.startable",
      endings: "the output of forEach",
    },
    outputKinds: { tasks: "the epic.tasks state, updated" },
    outcomeKinds: {},
    stepNames: [],
    inputs: { tasks: "required", endings: "required" },
    run: (input: { readonly tasks: TasksStarted; readonly endings: ReadonlyArray<LaneEnding> }) =>
      Effect.succeed({
        tasks: {
          ...input.tasks.started,
          withPerson: new Set([
            ...input.tasks.started.withPerson,
            ...input.endings.filter((ending) => ending.withPerson).map((ending) => ending.issue),
          ]),
        },
      }),
    failures: {},
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  "stack.publish": defineBlock({
    name: "stack.publish",
    about:
      "Pushes a task's branch and opens its pull request, on the base it settles: the branch of the layer below, or what that one merged into.",
    inputKinds: {
      issue: "IssueNumber",
      epic: "EpicNumber",
      worktree: "WorktreePath",
      branch: "BranchName",
      base: "Option<BaseBranch>",
      outcome: "what the agent said",
      ship: "boolean: from epic.ships",
      lane: "LaneId",
      committed: "Committed: from agent.implement",
    },
    outputKinds: {
      pr: "a pull request: number, url",
      base: "Option<BaseBranch>: the base it opened on",
    },
    outcomeKinds: {},
    opens: ["hand-off"],
    inputs: {
      issue: "required",
      epic: "required",
      worktree: "required",
      branch: "required",
      base: "required",
      outcome: "required",
      ship: "required",
      lane: "required",
      committed: "required",
    },
    run: (input: {
      readonly issue: IssueNumber;
      readonly epic: EpicNumber;
      readonly worktree: WorktreePath;
      readonly branch: BranchName;
      readonly base: Option.Option<BaseBranch>;
      readonly outcome: Implement.ImplementOutcome;
      readonly ship: boolean;
      readonly lane: LaneId;
      readonly committed: Committed;
    }) => publish(input),
    failures: {
      NeedsHuman: "person",
      NotFound: "skip",
      NothingCommitted: "person",
      PushRejected: "person",
      Skip: "skip",
      StepFailed: "person",
    },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),

  // Lets the task's claim go once its attempt ends with a person, as a step of
  // the attempt's own, so a later attempt lets it go again.
  "issue.releaseClaim": defineBlock({
    name: "issue.releaseClaim",
    about: "Lets a task's claim go, as a step of its lane.",
    inputKinds: { issue: "IssueNumber", lane: "LaneId" },
    outputKinds: "nothing",
    outcomeKinds: {},
    closes: ["release-claim"],
    inputs: { issue: "required", lane: "required" },
    run: (input: { readonly issue: IssueNumber; readonly lane: LaneId }) =>
      releaseTask(input.issue, input.lane),
    failures: { NeedsHuman: "person", Skip: "skip", StepFailed: "person" },
    outcomes: {},
    mustRoute: [],
    contributes: {},
  }),
};

type Scoped<A, E, R> = (context: FailureContext) => Effect.Effect<A, E, R>;

// How a line of work beside others ends: it can't end the run. A task that
// needs a person is handed to one, and lets its claim go; one another run
// holds, or that is gone, leaves nothing to do; the run carries on with the
// rest either way.
export const laneScopes = {
  "epic.task": <A, E, R>(task: TaskStart, body: Scoped<A, E | ToPerson | Skip, R>) => {
    const context: FailureContext = { pr: Option.none() };

    return Effect.suspend(() => body(context)).pipe(
      Effect.as<LaneEnding>({ issue: task.issue, withPerson: false }),
      Effect.catchIf(
        (failure): failure is Skip => failure instanceof Skip,
        () => Effect.succeed<LaneEnding>({ issue: task.issue, withPerson: false }),
      ),
      Effect.catchIf(
        (failure): failure is ToPerson => failure instanceof ToPerson,
        (failure) =>
          Implement.handToHuman(task.issue, failure.reason, context.pr, { id: task.lane }).pipe(
            Effect.tap(() => releaseTask(task.issue, task.lane)),
            Effect.as<LaneEnding>({ issue: task.issue, withPerson: true }),
          ),
      ),
    );
  },
};

export const epicSources = {
  "epic.queued": defineSource("epic.queued", "epic", () => ({
    trigger: Epic.queued.pipe(reportAs("trigger")),
    contributes: {
      settings: { ...Routing.Settings.fields, ...Settings.Board.fields },
      labels: Plan.flowLabels.filter((label) => label.name === Plan.LABELS.epic),
    },
  })),
};

// However the run ends, its claim on the epic goes, and the engine lets its
// tasks' claims go too; a run parked between rounds keeps them.
export const epicSubject = {
  fields: ["epic"],
  failureContext: [],
  read: (item: WorkItem) =>
    Implement.issueOf(item).pipe(Effect.map((epic) => ({ epic: EpicNumber(epic) }))),
  scope: <A, E, R>(
    trigger: { readonly epic: EpicNumber },
    _options: { readonly claims: boolean },
    body: Scoped<A, E | ToPerson, R>,
  ) =>
    Effect.suspend(() => body({ pr: Option.none() })).pipe(
      Effect.catchIf(
        (failure): failure is ToPerson => failure instanceof ToPerson,
        (failure) => Effect.fail(new NeedsHuman({ reason: failure.reason })),
      ),
      Claims.releasing(Claims.epic(trigger.epic)),
    ),
  stillValid: Option.some(Epic.stillValid),
};

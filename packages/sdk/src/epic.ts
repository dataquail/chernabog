// The building blocks of the `epic` recipe: from an epic's sub-issues and the
// issues that block each, which open tasks may start, on the base branch or
// stacked on the work branch of the one task that blocks them, and why the
// rest wait. A closed blocker counts as done: the epic run closes a task only
// once its work reaches the base branch.

import {
  Claims,
  GitHub,
  type Labels,
  type LinkedIssue,
  planNodeMarker,
  type PullRequest,
  Repo,
} from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type Kind, VERIFY } from "./plan.ts";

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
export const kindOf = (labels: ReadonlyArray<string>, names: Labels): Kind => {
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

// The epic's open tasks, each ready or held: ready on the base branch with no
// open blocker; stacked on its blocker's work branch when that one open
// blocker is an auto task of this epic with an open pull request, and the
// stack stays within limits.stackDepth; held otherwise. The verify task is
// ready only once every other sub-issue is closed.
export const tasks = (epic: number) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const repo = yield* Repo;
    const open = (yield* github.subIssues(epic)).filter((issue) => issue.state === "open");
    const verify = open.find((issue) => isVerify(epic, issue));
    const work = open.filter((issue) => !isVerify(epic, issue));

    // The epic's open auto tasks, the only ones another task stacks on.
    const auto = new Set(
      work
        .filter((issue) => kindOf(issue.labels, repo.labels) === "auto")
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

        if ((yield* depthOf(pull.value)) + 1 > repo.limits.stackDepth) {
          return held(`waits for #${blocker.number}'s stack to merge`);
        }

        return ready(Claims.branchFor(blocker.number), Option.some(blocker.number));
      });

    const taskOf = (issue: LinkedIssue, state: Ready | Held): Task => ({
      number: issue.number,
      title: issue.title,
      kind: kindOf(issue.labels, repo.labels),
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

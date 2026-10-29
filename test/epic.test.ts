// An epic's tasks on an in-memory GitHub: which are ready to start, on the
// base branch or stacked on a blocker's branch, and why the rest wait.

import {
  Claims,
  DEFAULT_LABELS,
  Epic,
  type LinkedIssue,
  planNodeMarker,
  type PullRequest,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";

import { DEFAULT_LIMITS } from "../src/repo-config.ts";
import { effect } from "./effect-test.ts";
import { type Fake, makeFake, onFake } from "./sdk-fakes.ts";

const EPIC = 40;

const LABELS_OF: Readonly<Record<Epic.Kind, ReadonlyArray<string>>> = {
  auto: [DEFAULT_LABELS.eligible],
  hybrid: [],
  human: [DEFAULT_LABELS.needsHuman],
};

type Made = {
  readonly kind?: Epic.Kind;
  readonly key?: string;
  readonly blockedBy?: ReadonlyArray<number>;
  readonly state?: LinkedIssue["state"];
  // Whether it is a sub-issue of the epic.
  readonly inEpic?: boolean;
};

// An issue the plan made, as a sub-issue of the epic unless it says otherwise.
const made = (fake: Fake, number: number, options: Made = {}) => {
  const kind = options.kind ?? "auto";

  fake.graph.made.set(number, {
    number,
    title: `Task ${number}`,
    body: `What to do.\n\n${planNodeMarker.write({ spec: EPIC, key: options.key ?? `task-${number}` })}`,
    url: `https://github.com/dataquail/demo/issues/${number}`,
    createdAt: "2026-10-21T00:00:00Z",
    labels: [],
    assignees: [],
    state: options.state ?? "open",
  });
  fake.setLabels(number, [...LABELS_OF[kind]]);
  fake.graph.blockedBy.set(number, [...(options.blockedBy ?? [])]);

  if (options.inEpic ?? true) {
    const tasks = fake.graph.subIssues.get(EPIC) ?? [];

    if (!tasks.includes(number)) {
      fake.graph.subIssues.set(EPIC, [...tasks, number]);
    }
  }
};

const close = (fake: Fake, number: number) => {
  for (const found of Option.toArray(Option.fromUndefinedOr(fake.graph.made.get(number)))) {
    fake.graph.made.set(number, { ...found, state: "closed" });
  }
};

// An open pull request from the task's work branch onto `base`.
const opened = (fake: Fake, number: number, base = "main") => {
  const pull: PullRequest = {
    number: number + 100,
    title: `Task ${number}`,
    body: "",
    url: `https://github.com/dataquail/demo/pull/${number + 100}`,
    state: "open",
    headRef: Claims.branchFor(number),
    headSha: `head${number}`,
    baseRef: base,
    labels: [],
    author: "chernabog-bot",
    assignees: [],
    requestedReviewers: [],
  };

  fake.branchPulls.set(pull.headRef, pull);
};

const ordering = (fake: Fake) => onFake(fake, Epic.tasks(EPIC));

// Each task by number, as ready on its base or held with its reason.
const states = (fake: Fake) =>
  Effect.map(ordering(fake), (found) =>
    Object.fromEntries(
      found.tasks.map((task) => [
        task.number,
        Match.value(task).pipe(
          Match.when({ state: "ready" }, (ready) => `ready on ${ready.base}`),
          Match.when({ state: "held" }, (held) => `held: ${held.reason}`),
          Match.exhaustive,
        ),
      ]),
    ),
  );

describe("an epic's tasks", () => {
  effect("starts an independent task on the base branch, and leaves out closed ones", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      made(fake, 10);
      made(fake, 11, { state: "closed" });

      const found = yield* ordering(fake);
      expect(found.tasks).toEqual([
        {
          number: 10,
          title: "Task 10",
          kind: "auto",
          state: "ready",
          base: "main",
          stackedOn: Option.none(),
        },
      ]);
      expect(found.verify).toEqual(Option.none());
    }),
  );

  effect("makes a chain one stack, each task on its blocker's branch once that has a PR", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      made(fake, 10);
      made(fake, 11, { blockedBy: [10] });
      made(fake, 12, { blockedBy: [11] });

      expect(yield* states(fake)).toEqual({
        10: "ready on main",
        11: "held: waits on #10",
        12: "held: waits on #11",
      });

      opened(fake, 10);
      expect(yield* states(fake)).toEqual({
        10: "ready on main",
        11: "ready on auto/issue-10",
        12: "held: waits on #11",
      });

      opened(fake, 11, "auto/issue-10");
      const found = yield* ordering(fake);
      expect(found.tasks.find((task) => task.number === 12)).toEqual({
        number: 12,
        title: "Task 12",
        kind: "auto",
        state: "ready",
        base: "auto/issue-11",
        stackedOn: Option.some(11),
      });

      close(fake, 10);
      expect((yield* states(fake))[11]).toBe("ready on main");
    }),
  );

  effect("holds a task several open tasks block, until at most one is open", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      made(fake, 10);
      made(fake, 11, { blockedBy: [10] });
      made(fake, 12, { blockedBy: [10] });
      made(fake, 13, { blockedBy: [11, 12] });
      opened(fake, 10);
      opened(fake, 11, "auto/issue-10");
      opened(fake, 12, "auto/issue-10");

      expect((yield* states(fake))[13]).toBe("held: waits on #11, #12");

      close(fake, 10);
      close(fake, 11);
      expect((yield* states(fake))[13]).toBe("ready on auto/issue-12");
    }),
  );

  effect("holds a task an issue outside the epic blocks, pull request or none", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      made(fake, 50, { inEpic: false });
      made(fake, 10, { blockedBy: [50] });
      opened(fake, 50);

      expect(yield* states(fake)).toEqual({ 10: "held: waits on #50" });

      close(fake, 50);
      expect(yield* states(fake)).toEqual({ 10: "ready on main" });
    }),
  );

  effect("never stacks on a hybrid or human task, even one with a pull request", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      made(fake, 10, { kind: "hybrid" });
      made(fake, 11, { kind: "human" });
      made(fake, 12, { blockedBy: [10] });
      made(fake, 13, { blockedBy: [11] });
      opened(fake, 10);
      opened(fake, 11);

      const found = yield* ordering(fake);
      expect(found.tasks.map((task) => [task.number, task.kind])).toEqual([
        [10, "hybrid"],
        [11, "human"],
        [12, "auto"],
        [13, "auto"],
      ]);
      expect(yield* states(fake)).toEqual({
        10: "ready on main",
        11: "ready on main",
        12: "held: waits on #10",
        13: "held: waits on #11",
      });
    }),
  );

  effect("holds a task that would make its blocker's stack deeper than limits.stackDepth", () =>
    Effect.gen(function* () {
      const chain = (fake: Fake) => {
        made(fake, 10);
        made(fake, 11, { blockedBy: [10] });
        made(fake, 12, { blockedBy: [11] });
        opened(fake, 10);
        opened(fake, 11, "auto/issue-10");
      };

      const shallow = makeFake("approve", { limits: { ...DEFAULT_LIMITS, stackDepth: 2 } });
      chain(shallow);
      expect((yield* states(shallow))[12]).toBe("held: waits for #11's stack to merge");

      close(shallow, 10);
      // Once #10 merges, #11's pull request is retargeted onto the base branch.
      opened(shallow, 11);
      expect((yield* states(shallow))[12]).toBe("ready on auto/issue-11");

      const deep = makeFake("approve");
      chain(deep);
      expect((yield* states(deep))[12]).toBe("ready on auto/issue-11");
    }),
  );

  effect("reports the verify task apart, ready only once every other task is closed", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      made(fake, 10);
      made(fake, 11, { blockedBy: [10] });
      made(fake, 20, { kind: "human", key: "verify", blockedBy: [10, 11] });

      const waiting = yield* ordering(fake);
      expect(waiting.tasks.map((task) => task.number)).toEqual([10, 11]);
      expect(waiting.verify).toEqual(
        Option.some({
          number: 20,
          title: "Task 20",
          kind: "human",
          state: "held",
          reason: "waits on #10, #11",
        }),
      );

      close(fake, 10);
      close(fake, 11);
      const done = yield* ordering(fake);
      expect(done.tasks).toEqual([]);
      expect(done.verify).toEqual(
        Option.some({
          number: 20,
          title: "Task 20",
          kind: "human",
          state: "ready",
          base: "main",
          stackedOn: Option.none(),
        }),
      );
    }),
  );
});

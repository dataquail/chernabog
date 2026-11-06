// The scenarios a flow document must run as its recipe does, each through the
// engine on an in-memory GitHub: what each left, compared in full, is the run's
// end, its step names (a run resumes by them), its lanes, and everything it did
// on GitHub.

import {
  Agent,
  AgentError,
  Claims,
  DEFAULT_LABELS,
  Epic,
  type Flow,
  type LinkedIssue,
  Plan,
  PushRejected,
  type WorkItem,
} from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { IMPLICIT } from "../src/kernel/persona.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { readRunHistoryHandler } from "../src/modules/runs/queries/read-run-history.handler.ts";
import {
  deliverSignals,
  type EngineRun,
  type Fake,
  flowTriggered,
  ISSUE,
  item,
  PULL,
  repo,
  repoFake,
  runUntil,
  stackOn,
} from "./sdk-fakes.ts";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

// A run's own id, and when it did things, differ from run to run.
const unsaid = (text: string) => text.replaceAll(UUID, "<id>").replaceAll(ISO_TIME, "<time>");

// The labels of every issue and pull request the fake knows.
const everyLabel = (fake: Fake) =>
  [
    ...new Set([
      ...fake.graph.made.keys(),
      ...[...fake.branchPulls.values()].map((pull) => pull.number),
    ]),
  ]
    .toSorted((left, right) => left - right)
    .map((number) => [number, fake.labelsOf(number)] as const);

// What a parked run is waiting for: a change to make, and the signal that
// tells the run, which the flow's own trigger must find.
export type Wake = {
  readonly signal: string;
  readonly change: (fake: Fake) => void;
  // Whether to stop following the run once it parks, rather than wake it.
  readonly stops?: boolean;
};

export const observe = (
  flow: Flow,
  name: string,
  setup: () => Fake,
  work: WorkItem,
  wake?: Wake,
  on: typeof repo = repo,
) =>
  Effect.gen(function* () {
    const fake = setup();
    const handle = flowHandle(on, name, flow);
    let steps: ReadonlyArray<string> = [];
    let lanes: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [];

    const finished: EngineRun = yield* runUntil(handle, fake, work, (run) =>
      Effect.gen(function* () {
        // Read as the run stops being followed, so a step it just entered is in it.
        const readSteps = readRunHistoryHandler({ runId: run.id }).pipe(
          Effect.orDie,
          Effect.map((history) => {
            steps = [...new Set(history.steps.map((step) => step.step))];
            lanes = (history.lanes ?? []).map((lane) => [lane.lane, lane.needs] as const);
          }),
        );

        if (run.status !== "running") {
          yield* readSteps;

          return true;
        }

        for (const { change, signal } of Option.toArray(Option.fromUndefinedOr(wake))) {
          const { waits } = yield* listRunWaitsHandler({ runId: run.id, signal });

          if (waits.length > 0) {
            if (wake?.stops === true) {
              yield* readSteps;

              return true;
            }

            change(fake);
            const found = yield* flowTriggered(fake, flow).pipe(Effect.orDie);
            yield* deliverSignals(
              handle,
              IMPLICIT,
              found.filter((each) => (each.signals ?? []).length > 0),
            );
          }
        }

        return false;
      }),
    );

    return {
      status: finished.status,
      summary: unsaid(Option.getOrElse(finished.summary, () => "")),
      subjects: finished.subjects,
      steps,
      lanes,
      issueLabels: fake.labelsOf(ISSUE),
      pullLabels: fake.labelsOf(PULL),
      labels: everyLabel(fake),
      pulls: [...fake.branchPulls.values()].map((pull) => [pull.headRef, pull.baseRef, pull.state]),
      comments: fake.comments.map((comment) => unsaid(comment.body)),
      reviews: fake.reviews.map(unsaid),
      submitted: fake.submitted.map((each) => ({ ...each })),
      merges: fake.merge.requests,
      pushes: fake.git.pushes,
      opened: fake.git.opened,
      agentSteps: fake.steps.map((step) => Option.getOrElse(step, () => "")),
      // One of the pool, at random.
      requested: fake.people.requested.length,
      assigned: fake.people.assigned,
      pullAssigned: fake.people.pullAssigned,
      ran: fake.git.ran.map(unsaid),
    };
  });

const POOL = { reviewers: ["zach", "data-quail"] };
const BRANCH = "zach/fix-it";
const IMPLEMENT_WORK = item(`issue-${ISSUE}`, { issue: ISSUE });

const queued = (label: string = DEFAULT_LABELS.eligible) => {
  const fake = repoFake("approve", POOL);
  fake.setLabels(ISSUE, [label]);
  fake.setLabels(PULL, []);

  return fake;
};

const closing = (overrides: Record<string, string | boolean> = {}) => ({
  number: PULL,
  url: `https://github.com/dataquail/demo/pull/${PULL}`,
  state: "OPEN",
  isDraft: false,
  headRefName: BRANCH,
  baseRefName: "main",
  isCrossRepository: false,
  ...overrides,
});

const closedByPull = (draft = false) => {
  const fake = queued();
  fake.git.opened = true;
  fake.authored.headRef = BRANCH;
  fake.authored.author = "zach";
  fake.authored.draft = draft;
  fake.closing.push(closing({ isDraft: draft }));

  return fake;
};

// One thing that can happen to a run, set up the same way for recipe and document.
export type Scenario = {
  readonly title: string;
  readonly setup: () => Fake;
  readonly ends: EngineRun["status"];
  readonly wake?: Wake;
  readonly on: typeof repo;
};

type Define = (
  title: string,
  setup: () => Fake,
  ends: EngineRun["status"],
  wake?: Wake,
  on?: typeof repo,
) => void;

const scenarios = (define: (scenario: Define) => void) => {
  const found: Array<Scenario> = [];

  define((title, setup, ends, wake, on = repo) => {
    found.push({ title, setup, ends, wake, on });
  });

  return found;
};

export const IMPLEMENT_WORK_ITEM = IMPLEMENT_WORK;

export const IMPLEMENT_SCENARIOS = scenarios((scenario) => {
  scenario("when the work goes for review", () => queued(), "done");

  scenario("when the issue is on the automated path", () => queued(DEFAULT_LABELS.ship), "done");

  scenario(
    "when the agent has questions",
    () => {
      const fake = queued();
      fake.author.asks.push("/tmp/demo-worktrees/auto/issue-3");

      return fake;
    },
    "needs-human",
  );

  scenario(
    "when the agent commits nothing",
    () => {
      const fake = queued();
      fake.author.leaves.push("?? a.ts");

      return fake;
    },
    "needs-human",
  );

  scenario(
    "when CI is red and stays red",
    () => {
      const fake = queued();
      fake.merge.ci = { state: "red", failedChecks: ["test"] };

      return fake;
    },
    "needs-human",
  );

  scenario(
    "when an earlier run left the issue's branch",
    () => {
      const fake = queued();
      fake.existing.branch = true;

      return fake;
    },
    "done",
  );

  scenario(
    "when another run holds the claim",
    () => {
      const fake = queued();
      fake.refs.set(Claims.refFor(Claims.issue(ISSUE)), "held0000");

      return fake;
    },
    "skipped",
  );

  scenario(
    "when the remote rejects the push",
    () => {
      const fake = queued();
      fake.git.rejects = Option.some(
        new PushRejected({ branch: `auto/issue-${ISSUE}`, reason: "! [remote rejected]" }),
      );

      return fake;
    },
    "needs-human",
  );

  // A step's failure after the claim tells a person.
  scenario(
    "when the agent fails",
    () => {
      const fake = queued();

      return {
        ...fake,
        services: Layer.merge(
          fake.services,
          Layer.succeed(
            Agent,
            Agent.of({
              adapters: [],
              run: () => Effect.fail(new AgentError({ message: "claude: it broke" })),
            }),
          ),
        ),
      };
    },
    "needs-human",
  );

  scenario("when an open pull request closes the issue", () => closedByPull(), "done");

  scenario(
    "when the adopted pull request's CI needs a fix",
    () => {
      const fake = closedByPull();
      fake.merge.ci = { state: "red", failedChecks: ["test"] };

      return fake;
    },
    "needs-human",
  );

  scenario(
    "when several pull requests close the issue",
    () => {
      const fake = closedByPull();
      fake.closing.push(closing({ headRefName: "zach/other" }));

      return fake;
    },
    "needs-human",
  );

  scenario(
    "when the closing pull request is on a fork",
    () => {
      const fake = queued();
      fake.git.opened = true;
      fake.authored.headRef = BRANCH;
      fake.closing.push(closing({ isCrossRepository: true }));

      return fake;
    },
    "needs-human",
  );

  scenario("when the adopted draft is marked ready", () => closedByPull(true), "done", {
    signal: "ready",
    change: (fake) => {
      fake.authored.draft = false;
    },
  });
});

const REVIEW_WORK = item(`pr-${PULL}`, {
  pullRequest: PULL,
  headRef: "auto/issue-3",
  agentWritten: true,
});

export const REVIEW_WORK_ITEM = REVIEW_WORK;

export const REVIEW_SCENARIOS = scenarios((scenario) => {
  const asked = (verdict: "approve" | "request-changes", labels: ReadonlyArray<string> = []) => {
    const fake = repoFake(verdict);
    fake.people.me = "data-quail";
    fake.people.requested = ["data-quail"];
    fake.setLabels(PULL, [...labels]);

    return fake;
  };

  scenario("when it approves, and a person merges", () => asked("approve"), "done");

  scenario(
    "when it approves a pull request on the automated path",
    () => asked("approve", [DEFAULT_LABELS.ship]),
    "done",
  );

  scenario("when it asks for changes", () => asked("request-changes"), "done");

  scenario(
    "when the approved pull request conflicts with its base",
    () => {
      const fake = asked("approve", [DEFAULT_LABELS.ship]);
      fake.merge.refusal = Option.some("Pull Request is not mergeable");
      fake.merge.state = "dirty";

      return fake;
    },
    "done",
  );

  scenario(
    "when GitHub refuses the merge for another reason",
    () => {
      const fake = asked("approve", [DEFAULT_LABELS.ship]);
      fake.merge.refusal = Option.some("Required status check is expected");

      return fake;
    },
    "needs-human",
  );

  scenario(
    "when the pull request waits on the layer below",
    () => {
      const fake = asked("approve", [DEFAULT_LABELS.ship]);
      stackOn(fake, "auto/issue-2");

      return fake;
    },
    "done",
  );

  scenario(
    "when the pull request closes before it can land",
    () => {
      const fake = asked("approve", [DEFAULT_LABELS.ship]);
      fake.states.pull = "closed";

      return fake;
    },
    "skipped",
  );
});

const EPIC_NUMBER = 40;

// One task at a time, so both runs make their pull requests in one order.
const oneAtATime = (shared: Record<string, boolean | number>) => ({
  ...repo,
  personas: Arr.map(repo.personas, (persona) => ({
    ...persona,
    shared: { atOnce: 1, ...shared },
  })),
});

export const EPIC_WORK_ITEM = item(`issue-${EPIC_NUMBER}`, { issue: EPIC_NUMBER });

export const EPIC_SCENARIOS = scenarios((define) => {
  const scenario = (
    title: string,
    setup: () => Fake,
    ends: EngineRun["status"],
    wake: Wake,
    shared: Record<string, boolean | number> = {},
  ) => {
    define(title, setup, ends, wake, oneAtATime(shared));
  };

  const EPIC = EPIC_NUMBER;

  const madeIssue = (number: number, title: string): LinkedIssue => ({
    number,
    title,
    body: "",
    url: `https://github.com/dataquail/demo/issues/${number}`,
    createdAt: "2026-10-21T00:00:00Z",
    labels: [],
    assignees: [],
    state: "open",
  });

  // #10, then #11 on it; #12 on its own; and #13, which needs both #10 and #12.
  const epicFake = () => {
    const fake = repoFake("approve");
    fake.graph.made.set(EPIC, madeIssue(EPIC, "An epic"));
    fake.setLabels(EPIC, [Plan.LABELS.epic]);

    const task = (number: number, blockedBy: ReadonlyArray<number> = []) => {
      fake.graph.made.set(number, madeIssue(number, `Task ${number}`));
      fake.setLabels(number, [DEFAULT_LABELS.eligible]);
      fake.graph.blockedBy.set(number, [...blockedBy]);
      fake.graph.subIssues.set(EPIC, [...(fake.graph.subIssues.get(EPIC) ?? []), number]);
    };

    task(10);
    task(11, [10]);
    task(12);
    task(13, [10, 12]);

    return fake;
  };

  // Every task closed, and its pull request merged, as a person merging them would.
  const mergeAll = (fake: Fake) => {
    for (const number of [10, 11, 12, 13]) {
      for (const found of Option.toArray(Option.fromUndefinedOr(fake.graph.made.get(number)))) {
        fake.graph.made.set(number, { ...found, state: "closed" });
      }

      const branch = Claims.branchFor(number);

      for (const pull of Option.toArray(Option.fromUndefinedOr(fake.branchPulls.get(branch)))) {
        fake.branchPulls.set(branch, { ...pull, state: "merged" });
      }
    }
  };

  const STOP_PARKED: Wake = { signal: Epic.LAYER_CHANGED, change: () => void 0, stops: true };

  scenario(
    "when it opens every ready task's pull request and parks",
    epicFake,
    "running",
    STOP_PARKED,
  );

  scenario("when its layers ship", epicFake, "running", STOP_PARKED, { ship: true });

  scenario("when every task merges, and the run wakes and ends", epicFake, "done", {
    signal: Epic.LAYER_CHANGED,
    change: mergeAll,
  });

  scenario(
    "when a task's agent has questions",
    () => {
      const fake = epicFake();
      fake.author.asks.push("/tmp/demo-worktrees/auto/issue-12");

      return fake;
    },
    "running",
    STOP_PARKED,
  );

  // A failure after the pull request opened labels it too.
  scenario(
    "when a task's CI stays red, and it goes to a person",
    () => {
      const fake = epicFake();
      fake.merge.ci = { state: "red", failedChecks: ["test"] };

      return fake;
    },
    "running",
    STOP_PARKED,
  );

  scenario(
    "when the remote rejects a task's push",
    () => {
      const fake = epicFake();
      fake.git.rejects = Option.some(
        new PushRejected({ branch: "auto/issue-10", reason: "! [remote rejected]" }),
      );

      return fake;
    },
    "running",
    STOP_PARKED,
  );
});

// A generated flow must behave as the recipe it stands in for. Each scenario
// runs through the engine twice on the same in-memory GitHub, once as the
// recipe and once as its document's flow, and what each left must match: the
// run's end, its step names (a run resumes by them), and everything it did on
// GitHub.

import {
  Agent,
  AgentError,
  Claims,
  DEFAULT_LABELS,
  Epic,
  type Flow,
  labelsOf,
  type LinkedIssue,
  Plan,
  PullRequest,
  PushRejected,
  Settings,
  type WorkItem,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import epic from "../packages/recipes/flows/epic.ts";
import implement from "../packages/recipes/flows/implement.ts";
import review from "../packages/recipes/flows/review.ts";
import { IMPLICIT } from "../src/kernel/persona.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { readRunHistoryHandler } from "../src/modules/runs/queries/read-run-history.handler.ts";
import {
  documentOf,
  EPIC_DOCUMENT,
  IMPLEMENT_DOCUMENT,
  loadFlow,
  REVIEW_DOCUMENT,
} from "./compose-harness.ts";
import { effect } from "./effect-test.ts";
import {
  deliverSignals,
  type EngineRun,
  type Fake,
  flowTriggered,
  ISSUE,
  item,
  makeFake,
  PULL,
  repo,
  runUntil,
  stackOn,
} from "./sdk-fakes.ts";

const composedImplement = loadFlow(documentOf(IMPLEMENT_DOCUMENT));

const composedReview = loadFlow(documentOf(REVIEW_DOCUMENT));

const composedEpic = loadFlow(documentOf(EPIC_DOCUMENT));

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

const COMMENT_STEP = /^(comment-pr-\d+)-[0-9a-f]+$/;

// A comment's step is named by a hash of its text, which can say the run's id.
const stepNamed = (step: string) => step.replace(COMMENT_STEP, "$1");

// What a parked run is waiting for: a change to make, and the signal that
// tells the run, which the flow's own trigger must find.
type Wake = {
  readonly signal: string;
  readonly change: (fake: Fake) => void;
  // Whether to stop following the run once it parks, rather than wake it.
  readonly stops?: boolean;
};

type FlowInput = Settings.FlowSettings["Service"]["input"];

// The settings of a repo's config.yaml, for every flow.
const inRepo = (shared: FlowInput) => ({
  ...repo,
  personas: Arr.map(repo.personas, (persona) => ({ ...persona, shared })),
});

const observe = (
  flow: Flow,
  name: string,
  setup: () => Fake,
  work: WorkItem,
  wake?: Wake,
  settings: FlowInput = {},
) =>
  Effect.gen(function* () {
    const fake = setup();
    const handle = flowHandle(inRepo(settings), name, flow);
    let steps: ReadonlyArray<string> = [];

    const finished: EngineRun = yield* runUntil(handle, fake, work, (run) =>
      Effect.gen(function* () {
        // Read as the run stops being followed, so a step it just entered is in it.
        const readSteps = readRunHistoryHandler({ runId: run.id }).pipe(
          Effect.orDie,
          Effect.map((history) => {
            steps = [...new Set(history.steps.map((step) => stepNamed(step.step)))];
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
            const found = yield* flowTriggered(fake, flow, settings).pipe(Effect.orDie);
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
  const fake = makeFake("approve", POOL);
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

// Runs the recipe and the document's flow on the same scenario.
const same = <E, R>(
  recipe: Flow,
  loading: Effect.Effect<Flow, E, R>,
  name: string,
  setup: () => Fake,
  work: WorkItem,
  ends: EngineRun["status"],
  wake?: Wake,
  settings?: FlowInput,
) =>
  Effect.gen(function* () {
    const composed = yield* loading;
    const fromRecipe = yield* observe(recipe, name, setup, work, wake, settings);
    const fromDocument = yield* observe(composed, name, setup, work, wake, settings);

    expect(fromRecipe.status).toBe(ends);
    expect(fromDocument).toEqual(fromRecipe);
  });

describe("the implement document runs as the recipe does", () => {
  const scenario = (title: string, setup: () => Fake, ends: EngineRun["status"], wake?: Wake) => {
    effect(
      title,
      () => same(implement, composedImplement, "implement", setup, IMPLEMENT_WORK, ends, wake),
      60_000,
    );
  };

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

describe("the review document runs as the recipe does", () => {
  const WORK = item(`pr-${PULL}`, {
    pullRequest: PULL,
    headRef: "auto/issue-3",
    agentWritten: true,
  });

  const asked = (verdict: "approve" | "request-changes", labels: ReadonlyArray<string> = []) => {
    const fake = makeFake(verdict);
    fake.people.me = "data-quail";
    fake.people.requested = ["data-quail"];
    fake.setLabels(PULL, [...labels]);

    return fake;
  };

  const scenario = (
    title: string,
    setup: () => Fake,
    ends: EngineRun["status"],
    wake?: Wake,
    settings?: FlowInput,
  ) => {
    effect(
      title,
      () => same(review, composedReview, "review", setup, WORK, ends, wake, settings),
      60_000,
    );
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

  // The one wake pr.land contributes: it must find the run, or the run stays parked.
  scenario(
    "when the merge holds on a red base, and the base turns green",
    () => {
      const fake = asked("approve", [DEFAULT_LABELS.ship]);
      fake.merge.baseCi = Option.some({ state: "red", failedChecks: ["test"] });

      return fake;
    },
    "done",
    {
      signal: PullRequest.BASE_GREEN,
      change: (fake) => {
        fake.merge.baseCi = Option.some({ state: "green" });
      },
    },
    { holdMergesOnBrokenBase: true },
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

describe("the epic document runs as the recipe does", () => {
  const EPIC = 40;
  const EPIC_WORK = item(`issue-${EPIC}`, { issue: EPIC });

  // One task at a time, so both runs make their pull requests in one order.
  const oneAtATime = (shared: Record<string, boolean | number>) => ({ atOnce: 1, ...shared });

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
    const fake = makeFake("approve");
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

  const scenario = (
    title: string,
    setup: () => Fake,
    ends: EngineRun["status"],
    wake: Wake,
    shared: Record<string, boolean | number> = {},
  ) => {
    effect(
      title,
      () => same(epic, composedEpic, "epic", setup, EPIC_WORK, ends, wake, oneAtATime(shared)),
      60_000,
    );
  };

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

describe("a document's sources find what its recipe's trigger does", () => {
  const found = (flow: Flow, setup: () => Fake) => flowTriggered(setup(), flow);

  const both = () => {
    const fake = queued();
    fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible, DEFAULT_LABELS.ship]);

    return fake;
  };

  const requested = () => {
    const fake = makeFake("approve");
    fake.people.me = "data-quail";
    fake.people.requested = ["data-quail"];

    return fake;
  };

  for (const [title, setup] of [
    ["an eligible issue", () => queued()],
    ["an issue on the automated path", () => queued(DEFAULT_LABELS.ship)],
    ["an issue with both labels", both],
  ] as const) {
    effect(`implement, on ${title}`, () =>
      Effect.gen(function* () {
        const fromRecipe = yield* found(implement, setup);
        expect(fromRecipe).toHaveLength(1);
        expect(yield* found(yield* composedImplement, setup)).toEqual(fromRecipe);
      }),
    );
  }

  effect("review, on a pull request that asks for one", () =>
    Effect.gen(function* () {
      const fromRecipe = yield* found(review, requested);
      expect(fromRecipe).toHaveLength(1);
      expect(yield* found(yield* composedReview, requested)).toEqual(fromRecipe);
    }),
  );

  // Which label queues an issue doesn't depend on where a document lists it.
  describe("whatever order a document lists the labels in", () => {
    const listing = (labels: ReadonlyArray<"eligible" | "ship">) =>
      loadFlow({
        ...documentOf(IMPLEMENT_DOCUMENT),
        trigger: [{ use: "issues.queued", with: { labels } }],
      });

    const dataOf = (flow: Flow, setup: () => Fake) =>
      found(flow, setup).pipe(Effect.map((items) => items.map((each) => each.data)));

    const SHIPPING = { issue: ISSUE, label: DEFAULT_LABELS.ship };

    effect("an issue on the automated path is queued by its label", () =>
      Effect.gen(function* () {
        const shipping = () => queued(DEFAULT_LABELS.ship);
        expect(yield* dataOf(yield* listing(["ship"]), shipping)).toEqual([SHIPPING]);
        expect(yield* dataOf(yield* listing(["ship", "eligible"]), shipping)).toEqual([SHIPPING]);
      }),
    );

    effect("an eligible issue is queued by no label", () =>
      Effect.gen(function* () {
        const flow = yield* listing(["ship", "eligible"]);
        expect(yield* dataOf(flow, () => queued())).toEqual([{ issue: ISSUE }]);
      }),
    );

    effect(
      "a run of what a ship-only source finds does as the recipe's does",
      () =>
        Effect.gen(function* () {
          const flow = yield* listing(["ship"]);
          const shipping = () => queued(DEFAULT_LABELS.ship);
          const work = Option.getOrThrow(Arr.head(yield* found(flow, shipping)));
          const fromDocument = yield* observe(flow, "implement", shipping, work);
          expect(fromDocument).toEqual(yield* observe(implement, "implement", shipping, work));
          expect(fromDocument.issueLabels).toEqual([]);
          expect(fromDocument.pullLabels).toEqual([DEFAULT_LABELS.ship]);
        }),
      60_000,
    );
  });
});

describe("a document's flow declares what its recipe does", () => {
  const settingsKeys = (flow: Flow) => {
    const { settings } = flow;

    if (Predicate.hasProperty(settings, "fields") && Predicate.isObject(settings.fields)) {
      return Object.keys(settings.fields).toSorted();
    }

    return [];
  };

  const declared = (flow: Flow) => ({
    settings: settingsKeys(flow),
    concurrency: flow.concurrency,
    ownWork: flow.ownWork === true,
    doctor: flow.doctor,
    stillValid: flow.stillValid,
    gate: flow.gate,
  });

  const labelled = (flow: Flow) =>
    labelsOf(flow).pipe(
      Effect.provideService(Settings.FlowSettings, { input: {} }),
      Effect.provide(makeFake("approve").services),
    );

  effect("implement", () =>
    Effect.gen(function* () {
      const composed = yield* composedImplement;
      expect(declared(composed)).toEqual(declared(implement));
      expect(yield* labelled(composed)).toEqual(yield* labelled(implement));
    }),
  );

  effect("epic", () =>
    Effect.gen(function* () {
      const composed = yield* composedEpic;
      expect(declared(composed)).toEqual(declared(epic));
      expect(yield* labelled(composed)).toEqual(yield* labelled(epic));
    }),
  );

  effect("review", () =>
    Effect.gen(function* () {
      const composed = yield* composedReview;
      expect(declared(composed)).toEqual(declared(review));
      expect(yield* labelled(composed)).toEqual(yield* labelled(review));
    }),
  );
});

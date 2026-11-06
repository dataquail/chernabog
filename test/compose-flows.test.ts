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
  type Flow,
  labelsOf,
  PushRejected,
  Settings,
  type WorkItem,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import implement from "../packages/recipes/flows/implement.ts";
import review from "../packages/recipes/flows/review.ts";
import { IMPLICIT } from "../src/kernel/persona.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { readRunHistoryHandler } from "../src/modules/runs/queries/read-run-history.handler.ts";
import { documentOf, IMPLEMENT_DOCUMENT, loadFlow, REVIEW_DOCUMENT } from "./compose-harness.ts";
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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

// A run's own id, and when it did things, differ from run to run.
const unsaid = (text: string) => text.replaceAll(UUID, "<id>").replaceAll(ISO_TIME, "<time>");

// What a parked run is waiting for: a change to make, and the signal that
// tells the run, which the flow's own trigger must find.
type Wake = { readonly signal: string; readonly change: (fake: Fake) => void };

const observe = (flow: Flow, name: string, setup: () => Fake, work: WorkItem, wake?: Wake) =>
  Effect.gen(function* () {
    const fake = setup();
    const handle = flowHandle(repo, name, flow);
    let steps: ReadonlyArray<string> = [];

    const finished: EngineRun = yield* runUntil(handle, fake, work, (run) =>
      Effect.gen(function* () {
        const history = yield* readRunHistoryHandler({ runId: run.id }).pipe(Effect.orDie);
        steps = [...new Set(history.steps.map((step) => step.step))];

        if (run.status !== "running") {
          return true;
        }

        for (const { change, signal } of Option.toArray(Option.fromUndefinedOr(wake))) {
          const { waits } = yield* listRunWaitsHandler({ runId: run.id, signal });

          if (waits.length > 0) {
            change(fake);
            const found = yield* flowTriggered(fake, flow).pipe(Effect.orDie);
            yield* deliverSignals(
              handle,
              IMPLICIT,
              found.filter((each) => each.wakeOnly === true),
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
) =>
  Effect.gen(function* () {
    const composed = yield* loading;
    const fromRecipe = yield* observe(recipe, name, setup, work, wake);
    const fromDocument = yield* observe(composed, name, setup, work, wake);

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

  const scenario = (title: string, setup: () => Fake, ends: EngineRun["status"]) => {
    effect(title, () => same(review, composedReview, "review", setup, WORK, ends), 60_000);
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

  effect("review", () =>
    Effect.gen(function* () {
      const composed = yield* composedReview;
      expect(declared(composed)).toEqual(declared(review));
      expect(yield* labelled(composed)).toEqual(yield* labelled(review));
    }),
  );
});

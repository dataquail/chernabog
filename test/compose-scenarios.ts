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
  type Json,
  type LinkedIssue,
  Plan,
  PullRequest,
  PushRejected,
  reviewMarker,
  type Settings,
  Skip,
  type WorkItem,
} from "@chernabog/sdk";
import { expect } from "bun:test";
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
  HEAD,
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

const COMMENT_STEP = /^(comment-pr-\d+)-[0-9a-f]+$/;

// A comment's step is named by a hash of its text, which can say the run's id.
const stepNamed = (step: string) => step.replace(COMMENT_STEP, "$1");

// What a parked run is waiting for: a change to make, and the signal that
// tells the run, which the flow's own trigger must find.
export type Wake = {
  readonly signal: string;
  readonly change: (fake: Fake) => void;
};

// What a run that parks round after round, as an epic's does, meets at each
// park in turn: the next change, and the signal that tells the run, each park
// told apart by the wait it parks on. At the park after the last change, the
// run is followed no further.
export type Parks = {
  readonly signal: string;
  readonly changes: ReadonlyArray<(fake: Fake) => void>;
};

const isParks = (wake: Wake | Parks): wake is Parks => "changes" in wake;

export type FlowInput = Settings.FlowSettings["Service"]["input"];

// The settings of a repo's config.yaml, for every flow.
const inRepo = (shared: FlowInput) => ({
  ...repo,
  personas: Arr.map(repo.personas, (persona) => ({ ...persona, shared })),
});

export const observe = (
  flow: Flow,
  name: string,
  setup: () => Fake,
  work: WorkItem,
  wake?: Wake | Parks,
  settings: FlowInput = {},
) =>
  Effect.gen(function* () {
    const fake = setup();
    const handle = flowHandle(inRepo(settings), name, flow);
    let steps: ReadonlyArray<string> = [];
    let lanes: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [];
    // The parks already woken, by their waits, and the changes made so far.
    const answered = new Set<string>();
    let changed = 0;

    // Delivers what the flow's own trigger then reports as a signal: how many runs it woke.
    const signal = Effect.gen(function* () {
      const found = yield* flowTriggered(fake, flow, settings).pipe(Effect.orDie);

      return yield* deliverSignals(
        handle,
        IMPLICIT,
        found.filter((each) => (each.signals ?? []).length > 0),
      );
    });

    const finished: EngineRun = yield* runUntil(handle, fake, work, (run) =>
      Effect.gen(function* () {
        // Read as the run stops being followed, so a step it just entered is in it.
        const readSteps = readRunHistoryHandler({ runId: run.id }).pipe(
          Effect.orDie,
          Effect.map((history) => {
            steps = [...new Set(history.steps.map((step) => stepNamed(step.step)))];
            lanes = (history.lanes ?? []).map((lane) => [lane.lane, lane.needs] as const);
          }),
        );

        if (run.status !== "running") {
          yield* readSteps;

          return true;
        }

        for (const waking of Option.toArray(Option.fromUndefinedOr(wake))) {
          const { waits } = yield* listRunWaitsHandler({ runId: run.id, signal: waking.signal });

          if (!isParks(waking)) {
            if (waits.length > 0) {
              waking.change(fake);
              yield* signal;
            }

            continue;
          }

          const parked = Arr.findFirst(waits, (wait) => !answered.has(wait.deferred));

          if (Option.isNone(parked)) {
            continue;
          }

          const change = Arr.get(waking.changes, answered.size);

          if (Option.isNone(change)) {
            yield* readSteps;

            return true;
          }

          if (changed === answered.size) {
            change.value(fake);
            changed += 1;
          }

          if ((yield* signal) > 0) {
            answered.add(parked.value.deferred);
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
      // The lanes an epic declared, and the lanes each waited on.
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

export type Observed = Effect.Success<ReturnType<typeof observe>>;

const POOL = { reviewers: ["zach", "data-quail"] };
const BRANCH = "zach/fix-it";
const IMPLEMENT_WORK = item(`issue-${ISSUE}`, { issue: ISSUE });

export const queued = (label: string = DEFAULT_LABELS.eligible) => {
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
  readonly wake?: Wake | Parks;
  readonly settings: FlowInput;
  // What the recipe must have done, so a match isn't two runs doing nothing.
  readonly did: (recipe: Observed) => void;
};

type Define = (
  title: string,
  setup: () => Fake,
  ends: EngineRun["status"],
  wake?: Wake | Parks,
  settings?: FlowInput,
  did?: (recipe: Observed) => void,
) => void;

const scenarios = (define: (scenario: Define) => void) => {
  const found: Array<Scenario> = [];

  define((title, setup, ends, wake, settings = {}, did = () => void 0) => {
    found.push({ title, setup, ends, wake, settings, did });
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

const RE_REVIEW_WORK = item(`pr-${PULL}-review-2`, {
  pullRequest: PULL,
  headRef: "auto/issue-3",
  agentWritten: true,
});

export const RE_REVIEW_WORK_ITEM = RE_REVIEW_WORK;

// An earlier review's marker: data-quail's, with the session to resume, unless said otherwise.
type Earlier = { readonly round: number; readonly reviewer?: string; readonly session?: boolean };

export const RE_REVIEW_SCENARIOS = scenarios((scenario) => {
  // A pull request that asks data-quail, the persona the run acts as, to
  // review it again, after the `earlier` reviews; its next review answers
  // `verdict`, and a re-check settles its verdict by `findings`.
  const askedAgain = (
    verdict: "approve" | "request-changes",
    {
      earlier = [{ round: 1 }],
      findings = [{ finding: "Mention the change", remediated: true, blocking: true }],
      labels = [],
    }: {
      readonly earlier?: ReadonlyArray<Earlier>;
      readonly labels?: ReadonlyArray<string>;
      readonly findings?: ReadonlyArray<{
        finding: string;
        remediated: boolean;
        blocking: boolean;
      }>;
    } = {},
  ) => {
    const fake = repoFake(verdict);
    fake.people.me = "data-quail";
    fake.people.requested = ["data-quail"];
    fake.setLabels(PULL, [...labels]);
    fake.rechecked.findings = [...findings];

    for (const each of earlier) {
      const session = Option.liftPredicate("earlier-session", () => each.session !== false);

      fake.comment(
        reviewMarker.write({
          sha: HEAD,
          round: each.round,
          verdict: "request-changes",
          reviewer: each.reviewer ?? "data-quail",
          ...Option.match(session, {
            onNone: () => ({}),
            onSome: (sessionId) => ({ sessionId }),
          }),
          adapter: "claude",
        }),
      );
    }

    return fake;
  };

  const SHIP = [DEFAULT_LABELS.ship];

  // A first review, as review's, when there is none of its own to resume.
  const firstReview = (recipe: Observed) => {
    expect(recipe.steps).toContain("review-1");
    expect(recipe.steps).not.toContain("review-2");
  };

  // A re-check in the earlier review's session, and the comment on its findings.
  const rechecked = (recipe: Observed) => {
    expect(recipe.steps).toContain("review-2");
    expect(recipe.agentSteps).toEqual(["review-2"]);
    expect(recipe.comments).toContainEqual(
      "Review 1's findings, re-reviewed.\n\nRemediated:\n- Mention the change\n\nStill open:",
    );
  };

  const OPEN = [{ finding: "Mention the change", remediated: false, blocking: true }];

  scenario(
    "when it has no review of its own, and a first review approves",
    () => askedAgain("approve", { earlier: [{ round: 1, reviewer: "zach" }] }),
    "done",
    void 0,
    {},
    firstReview,
  );

  scenario(
    "when it has no review of its own, and a first review asks for changes",
    () => askedAgain("request-changes", { earlier: [] }),
    "done",
  );

  scenario(
    "when its review carries no session to resume, and a first review merges",
    () => askedAgain("approve", { labels: SHIP, earlier: [{ round: 1, session: false }] }),
    "done",
  );

  scenario(
    "when it approves on the re-review, and a person merges",
    () => askedAgain("approve"),
    "done",
    void 0,
    {},
    rechecked,
  );

  scenario(
    "when it approves a pull request on the automated path",
    () => askedAgain("approve", { labels: SHIP }),
    "done",
  );

  scenario(
    "when only a point that doesn't block the merge is open",
    () =>
      askedAgain("request-changes", {
        labels: SHIP,
        findings: [{ finding: "Fix the description", remediated: false, blocking: false }],
      }),
    "done",
  );

  scenario(
    "when it still asks for changes",
    () => askedAgain("request-changes", { labels: SHIP, findings: OPEN }),
    "needs-human",
  );

  scenario(
    "when the approved pull request conflicts with its base",
    () => {
      const fake = askedAgain("approve", { labels: SHIP });
      fake.merge.refusal = Option.some("Pull Request is not mergeable");
      fake.merge.state = "dirty";

      return fake;
    },
    "done",
  );

  scenario(
    "when GitHub refuses the merge for another reason",
    () => {
      const fake = askedAgain("approve", { labels: SHIP });
      fake.merge.refusal = Option.some("Required status check is expected");

      return fake;
    },
    "needs-human",
  );

  scenario(
    "when the pull request waits on the layer below",
    () => {
      const fake = askedAgain("approve", { labels: SHIP });
      stackOn(fake, "auto/issue-2");

      return fake;
    },
    "done",
  );

  scenario(
    "when the merge holds on a red base, and the base turns green",
    () => {
      const fake = askedAgain("approve", { labels: SHIP });
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
    "when it has had as many re-reviews as reviewRounds allows",
    () => askedAgain("approve", { earlier: [{ round: 1 }, { round: 2 }] }),
    "needs-human",
    void 0,
    {},
    (recipe) => {
      expect(recipe.steps).toEqual(["find-review", `needs-human-pr-${PULL}`]);
      expect(recipe.pullLabels).toContain(DEFAULT_LABELS.needsHuman);
    },
  );

  scenario(
    "when reviewRounds allows no re-review",
    () => askedAgain("approve"),
    "needs-human",
    void 0,
    { reviewRounds: 0 },
  );

  scenario(
    "when the pull request closes before it can land",
    () => {
      const fake = askedAgain("approve", { labels: SHIP });
      fake.states.pull = "closed";

      return fake;
    },
    "skipped",
  );
});

const EPIC = 40;

export const EPIC_WORK_ITEM = item(`issue-${EPIC}`, { issue: EPIC });

export const EPIC_SCENARIOS = scenarios((define) => {
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

  // An epic of these auto tasks, each blocked by the ones it names.
  const epicOf = (tasks: ReadonlyArray<readonly [number, ReadonlyArray<number>]>) => {
    const fake = repoFake("approve");
    fake.graph.made.set(EPIC, madeIssue(EPIC, "An epic"));
    fake.setLabels(EPIC, [Plan.LABELS.epic]);

    for (const [number, blockedBy] of tasks) {
      fake.graph.made.set(number, madeIssue(number, `Task ${number}`));
      fake.setLabels(number, [DEFAULT_LABELS.eligible]);
      fake.graph.blockedBy.set(number, [...blockedBy]);
      fake.graph.subIssues.set(EPIC, [...(fake.graph.subIssues.get(EPIC) ?? []), number]);
    }

    return fake;
  };

  // #10, then #11 on it; #12 on its own; and #13, which needs both #10 and #12.
  const epicFake = () =>
    epicOf([
      [10, []],
      [11, [10]],
      [12, []],
      [13, [10, 12]],
    ]);

  // Two tasks on their own: #10, then #12.
  const twoAlone = () =>
    epicOf([
      [10, []],
      [12, []],
    ]);

  // The worktree a task's implement session runs in.
  const worktreeOf = (number: number) => `/tmp/demo-worktrees/${Claims.branchFor(number)}`;

  // The task closed, and its pull request merged, as a person merging it would.
  const merged = (fake: Fake, number: number) => {
    for (const found of Option.toArray(Option.fromUndefinedOr(fake.graph.made.get(number)))) {
      fake.graph.made.set(number, { ...found, state: "closed" });
    }

    const branch = Claims.branchFor(number);

    for (const pull of Option.toArray(Option.fromUndefinedOr(fake.branchPulls.get(branch)))) {
      fake.branchPulls.set(branch, { ...pull, state: "merged" });
    }
  };

  const mergeAll = (fake: Fake) => {
    for (const number of [10, 11, 12, 13]) {
      merged(fake, number);
    }
  };

  // A person hands the task back with auto:eligible.
  const handBack = (fake: Fake, number: number) => {
    fake.setLabels(number, [DEFAULT_LABELS.eligible]);
  };

  // Whether the run took any step whose name has this in it.
  const tookStep = (observed: Observed, part: string) =>
    observed.steps.some((step) => step.includes(part));

  const scenario = (
    title: string,
    setup: () => Fake,
    ends: EngineRun["status"],
    changes: Parks["changes"],
    shared: Record<string, boolean | number> = {},
    // What the recipe must have done, so a match isn't two runs doing nothing.
    did: (recipe: Observed) => void = () => void 0,
  ) => {
    define(title, setup, ends, { signal: Epic.LAYER_CHANGED, changes }, oneAtATime(shared), did);
  };

  scenario("when it opens every ready task's pull request and parks", epicFake, "running", []);

  scenario("when its layers ship", epicFake, "running", [], { ship: true });

  scenario("when every task merges, and the run wakes and ends", epicFake, "done", [mergeAll]);

  scenario(
    "when a task's agent has questions",
    () => {
      const fake = epicFake();
      fake.author.asks.push(worktreeOf(12));

      return fake;
    },
    "running",
    [],
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
    [],
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
    [],
  );

  // The round that first reads #12 as waiting for answers is the round that
  // parks, so only what that park carries to the next round says #12 was
  // handed back.
  scenario(
    "when a task's agent has questions, the run parks on them, and a person hands it back",
    () => {
      const fake = twoAlone();
      fake.author.asks.push(worktreeOf(12));

      return fake;
    },
    "running",
    [
      (fake) => {
        handBack(fake, 12);
      },
    ],
    {},
    (recipe) => {
      expect(recipe.agentSteps).toContain("implement#task-12-2");
    },
  );

  // #10's attempt ends with a person, who hands it back while #12 works, so
  // no round ever reads #10 with the person: only how its attempt ended says
  // it was handed back (#249).
  scenario(
    "when a person hands back a task whose attempt went to them before the next round reads it",
    () => {
      const fake = twoAlone();
      fake.git.rejects = Option.some(
        new PushRejected({ branch: "auto/issue-10", reason: "! [remote rejected]" }),
      );
      fake.author.meanwhile.set(worktreeOf(12), () => {
        fake.git.rejects = Option.none();
        handBack(fake, 10);
      });

      return fake;
    },
    "running",
    [],
    {},
    (recipe) => {
      expect(recipe.agentSteps).toContain("implement#task-10-2");
    },
  );

  // #10, then #11 on it, its branch's head at `ten0000000`.
  const twoStacked = () => {
    const fake = epicOf([
      [10, []],
      [11, [10]],
    ]);

    fake.remote.heads.set(Claims.branchFor(10), "ten0000000");

    return fake;
  };

  // A fix pushed on #10's branch: its head moves, and bringing #11 up to
  // date with it makes a merge commit to push.
  const fixBelow = (fake: Fake) => {
    const branch = Claims.branchFor(10);
    fake.remote.heads.set(branch, "fix1000000");

    for (const pull of Option.toArray(Option.fromUndefinedOr(fake.branchPulls.get(branch)))) {
      fake.branchPulls.set(branch, { ...pull, headSha: "fix1000000" });
    }

    fake.git.makes.add(`merge --no-edit origin/${branch}`);
  };

  // The first park reads #11 up to date with #10; a fix then lands on #10,
  // and the next round carries it up, pushing #11, and reads the epic again.
  scenario(
    "when a fix pushed on a layer is carried up to the layer above",
    twoStacked,
    "running",
    [fixBelow],
    {},
    (recipe) => {
      expect(tookStep(recipe, "push-refresh-201-fix1000000")).toBe(true);
    },
  );

  // The refresh's push is rejected, so #11 goes to a person, and the run
  // parks; the person hands it back, and the refresh runs again as a new
  // attempt. Only the stack the park kept says #11 went to a person.
  scenario(
    "when carrying a fix up goes to a person, who hands the layer back",
    twoStacked,
    "running",
    [
      (fake) => {
        fixBelow(fake);
        fake.git.rejects = Option.some(
          new PushRejected({ branch: Claims.branchFor(11), reason: "! [remote rejected]" }),
        );
      },
      (fake) => {
        const branch = Claims.branchFor(11);
        fake.git.rejects = Option.none();
        fake.git.makes.add(`merge --no-edit origin/${Claims.branchFor(10)}`);

        for (const pull of Option.toArray(Option.fromUndefinedOr(fake.branchPulls.get(branch)))) {
          fake.setLabels(
            pull.number,
            fake.labelsOf(pull.number).filter((label) => label !== DEFAULT_LABELS.needsHuman),
          );
          fake.branchPulls.set(branch, { ...pull, headSha: "person1100" });
        }
      },
    ],
    {},
    (recipe) => {
      expect(tookStep(recipe, "needs-human#refresh-201-fix1000000")).toBe(true);
      expect(tookStep(recipe, "push-refresh-201-fix1000000-2")).toBe(true);
    },
  );

  // A round reads #11 stacked on #10 and starts #12 on #11; while #12 is
  // implemented, #10 squash-merges, GitHub moves #11 onto main, and #11's
  // review approves it. Only the stack the round that started #12 kept says
  // #11 was on #10, so #11 is brought up to date with main, which pushes,
  // and lands the round after; #12 is then moved onto main.
  scenario(
    "when the layer below a shipping layer merges while a task on that layer is implemented",
    () => {
      const fake = epicOf([
        [10, []],
        [11, [10]],
        [12, [11]],
      ]);

      fake.remote.heads.set(Claims.branchFor(10), "ten0000000");
      fake.author.meanwhile.set(worktreeOf(12), () => {
        merged(fake, 10);

        for (const below of Option.toArray(
          Option.fromUndefinedOr(fake.branchPulls.get(Claims.branchFor(10))),
        )) {
          fake.closed.push({
            number: below.number,
            merged_at: "2026-10-22T00:00:00Z",
            merge_commit_sha: "squash1000",
            head: { sha: below.headSha },
            base: { ref: "main" },
          });
        }

        fake.remote.gone.add(Claims.branchFor(10));

        for (const above of Option.toArray(
          Option.fromUndefinedOr(fake.branchPulls.get(Claims.branchFor(11))),
        )) {
          fake.branchPulls.set(above.headRef, { ...above, baseRef: "main" });
          fake.comment(reviewMarker.write({ sha: above.headSha, round: 1, verdict: "approve" }));
        }

        fake.git.makes.add("merge --no-edit origin/main");
      });

      return fake;
    },
    "running",
    [],
    { ship: true },
    (recipe) => {
      expect(tookStep(recipe, "push-refresh-201-base1234")).toBe(true);
      expect(tookStep(recipe, "merge-pr-201")).toBe(true);
      expect(tookStep(recipe, "retarget-")).toBe(true);
      expect(recipe.pulls).toContainEqual(["auto/issue-11", "main", "merged"]);
    },
  );
});

// A review flow with the repo's which-pr stage in front, whose answer is the
// fake's: a stage runs in its own process.
const answering = (setup: () => Fake, answer: (input: Json) => Effect.Effect<Json, Skip>) => () => {
  const fake = setup();
  fake.stages.set("which-pr", answer);

  return fake;
};

const [APPROVED] = REVIEW_SCENARIOS.filter(
  (scenario) => scenario.title === "when it approves a pull request on the automated path",
);

// What a run that went through the stage did, and what the recipe did, the
// stage's step aside: with a stage that names the trigger's pull request, the
// two must be the same.
export const throughStage = (flow: Flow, recipe: Flow, scenario: Scenario) =>
  Effect.gen(function* () {
    const setup = answering(scenario.setup, Effect.succeed);
    const { settings, wake } = scenario;
    const fromRecipe = yield* observe(recipe, "review", setup, REVIEW_WORK_ITEM, wake, settings);
    const fromFlow = yield* observe(flow, "review", setup, REVIEW_WORK_ITEM, wake, settings);

    const steps: ReadonlyArray<string> = fromFlow.steps.filter((step) => step !== "which-pr");

    return { first: fromFlow.steps[0], flow: { ...fromFlow, steps }, recipe: fromRecipe };
  });

// A stage that answers another pull request than the trigger's: what it was
// given, and the steps of the run after it, which name the pull request they
// work on.
export const stageElsewhere = (flow: Flow) =>
  Effect.gen(function* () {
    const given: Array<Json> = [];

    const setup = answering(APPROVED.setup, (input) =>
      Effect.sync(() => {
        given.push(input);

        return { pr: PULL + 100 };
      }),
    );

    const observed = yield* observe(flow, "review", setup, REVIEW_WORK_ITEM);

    return { given, steps: observed.steps };
  });

// A stage that skips the run, as exit 78 does.
export const stageSkipping = (flow: Flow) =>
  Effect.gen(function* () {
    const setup = answering(APPROVED.setup, () =>
      Effect.fail(new Skip({ reason: "nothing to do" })),
    );

    const observed = yield* observe(flow, "review", setup, REVIEW_WORK_ITEM);

    return { status: observed.status, steps: observed.steps, reviews: observed.reviews };
  });

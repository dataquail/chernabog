// The scenarios a flow document must run as its recipe does, each through the
// engine on an in-memory GitHub: what each left, compared in full, is the run's
// end, its step names (a run resumes by them), its lanes, and everything it did
// on GitHub.

import {
  Agent,
  AgentError,
  claimMarker,
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
  sessionMarker,
  type Settings,
  Skip,
  type WorkItem,
} from "@chernabog/sdk";
import type { BunServices } from "@effect/platform-bun";
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
  type RuntimeServices,
  runUntil,
  stackOn,
} from "./sdk-fakes.ts";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

// Session ids, a run's own made from its id: each told apart from the others by
// the order it first appears in, so two runs that resume the same sessions in
// the same order match, and one that starts another session where the other
// resumed doesn't.
const sameSessions = (sessionIds: ReadonlyArray<string>) => {
  const seen: Array<string> = [];

  return sessionIds.map((sessionId) => {
    if (!UUID_ONLY.test(sessionId)) {
      return unsaid(sessionId);
    }

    if (!seen.includes(sessionId)) {
      seen.push(sessionId);
    }

    return `<session ${seen.indexOf(sessionId) + 1}>`;
  });
};

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

// What a test reads of a run as it stops being followed, beside what observe
// compares: its history and its log, say. Nothing, unless a test asks.
export type Inspect = (
  run: EngineRun,
) => Effect.Effect<void, never, RuntimeServices | BunServices.BunServices>;

export const observe = (
  flow: Flow,
  name: string,
  setup: () => Fake,
  work: WorkItem,
  wake?: Wake | Parks,
  settings: FlowInput = {},
  inspect: Inspect = () => Effect.void,
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
          Effect.andThen(inspect(run)),
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
      // The base each push was checked against: a layer's, the layer below.
      checkedAgainst: fake.based.checkedAgainst,
      opened: fake.git.opened,
      agentSteps: fake.steps.map((step) => Option.getOrElse(step, () => "")),
      // The session each agent call resumed or started, in the agent it ran, and with whom.
      sessions: sameSessions(fake.requests.map((request) => request.sessionId)).map(
        (sessionId, at) => [
          sessionId,
          Option.getOrElse(fake.requests[at].adapter, () => ""),
          fake.requests[at].withPerson === true,
        ],
      ),
      // What each agent call was asked: the prompt that starts a session, and
      // the one that resumes it, which carries a person's changes to a plan.
      prompts: fake.requests.map((request) => [
        unsaid(request.prompt),
        unsaid(Option.getOrElse(request.resumePrompt, () => "")),
      ]),
      // One of the pool, at random.
      requested: fake.people.requested.length,
      assigned: fake.people.assigned,
      pullAssigned: fake.people.pullAssigned,
      ran: fake.git.ran.map(unsaid),
      // The issues the run filed, by title and body, and the commits it read CI on.
      filed: [...fake.graph.made.values()].map((made) => [unsaid(made.title), unsaid(made.body)]),
      ciReads: fake.ciReads,
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

// A pull request that asks data-quail, the persona the run acts as, for a
// review, which answers `verdict`.
export const reviewAsked = (
  verdict: "approve" | "request-changes",
  labels: ReadonlyArray<string> = [],
) => {
  const fake = repoFake(verdict);
  fake.people.me = "data-quail";
  fake.people.requested = ["data-quail"];
  fake.setLabels(PULL, [...labels]);

  return fake;
};

export const REVIEW_SCENARIOS = scenarios((scenario) => {
  const asked = reviewAsked;

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

const ADDRESS_WORK = item(`pr-${PULL}-changes-1`, {
  pullRequest: PULL,
  headRef: `auto/issue-${ISSUE}`,
  agentWritten: true,
  reviewer: "data-quail",
  reviewedSha: HEAD,
});

export const ADDRESS_REVIEW_WORK_ITEM = ADDRESS_WORK;

// The work of a layer of a stack, based on the layer below's branch.
export const ADDRESS_REVIEW_LAYER_WORK_ITEM = item(`pr-${PULL}-changes-1`, {
  pullRequest: PULL,
  headRef: `auto/issue-${ISSUE}`,
  baseRef: "auto/issue-2",
  agentWritten: true,
  reviewer: "data-quail",
  reviewedSha: HEAD,
});

// The session marker the run that opened the pull request left: implement's,
// an epic task's, whose session is the task's own, or a person's on the
// hybrid path.
const IMPLEMENT_SESSION = { sessionId: "implement-session", adapter: "claude" };

const EPIC_TASK_SESSION = { sessionId: "epic-run-implement#task-3", adapter: "codex" };

export const ADDRESS_REVIEW_SCENARIOS = scenarios((scenario) => {
  // A pull request this persona wrote, whose latest review, by data-quail,
  // asks for changes on its head; the author answers `consider`, and the run
  // that opened it left `session`, or none.
  const changesAsked = ({
    consider = "address",
    session = Option.some<{
      readonly sessionId: string;
      readonly adapter: string;
      readonly withPerson?: boolean;
    }>(IMPLEMENT_SESSION),
  }: {
    readonly consider?: "address" | "decline";
    readonly session?: Option.Option<{
      readonly sessionId: string;
      readonly adapter: string;
      readonly withPerson?: boolean;
    }>;
  } = {}) => {
    const fake = repoFake(["approve"]);
    fake.author.consider = consider;
    fake.submitted.push({ author: "data-quail", state: "CHANGES_REQUESTED", commitSha: HEAD });
    fake.comment(
      reviewMarker.write({
        sha: HEAD,
        round: 1,
        verdict: "request-changes",
        reviewer: "data-quail",
        sessionId: "review-session",
        adapter: "codex",
      }),
    );

    for (const marker of Option.toArray(session)) {
      fake.comment(
        `Implemented for #${ISSUE}. ${sessionMarker.write({ ...marker, issue: ISSUE, branch: `auto/issue-${ISSUE}` })}`,
      );
    }

    // The implement run's push; the fix moves the head.
    fake.git.pushes = 1;

    return fake;
  };

  const WORKTREE = `/tmp/demo-worktrees/auto/issue-${ISSUE}`;

  // Answered in the author's session, pushed, and the reviewer asked again.
  const askedAgain = (recipe: Observed) => {
    expect(recipe.summary).toBe(`#${PULL}: addressed review 1; asked data-quail to review again`);
    expect(recipe.steps).toContain("push-review-1");
    expect(recipe.steps).toContain("ask-again-1");
    expect(recipe.pushes).toBe(2);
  };

  const toPerson = (recipe: Observed) => {
    expect(recipe.pullLabels).toContain(DEFAULT_LABELS.needsHuman);
    expect(recipe.steps).toContain(`needs-human-pr-${PULL}`);
    expect(recipe.steps).not.toContain("ask-again-1");
  };

  scenario(
    "when the author agrees, fixes, and CI is green",
    () => changesAsked(),
    "done",
    void 0,
    {},
    (recipe) => {
      askedAgain(recipe);
      expect(recipe.sessions).toEqual([
        ["implement-session", "claude", false],
        ["implement-session", "claude", false],
      ]);
    },
  );

  scenario(
    "when the pull request is an epic task's, whose own session answers",
    () => changesAsked({ session: Option.some(EPIC_TASK_SESSION) }),
    "done",
    void 0,
    {},
    (recipe) => {
      askedAgain(recipe);
      expect(recipe.sessions.map(([sessionId]) => sessionId)).toEqual([
        EPIC_TASK_SESSION.sessionId,
        EPIC_TASK_SESSION.sessionId,
      ]);
    },
  );

  scenario(
    "when no run left a session, so a fresh one answers",
    () => changesAsked({ session: Option.none() }),
    "done",
  );

  scenario(
    "when a person worked on the pull request with the agent, and the fix touches humanOnlyPaths",
    () => {
      const fake = changesAsked({
        session: Option.some({ ...IMPLEMENT_SESSION, withPerson: true }),
      });

      fake.merge.files = ["src/a.ts", ".github/workflows/ci.yml"];

      return fake;
    },
    "done",
    void 0,
    {},
    (recipe) => {
      askedAgain(recipe);
      expect(recipe.sessions.every(([, , withPerson]) => withPerson === true)).toBe(true);
    },
  );

  scenario(
    "when the author disputes the review",
    () => changesAsked({ consider: "decline" }),
    "needs-human",
    void 0,
    {},
    (recipe) => {
      toPerson(recipe);
      expect(recipe.comments).toContainEqual("Not addressing review 1:\n\nThe review is right.");
      expect(recipe.pushes).toBe(1);
    },
  );

  scenario(
    "when the author needs a person to answer the review",
    () => {
      const fake = changesAsked();
      fake.author.asks.push(WORKTREE);

      return fake;
    },
    "needs-human",
    void 0,
    {},
    (recipe) => {
      toPerson(recipe);
      expect(recipe.summary).toContain("the author agent needs a person to answer review 1");
    },
  );

  scenario(
    "when the author leaves its changes uncommitted",
    () => {
      const fake = changesAsked();
      fake.author.leaves.push(" M src/b.ts");

      return fake;
    },
    "needs-human",
    void 0,
    {},
    (recipe) => {
      toPerson(recipe);
      expect(recipe.steps).toContain("check-changed-1");
      expect(recipe.pushes).toBe(1);
    },
  );

  scenario(
    "when the fix touches humanOnlyPaths on a pull request nobody worked on",
    () => {
      const fake = changesAsked();
      fake.merge.files = ["src/a.ts", ".github/workflows/ci.yml"];

      return fake;
    },
    "needs-human",
    void 0,
    {},
    (recipe) => {
      toPerson(recipe);
      expect(recipe.pushes).toBe(1);
    },
  );

  scenario(
    "when the remote rejects the push",
    () => {
      const fake = changesAsked();
      fake.git.rejects = Option.some(
        new PushRejected({ branch: `auto/issue-${ISSUE}`, reason: "! [remote rejected]" }),
      );

      return fake;
    },
    "needs-human",
    void 0,
    {},
    toPerson,
  );

  scenario(
    "when CI is red and stays red",
    () => {
      const fake = changesAsked();
      fake.merge.ci = { state: "red", failedChecks: ["test"] };

      return fake;
    },
    "needs-human",
    void 0,
    {},
    toPerson,
  );

  scenario(
    "when the agent fails",
    () => {
      const fake = changesAsked();

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
    void 0,
    {},
    toPerson,
  );

  scenario(
    "when another run owns the pull request",
    () => {
      const fake = changesAsked();
      fake.refs.set(Claims.refFor(Claims.pullRequest(PULL)), "held0000");

      return fake;
    },
    "skipped",
  );
});

// A layer of a stack: its push and CI are checked against the layer below.
export const ADDRESS_REVIEW_LAYER_SCENARIOS = scenarios((scenario) => {
  scenario(
    "when a layer of a stack is addressed",
    () => {
      const fake = repoFake(["approve"]);
      fake.submitted.push({ author: "data-quail", state: "CHANGES_REQUESTED", commitSha: HEAD });
      fake.comment(
        `Implemented for #${ISSUE}. ${sessionMarker.write({ ...EPIC_TASK_SESSION, issue: ISSUE, branch: `auto/issue-${ISSUE}` })}`,
      );
      fake.git.pushes = 1;
      fake.stack.base = "auto/issue-2";
      fake.stack.below = [".github/workflows/ci.yml"];

      return fake;
    },
    "done",
  );
});

const CONFLICT = {
  pullRequest: PULL,
  headRef: `auto/issue-${ISSUE}`,
  baseRef: "main",
};

export const RESOLVE_CONFLICTS_WORK_ITEM = item(`pr-${PULL}-${HEAD.slice(0, 7)}`, CONFLICT);

// The work of a layer of an epic's stack, based on the layer below's branch.
export const RESOLVE_CONFLICTS_LAYER_WORK_ITEM = item(`pr-${PULL}-${HEAD.slice(0, 7)}`, {
  ...CONFLICT,
  baseRef: "auto/issue-2",
});

// The persona's own pull request, which GitHub says conflicts with its base.
const conflicting = () => {
  const fake = repoFake("approve");
  fake.setLabels(PULL, []);
  fake.merge.state = "dirty";

  return fake;
};

// The persona's pull request, moved onto main after #2, the layer below of an
// epic's stack, squash-merged there as `squash1`: its head, `below0000000`, is
// in the pull request's history, and `squash1` isn't.
const belowSquashed = () => {
  const fake = conflicting();
  stackOn(fake, "auto/issue-2", "merged");
  fake.stack.base = "main";
  fake.closed.push({
    number: 2,
    merged_at: "2026-10-31T17:09:00Z",
    merge_commit_sha: "squash1",
    head: { sha: "below0000000" },
  });
  fake.git.refuses.add("merge-base --is-ancestor squash1 HEAD");
  fake.git.says.set("rev-list --parents -n 1 squash1", "squash1 main0001\n");

  return fake;
};

const MERGED = "Merged `main` into this branch to resolve its conflicts.";

export const RESOLVE_CONFLICTS_SCENARIOS = scenarios((scenario) => {
  const toPerson = (recipe: Observed) => {
    expect(recipe.pullLabels).toContain(DEFAULT_LABELS.needsHuman);
    expect(recipe.steps).toContain(`needs-human-pr-${PULL}`);
    expect(recipe.steps).not.toContain("ask-approver-again");
  };

  scenario(
    "when it was approved, so its reviewer is asked again",
    () => {
      const fake = conflicting();
      fake.submitted.push({ author: "data-quail", state: "APPROVED", commitSha: HEAD });

      return fake;
    },
    "done",
    void 0,
    {},
    (recipe) => {
      expect(recipe.summary).toBe(
        `#${PULL}: merged main, resolved its conflicts and asked data-quail to review again`,
      );
      expect(recipe.steps).toContain("resolve");
      expect(recipe.steps).toContain("push-resolved");
      expect(recipe.steps).toContain("ask-approver-again");
      expect(recipe.pushes).toBe(1);
      expect(recipe.requested).toBe(1);
      expect(recipe.comments.some((comment) => comment.startsWith(MERGED))).toBe(true);
      expect(recipe.sessions).toHaveLength(1);
    },
  );

  scenario(
    "when it has no review, so no one is asked",
    conflicting,
    "done",
    void 0,
    {},
    (recipe) => {
      expect(recipe.summary).toBe(`#${PULL}: merged main and resolved its conflicts`);
      expect(recipe.requested).toBe(0);
    },
  );

  scenario(
    "when its latest decisive review asks for changes, so no one is asked",
    () => {
      const fake = conflicting();
      fake.submitted.push(
        { author: "data-quail", state: "APPROVED", commitSha: HEAD },
        { author: "data-quail", state: "CHANGES_REQUESTED", commitSha: HEAD },
      );

      return fake;
    },
    "done",
    void 0,
    {},
    (recipe) => {
      expect(recipe.summary).toBe(`#${PULL}: merged main and resolved its conflicts`);
      expect(recipe.requested).toBe(0);
    },
  );

  scenario(
    "when only a person can settle the conflict",
    () => {
      const fake = conflicting();
      fake.author.resolve = "needs-human";

      return fake;
    },
    "needs-human",
    void 0,
    {},
    (recipe) => {
      toPerson(recipe);
      expect(recipe.summary).toContain("the merge conflict needs a person");
      expect(recipe.pushes).toBe(0);
    },
  );

  scenario(
    "when the remote rejects the push",
    () => {
      const fake = conflicting();
      fake.git.rejects = Option.some(
        new PushRejected({ branch: `auto/issue-${ISSUE}`, reason: "! [remote rejected]" }),
      );

      return fake;
    },
    "needs-human",
    void 0,
    {},
    (recipe) => {
      toPerson(recipe);
      expect(recipe.comments.some((comment) => comment.startsWith(MERGED))).toBe(false);
    },
  );

  scenario(
    "when the merge touches humanOnlyPaths",
    () => {
      const fake = conflicting();
      fake.merge.files = ["src/a.ts", ".github/workflows/ci.yml"];

      return fake;
    },
    "needs-human",
    void 0,
    {},
    (recipe) => {
      toPerson(recipe);
      expect(recipe.pushes).toBe(0);
    },
  );

  scenario(
    "when CI is red and stays red",
    () => {
      const fake = conflicting();
      fake.merge.ci = { state: "red", failedChecks: ["test"] };

      return fake;
    },
    "needs-human",
    void 0,
    {},
    (recipe) => {
      toPerson(recipe);
      expect(recipe.comments.some((comment) => comment.startsWith(MERGED))).toBe(true);
    },
  );

  scenario(
    "when the agent fails",
    () => {
      const fake = conflicting();

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
    void 0,
    {},
    toPerson,
  );

  scenario(
    "when another run owns the pull request",
    () => {
      const fake = conflicting();
      fake.refs.set(Claims.refFor(Claims.pullRequest(PULL)), "held0000");

      return fake;
    },
    "skipped",
  );

  // A layer of an epic's stack whose layer below squash-merged into main, and
  // which GitHub moved onto main when the branch below was deleted.
  scenario(
    "when recording a squash-merged layer below leaves nothing else in conflict",
    belowSquashed,
    "done",
    void 0,
    {},
    (recipe) => {
      expect(recipe.steps).toContain("merged-below");
      expect(recipe.steps).toContain("update-from-base#resolve");
      expect(recipe.steps).not.toContain("resolve");
      expect(recipe.sessions).toEqual([]);
      expect(
        recipe.comments.some((comment) =>
          comment.includes("Recorded #2, the layer below as `main` merged it"),
        ),
      ).toBe(true);
    },
  );

  scenario(
    "when recording a squash-merged layer below leaves a merge in progress",
    () => {
      const fake = belowSquashed();
      fake.git.refuses.add("merge --no-edit origin/main");
      fake.git.says.set("diff --name-only --diff-filter=U", "a.txt\n");

      return fake;
    },
    "done",
    void 0,
    {},
    (recipe) => {
      expect(recipe.steps).toContain("resolve");
      expect(recipe.steps).not.toContain("resolve-2");
      expect(recipe.sessions).toHaveLength(1);
    },
  );

  scenario(
    "when a conflict in the base stops the record of the layer below short",
    () => {
      const fake = belowSquashed();
      fake.git.refuses.add("merge --no-edit squash1~1");
      fake.git.says.set("diff --name-only --diff-filter=U", "a.txt\n");

      return fake;
    },
    "done",
    void 0,
    {},
    (recipe) => {
      expect(recipe.steps).toContain("update-from-base#resolve-2");
      expect(recipe.steps).toContain("resolve-2");
      expect(recipe.sessions).toHaveLength(2);
    },
  );

  scenario(
    "when only a person can settle what the record of the layer below left",
    () => {
      const fake = belowSquashed();
      fake.git.refuses.add("merge --no-edit squash1~1");
      fake.git.says.set("diff --name-only --diff-filter=U", "a.txt\n");
      fake.author.resolve = "needs-human";

      return fake;
    },
    "needs-human",
    void 0,
    {},
    (recipe) => {
      toPerson(recipe);
      expect(recipe.steps).not.toContain("resolve-2");
    },
  );
});

// A layer of an epic's stack, still on the layer below: it merges that
// branch, and its push and CI are checked against it.
export const RESOLVE_CONFLICTS_LAYER_SCENARIOS = scenarios((scenario) => {
  scenario(
    "when a layer of a stack conflicts with the layer below",
    () => {
      const fake = conflicting();
      stackOn(fake, "auto/issue-2");
      fake.submitted.push({ author: "data-quail", state: "APPROVED", commitSha: HEAD });

      return fake;
    },
    "done",
    void 0,
    {},
    (recipe) => {
      expect(recipe.summary).toBe(
        `#${PULL}: merged auto/issue-2, resolved its conflicts and asked data-quail to review again`,
      );
      expect(recipe.checkedAgainst).toEqual(["auto/issue-2", "auto/issue-2"]);
    },
  );
});

const MERGE_SHA = "merge5678";
const FAILED_RUN = "https://github.com/dataquail/demo/actions/runs/41/job/42";

export const POST_MERGE_WORK_ITEM = item(`merged-${PULL}`, {
  pullRequest: PULL,
  url: `https://github.com/dataquail/demo/pull/${PULL}`,
  title: "feat: a change",
  mergeSha: MERGE_SHA,
  baseRef: "main",
  issue: ISSUE,
});

// The persona's pull request, merged a moment ago.
const mergedPull = () => {
  const fake = repoFake("approve");
  fake.states.pull = "merged";

  return fake;
};

// A merge commit whose push CI went red, with a link to the failed run.
const redMerge = () => {
  const fake = mergedPull();
  fake.commitCi.set(MERGE_SHA, {
    state: "red",
    failedChecks: ["test", "lint"],
    failedRuns: [
      { name: "test", url: FAILED_RUN, job: Option.some(42), workflowRun: Option.some(41) },
    ],
  });
  fake.logTails.set(FAILED_RUN, "error: expected 2, got 3\n```\nfenced\n```");

  return fake;
};

const WATCHED = "<!-- chernabog-post-merge-watched";

export const POST_MERGE_SCENARIOS = scenarios((scenario) => {
  const watched = (recipe: Observed) => {
    expect(recipe.steps).toContain("watch-limits");
    expect(recipe.steps).toContain("ci-1");
    expect(recipe.comments.some((comment) => comment.includes(WATCHED))).toBe(true);
    expect(recipe.ciReads[0]).toBe(MERGE_SHA);
  };

  const filedNothing = (recipe: Observed) => {
    expect(recipe.filed).toEqual([]);
    expect(recipe.steps).not.toContain("file-follow-up");
  };

  scenario("when CI on the merge commit is green", mergedPull, "done", void 0, {}, (recipe) => {
    watched(recipe);
    filedNothing(recipe);
    expect(recipe.summary).toBe(`#${PULL}: CI on merge56 is green`);
    expect(recipe.steps).not.toContain("ci-before-merge");
  });

  scenario(
    "when no CI runs on the merge commit within the grace",
    () => {
      const fake = mergedPull();
      fake.commitCi.set(MERGE_SHA, { state: "pending", waitingOn: [], failedRuns: [] });

      return fake;
    },
    "done",
    void 0,
    { noCiGrace: "0 millis" },
    (recipe) => {
      watched(recipe);
      filedNothing(recipe);
      expect(recipe.summary).toBe(
        `#${PULL}: no CI ran on merge56 within 0; taken as none for this push`,
      );
    },
  );

  scenario(
    "when CI on the merge commit stays pending past ciTimeout",
    () => {
      const fake = mergedPull();
      fake.commitCi.set(MERGE_SHA, { state: "pending", waitingOn: ["test"], failedRuns: [] });

      return fake;
    },
    "needs-human",
    void 0,
    { ciTimeout: "0 millis" },
    (recipe) => {
      watched(recipe);
      filedNothing(recipe);
      expect(recipe.summary).toContain("stayed pending for 0");
    },
  );

  scenario(
    "when CI on the merge commit is red, so a follow-up goes to implement",
    redMerge,
    "done",
    void 0,
    {},
    (recipe) => {
      watched(recipe);
      expect(recipe.steps).toContain("ci-before-merge");
      expect(recipe.steps).toContain("closes-follow-up");
      expect(recipe.steps).toContain("failure-details");
      expect(recipe.steps).toContain("file-follow-up");
      expect(recipe.filed).toHaveLength(1);
      expect(recipe.filed[0]?.[1]).toContain("error: expected 2, got 3");
      expect(recipe.filed[0]?.[1]).toContain("Also failed: lint.");
      expect(recipe.labels).toContainEqual([100, [DEFAULT_LABELS.eligible]]);
      expect(recipe.summary).toBe(`#${PULL}: CI on merge56 is red; filed #100 to fix it`);
      expect(recipe.comments.at(-1)).toContain("#100 is to fix it");
    },
  );

  scenario(
    "when CI on the merge commit is red, with no log to show",
    () => {
      const fake = redMerge();
      fake.logTails.clear();

      return fake;
    },
    "done",
    void 0,
    {},
    (recipe) => {
      expect(recipe.filed[0]?.[1]).toContain("No log to show");
    },
  );

  scenario(
    "when a run filed the follow-up before it crashed",
    () => {
      const fake = redMerge();
      fake.graph.made.set(100, {
        number: 100,
        title: `CI is red on main after #${PULL} merged`,
        body: `Filed earlier. <!-- chernabog-post-merge {"sha":"${MERGE_SHA}","pullRequest":${PULL}} -->`,
        url: "https://github.com/dataquail/demo/issues/100",
        createdAt: "2026-10-21T00:00:00Z",
        labels: [DEFAULT_LABELS.eligible],
        assignees: [],
        state: "open",
      });
      fake.graph.next = 101;

      return fake;
    },
    "done",
    void 0,
    {},
    (recipe) => {
      expect(recipe.filed).toHaveLength(1);
      expect(recipe.summary).toBe(`#${PULL}: CI on merge56 is red; filed #100 to fix it`);
    },
  );

  scenario(
    "when the merge was a follow-up's fix, so the follow-up goes to a person",
    () => {
      const fake = redMerge();
      fake.issueText.body = `<!-- chernabog-post-merge {"sha":"older123","pullRequest":5} -->`;

      return fake;
    },
    "done",
    void 0,
    {},
    (recipe) => {
      expect(recipe.labels).toContainEqual([100, [DEFAULT_LABELS.needsHuman]]);
      expect(recipe.filed[0]?.[1]).toContain(`was the fix for #${ISSUE}`);
      expect(recipe.summary).toBe(
        `#${PULL}: CI on merge56 is red after a follow-up's fix; filed #100 for a person`,
      );
      expect(recipe.comments.at(-1)).toContain("#100 is for a person");
    },
  );

  scenario(
    "when CI was already red before the merge",
    () => {
      const fake = redMerge();
      fake.commitCi.set(fake.merged.parent, { state: "red", failedChecks: [], failedRuns: [] });

      return fake;
    },
    "done",
    void 0,
    {},
    (recipe) => {
      filedNothing(recipe);
      expect(recipe.steps).toContain("ci-before-merge");
      expect(recipe.summary).toBe(
        `#${PULL}: CI on merge56 is red, as it already was before the merge; filed nothing`,
      );
    },
  );
});

// The issue a person names with chernabog start, as Hybrid.itemFor finds it.
export const HUMAN_INITIATED_WORK_ITEM = item(`issue-${ISSUE}`, { issue: ISSUE });

const started = () => repoFake("approve", POOL);

// The issue's branch, and the claim marker of the run that left it.
const startedEarlier = (claim: Parameters<typeof claimMarker.write>[0]) => {
  const fake = started();
  fake.existing.branch = true;
  fake.comment(claimMarker.write(claim));

  return fake;
};

const EARLIER_CLAIM = {
  runId: "an-earlier-run",
  claimedAt: "2026-10-20T00:00:00Z",
  branch: `auto/issue-${ISSUE}`,
};

export const HUMAN_INITIATED_SCENARIOS = scenarios((scenario) => {
  scenario("when the person and the agent are done", started, "done", void 0, {}, (recipe) => {
    expect(recipe.summary).toBe(
      `#${ISSUE}: https://github.com/dataquail/demo/pull/${PULL} is ready for review; a person merges`,
    );
    expect(recipe.pullLabels).toContain(DEFAULT_LABELS.hybrid);
    expect(recipe.requested).toBe(1);
    // One session, the person's.
    expect(recipe.sessions.map(([, , withPerson]) => withPerson)).toEqual([true]);
  });

  scenario(
    "when the person closes the session before open-pr",
    () => {
      const fake = started();
      fake.author.closes = true;

      return fake;
    },
    "failed",
    void 0,
    {},
    (recipe) => {
      expect(recipe.summary).toContain("the person closed the session");
      expect(recipe.issueLabels).toEqual([DEFAULT_LABELS.inProgress]);
    },
  );

  scenario(
    "when another run holds the claim",
    () => {
      const fake = started();
      fake.refs.set(Claims.refFor(Claims.issue(ISSUE)), "held0000");

      return fake;
    },
    "skipped",
  );

  scenario(
    "when an earlier start left the issue's branch",
    () => startedEarlier({ ...EARLIER_CLAIM, withPerson: true }),
    "done",
  );

  scenario(
    "when an earlier unattended run left the issue's branch",
    () => startedEarlier(EARLIER_CLAIM),
    "skipped",
    void 0,
    {},
    (recipe) => {
      expect(recipe.summary).toContain("already claimed by an unattended run");
    },
  );

  // Before the session, a failure fails the run rather than going to a person.
  scenario(
    "when the worktree's install fails",
    started,
    "failed",
    void 0,
    { install: "exit 3" },
    (recipe) => {
      expect(recipe.issueLabels).not.toContain(DEFAULT_LABELS.needsHuman);
      expect(recipe.sessions).toEqual([]);
    },
  );

  scenario(
    "when the local gate keeps failing",
    started,
    "needs-human",
    void 0,
    { localGate: ["exit 3"], localGateRounds: 1 },
    (recipe) => {
      expect(recipe.pushes).toBe(0);
      expect(recipe.issueLabels).toContain(DEFAULT_LABELS.needsHuman);
    },
  );

  scenario(
    "when nothing was committed before open-pr",
    () => {
      const fake = started();
      fake.git.nothingAhead = true;

      return fake;
    },
    "needs-human",
    void 0,
    {},
    (recipe) => {
      expect(recipe.summary).toContain(
        `nothing was committed on auto/issue-${ISSUE} before open-pr`,
      );
      expect(recipe.issueLabels).toContain(DEFAULT_LABELS.needsHuman);
    },
  );

  scenario(
    "when the person left their work uncommitted",
    () => {
      const fake = started();
      fake.author.leaves.push("?? a.ts");

      return fake;
    },
    "needs-human",
    void 0,
    {},
    (recipe) => {
      expect(recipe.summary).toContain("left uncommitted: `a.ts`");
    },
  );

  scenario(
    "when the remote rejects the push",
    () => {
      const fake = started();
      fake.git.rejects = Option.some(
        new PushRejected({
          branch: `auto/issue-${ISSUE}`,
          reason: "! [remote rejected]",
          missingScope: "workflow",
        }),
      );

      return fake;
    },
    "needs-human",
    void 0,
    {},
    (recipe) => {
      expect(recipe.opened).toBe(false);
      expect(recipe.issueLabels).toContain(DEFAULT_LABELS.needsHuman);
    },
  );

  scenario(
    "when a change to humanOnlyPaths was made in front of the person",
    () => {
      const fake = started();
      fake.merge.files = ["src/a.ts", ".github/workflows/ci.yml"];

      return fake;
    },
    "done",
  );

  scenario(
    "when CI is red and stays red",
    () => {
      const fake = started();
      fake.merge.ci = { state: "red", failedChecks: ["test"] };

      return fake;
    },
    "needs-human",
    void 0,
    {},
    (recipe) => {
      expect(recipe.summary).toContain("CI is still red after 3 fix attempts");
      // Each fix, from the person's session, pushed.
      expect(recipe.pushes).toBe(4);
      expect(recipe.sessions.every(([, , withPerson]) => withPerson === true)).toBe(true);
    },
  );

  scenario(
    "when CI stays pending past ciTimeout",
    () => {
      const fake = started();
      fake.merge.ci = { state: "pending", waitingOn: ["test"] };

      return fake;
    },
    "needs-human",
    void 0,
    { ciTimeout: "0 millis" },
  );
});

export const PLAN_WORK_ITEM = item(`issue-${ISSUE}`, { issue: ISSUE, label: Plan.LABELS.plan });

const task = (key: string, kind: string, blockedBy: ReadonlyArray<string> = []) => ({
  key,
  title: `Do ${key}`,
  body: `What ${key} is.`,
  kind,
  blockedBy: [...blockedBy],
});

const PLAN: Json = {
  status: "plan",
  summary: "The schema first, then the API on it; the name is a person's.",
  nodes: [
    task("api-schema", "auto"),
    task("api", "hybrid", ["api-schema"]),
    task("pick-name", "human"),
  ],
};

const QUESTIONS: Json = {
  status: "needs-clarification",
  summary: "The spec has no acceptance criteria.",
  nodes: [],
  questions: "1. What does done look like?",
};

// A spec queued with auto:plan, and the agent's answers to its plan steps in turn.
const specWith =
  (...plans: ReadonlyArray<Json>) =>
  () => {
    const fake = repoFake("approve");
    fake.setLabels(ISSUE, [Plan.LABELS.plan]);

    for (const answer of plans) {
      fake.plans.push(answer);
    }

    return fake;
  };

// A person's answers to each plan the run posts, as it parks on each.
const personAnswers = (...changes: Parks["changes"]): Parks => ({ signal: "approved", changes });

const approve = (fake: Fake) => {
  fake.setLabels(ISSUE, [...fake.labelsOf(ISSUE), Plan.LABELS.approved]);
};

const askFor = (change: string) => (fake: Fake) => {
  fake.comment(change, "zach");
};

export const PLAN_SCENARIOS = scenarios((scenario) => {
  scenario(
    "when a person approves the plan",
    specWith(PLAN),
    "done",
    personAnswers(approve),
    {},
    (recipe) => {
      expect(recipe.summary).toBe(`#${ISSUE}: an epic of 4 sub-issues`);
      expect(recipe.filed).toHaveLength(4);
      expect(recipe.issueLabels).toEqual([Plan.LABELS.epic]);
      expect(recipe.steps).toContain(`clean-up-${Plan.planCheckout(ISSUE)}`);
    },
  );

  scenario(
    "when a person asks for changes, and approves the plan drafted again",
    specWith(PLAN, { ...PLAN, nodes: [task("api-schema", "auto")] }),
    "done",
    personAnswers(askFor("Leave the API for later."), approve),
    {},
    (recipe) => {
      expect(recipe.steps).toContain("changes-asked-1");
      expect(recipe.steps).toContain("draft-plan-2");
      expect(recipe.steps).toContain("propose-plan-2");
      expect(recipe.filed).toHaveLength(2);
    },
  );

  scenario(
    "when the plan fails its checks, and the agent fixes it",
    specWith({ ...PLAN, nodes: [task("a", "auto", ["b"]), task("b", "auto", ["a"])] }, PLAN),
    "done",
    personAnswers(approve),
    {},
    (recipe) => {
      expect(recipe.steps).toContain("fix-plan-1-1");
      expect(recipe.steps).not.toContain("fix-plan-1-2");
    },
  );

  scenario(
    "when the plan still fails its checks after planRounds attempts to fix it",
    specWith({ ...PLAN, nodes: [task("verify", "auto")] }),
    "needs-human",
    void 0,
    {},
    (recipe) => {
      expect(recipe.steps).toContain("fix-plan-1-2");
      expect(recipe.summary).toContain("still fails its checks after 2 attempts");
      expect(recipe.issueLabels).toEqual([DEFAULT_LABELS.needsHuman]);
      expect(recipe.filed).toEqual([]);
    },
  );

  scenario(
    "when the agent has questions",
    specWith(QUESTIONS),
    "needs-human",
    void 0,
    {},
    (recipe) => {
      expect(recipe.issueLabels).toEqual([DEFAULT_LABELS.needsClarification]);
      expect(recipe.comments.at(-1)).toContain("1. What does done look like?");
    },
  );

  scenario(
    "when the agent has questions about the changes a person asked for",
    specWith(PLAN, QUESTIONS),
    "needs-human",
    personAnswers(askFor("Split the API by resource.")),
    {},
    (recipe) => {
      expect(recipe.steps).toContain("draft-plan-2");
      expect(recipe.issueLabels).toEqual([DEFAULT_LABELS.needsClarification]);
    },
  );

  scenario(
    "when the agent's answer isn't a plan",
    specWith(),
    "needs-human",
    void 0,
    {},
    (recipe) => {
      expect(recipe.summary).toContain("draft-plan-1: agent answer");
      expect(recipe.issueLabels).toEqual([DEFAULT_LABELS.needsHuman]);
    },
  );

  scenario(
    "when the agent fails",
    () => {
      const fake = specWith(PLAN)();

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
    void 0,
    {},
    (recipe) => {
      expect(recipe.issueLabels).toEqual([DEFAULT_LABELS.needsHuman]);
    },
  );

  scenario(
    "when another run holds the claim",
    () => {
      const fake = specWith(PLAN)();
      fake.refs.set(Claims.refFor(Claims.issue(ISSUE)), "held0000");

      return fake;
    },
    "skipped",
  );

  // Before the claim, a failure fails the run rather than going to a person.
  scenario(
    "when the base branch is gone",
    () => {
      const fake = specWith(PLAN)();
      fake.remote.gone.add("main");

      return fake;
    },
    "failed",
    void 0,
    {},
    (recipe) => {
      expect(recipe.issueLabels).not.toContain(DEFAULT_LABELS.needsHuman);
    },
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

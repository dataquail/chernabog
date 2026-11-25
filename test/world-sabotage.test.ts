// The world is input, never record (ADR 21, epic #557). Each bundled recipe
// and its document twin runs an item to each of its parks; then everything
// chernabog wrote on GitHub, every status label and every comment of its own,
// is deleted, or separately edited, and the item is taken up again, to the
// end of its run, or an epic's to its next park. The records and
// the outcome are the untouched run's, and once projected again so are the
// labels: nothing chernabog reads back from GitHub is a record of what it
// did. The same holds when the labels and comments change while a run is in
// the middle of a phase, as its agent works.

import {
  type CiReport,
  type CiState,
  DEFAULT_LABELS,
  Epic,
  type Flow,
  Implement,
  type Json,
  type LinkedIssue,
  parseJson,
  Plan,
  printJson,
  PullRequest,
  reviewMarker,
  StatusLabels,
  type WorkItem,
} from "@chernabog/sdk";
import type { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import addressReview from "../packages/recipes/flows/address-review.ts";
import epic from "../packages/recipes/flows/epic.ts";
import implement from "../packages/recipes/flows/implement.ts";
import plan from "../packages/recipes/flows/plan.ts";
import postMerge from "../packages/recipes/flows/post-merge.ts";
import reReview from "../packages/recipes/flows/re-review.ts";
import resolveConflicts from "../packages/recipes/flows/resolve-conflicts.ts";
import review from "../packages/recipes/flows/review.ts";
import { mayStart } from "../src/modules/runs/domain/run/work-item.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import {
  ADDRESS_REVIEW_DOCUMENT,
  documentOf,
  EPIC_DOCUMENT,
  IMPLEMENT_DOCUMENT,
  loadFlow,
  PLAN_DOCUMENT,
  POST_MERGE_DOCUMENT,
  RE_REVIEW_DOCUMENT,
  RESOLVE_CONFLICTS_DOCUMENT,
  REVIEW_DOCUMENT,
} from "./compose-harness.ts";
import { effect } from "./effect-test.ts";
import {
  type EngineRun,
  type Fake,
  flowTriggered,
  HEAD,
  ISSUE,
  item,
  makeFake,
  onFake,
  PULL,
  repo,
  type RuntimeServices,
  runToEnd,
  runUntil,
  summaryOf,
} from "./sdk-fakes.ts";

// Each journey runs the engine three or four times; under the whole suite's
// load its runner can miss health checks for seconds, as the park tests' do.
const ENGINE_TIMEOUT = 120_000;

const POOL = { reviewers: ["zach", "data-quail"] };
const PULL_URL = `https://github.com/dataquail/demo/pull/${PULL}`;
const SHIP = "auto:ship";
const RED: CiState = { state: "red", failedChecks: ["test"] };
const GREEN: CiState = { state: "green" };
const PENDING: CiState = { state: "pending", waitingOn: ["test"] };
const HOLDING = { holdMergesOnBrokenBase: true, mergeHoldTimeout: "1 day" };
const MERGE = "merge5678";
const MERGE_CI_SETTLED = "merge-ci-settled";
const EPIC = 40;

// Every status label: what the projector writes, and so what chernabog wrote.
const STATUS = StatusLabels.statusOf(StatusLabels.DEFAULT_NAMES);

// Whether the run waits on `signal`, under `deferred` when it names one.
const waitsOn =
  (signal: string, deferred: Option.Option<string> = Option.none()) =>
  (run: EngineRun) =>
    Effect.map(listRunWaitsHandler({ runId: run.id, signal }), ({ waits }) =>
      waits.some((wait) =>
        Option.match(deferred, {
          onNone: () => true,
          onSome: (named) => wait.deferred === `${signal}:${named}`,
        }),
      ),
    );

// One park of one recipe, and of its document: the world a run starts in,
// the item it runs on, when it has parked, and what changes in the world so
// that a later run takes the item up again.
type Park = {
  readonly site: string;
  readonly flow: string;
  readonly recipe: Flow;
  readonly document: string;
  readonly world: () => Fake;
  readonly work: WorkItem;
  readonly parked: (
    run: EngineRun,
  ) => Effect.Effect<boolean, never, RuntimeServices | BunServices.BunServices>;
  readonly settle: (fake: Fake) => void;
  // How far the run that takes the item up again goes: to its end, unless the
  // flow can't end there, as an epic whose tasks' pull requests aren't merged
  // parks again.
  readonly resumed?: (
    run: EngineRun,
  ) => Effect.Effect<boolean, never, RuntimeServices | BunServices.BunServices>;
  // The issues and pull requests whose labels the journey looks at.
  readonly numbers: ReadonlyArray<number>;
  readonly repo?: typeof repo;
  readonly settings?: { readonly [key: string]: Json };
  // Whether an agent works in the phase before the park, the middle of
  // which the sabotage lands in; a park reached without one has none.
  readonly agent: boolean;
};

// A person's pull request closes the issue, as GitHub's GraphQL API gives it.
const withPull = (fake: Fake, draft: boolean) => {
  fake.setLabels(PULL, []);
  fake.git.opened = true;
  fake.authored.headRef = "zach/fix-it";
  fake.authored.author = "zach";
  fake.authored.draft = draft;
  fake.closing.push({
    number: PULL,
    url: PULL_URL,
    state: "OPEN",
    isDraft: draft,
    headRefName: "zach/fix-it",
    baseRefName: "main",
    isCrossRepository: false,
  });

  return fake;
};

// A pull request this persona wrote, whose latest review, by data-quail,
// asks for changes on HEAD.
const changesAsked = () => {
  const fake = makeFake("approve", { ciJob: true });
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
  fake.handedOff({
    adapter: "claude",
    sessionId: "implement-session",
    issue: ISSUE,
    branch: "auto/issue-3",
  });
  fake.git.pushes = 1;

  return fake;
};

const task = (key: string, kind: string, blockedBy: ReadonlyArray<string> = []) => ({
  key,
  title: `Do ${key}`,
  body: `What ${key} is.`,
  kind,
  blockedBy: [...blockedBy],
});

const PLAN: Json = {
  status: "plan",
  summary: "The schema first, then the API on it.",
  nodes: [task("api-schema", "auto"), task("api", "hybrid", ["api-schema"])],
};

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

// A repo whose config.yaml holds merges on a red base.
const holding: typeof repo = {
  ...repo,
  personas: Arr.map(repo.personas, (persona) => ({ ...persona, shared: HOLDING })),
};

const green = (fake: Fake) => {
  fake.merge.ci = GREEN;
  fake.merge.afterPush = Option.none();
};

const PARKS: ReadonlyArray<Park> = [
  {
    site: "CI on the pull request its run opened",
    agent: true,
    flow: "implement",
    recipe: implement,
    document: IMPLEMENT_DOCUMENT,
    world: () => {
      const fake = makeFake("approve", { ...POOL, ciJob: true });
      fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
      fake.merge.ci = PENDING;

      return fake;
    },
    work: item(`issue-${ISSUE}`, { issue: ISSUE }),
    parked: waitsOn(Implement.CI_SETTLED),
    settle: green,
    numbers: [ISSUE, PULL],
  },
  {
    site: "CI on a pull request it adopted",
    agent: false,
    flow: "implement",
    recipe: implement,
    document: IMPLEMENT_DOCUMENT,
    world: () => {
      const fake = withPull(makeFake("approve", { ...POOL, ciJob: true }), false);
      fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
      fake.merge.ci = PENDING;

      return fake;
    },
    work: item(`issue-${ISSUE}`, { issue: ISSUE }),
    parked: waitsOn(Implement.CI_SETTLED, Option.some("ci-1")),
    settle: green,
    numbers: [ISSUE, PULL],
  },
  {
    site: "an adopted draft its author marks ready",
    agent: false,
    flow: "implement",
    recipe: implement,
    document: IMPLEMENT_DOCUMENT,
    world: () => {
      const fake = withPull(makeFake("approve", { ...POOL, ciJob: true }), true);
      fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);

      return fake;
    },
    work: item(`issue-${ISSUE}`, { issue: ISSUE }),
    parked: waitsOn("ready", Option.some(`draft-${PULL}`)),
    settle: (fake) => {
      fake.authored.draft = false;
      fake.closing.splice(0, fake.closing.length, {
        number: PULL,
        url: PULL_URL,
        state: "OPEN",
        isDraft: false,
        headRefName: "zach/fix-it",
        baseRefName: "main",
        isCrossRepository: false,
      });
    },
    numbers: [ISSUE, PULL],
  },
  {
    site: "a person's answer to the plan",
    agent: true,
    flow: "plan",
    recipe: plan,
    document: PLAN_DOCUMENT,
    world: () => {
      const fake = makeFake("approve", { ciJob: true });
      fake.setLabels(ISSUE, [Plan.LABELS.plan]);
      fake.plans.push(PLAN);

      return fake;
    },
    work: item(`issue-${ISSUE}`, { issue: ISSUE, label: Plan.LABELS.plan }),
    parked: waitsOn("approved", Option.some("plan-1")),
    settle: (fake) => {
      fake.setLabels(ISSUE, [...fake.labelsOf(ISSUE), Plan.LABELS.approved]);
    },
    numbers: [ISSUE],
  },
  {
    site: "CI on the fix it pushed",
    agent: true,
    flow: "address-review",
    recipe: addressReview,
    document: ADDRESS_REVIEW_DOCUMENT,
    world: () => {
      const fake = changesAsked();
      fake.merge.afterPush = Option.some(PENDING);

      return fake;
    },
    work: item(`pr-${PULL}-changes-1`, {
      pullRequest: PULL,
      headRef: "auto/issue-3",
      agentWritten: true,
      reviewer: "data-quail",
      reviewedSha: HEAD,
    }),
    parked: waitsOn(Implement.CI_SETTLED),
    settle: green,
    numbers: [ISSUE, PULL],
  },
  {
    site: "CI on the merge it pushed",
    agent: true,
    flow: "resolve-conflicts",
    recipe: resolveConflicts,
    document: RESOLVE_CONFLICTS_DOCUMENT,
    world: () => {
      const fake = makeFake("approve");
      fake.setLabels(PULL, []);
      fake.merge.state = "dirty";
      fake.recordPhase(`pr-${PULL}`, "review-asked");
      fake.merge.afterPush = Option.some(PENDING);

      return fake;
    },
    work: item(`pr-${PULL}-${HEAD.slice(0, 7)}`, {
      pullRequest: PULL,
      headRef: "auto/issue-3",
      baseRef: "main",
    }),
    parked: waitsOn(Implement.CI_SETTLED, Option.some("ci-1#resolve")),
    settle: green,
    numbers: [PULL],
  },
  {
    site: "push CI on the merge commit",
    agent: false,
    flow: "post-merge",
    recipe: postMerge,
    document: POST_MERGE_DOCUMENT,
    world: () => {
      const fake = makeFake("approve", { ciJob: true });
      fake.states.pull = "merged";
      fake.commitCi.set(MERGE, { state: "pending", waitingOn: ["test"], failedRuns: [] });

      return fake;
    },
    work: item(`merged-${PULL}`, {
      pullRequest: PULL,
      url: PULL_URL,
      title: "feat: a change",
      mergeSha: MERGE,
      baseRef: "main",
    }),
    parked: waitsOn(MERGE_CI_SETTLED, Option.some("merge-ci")),
    settle: (fake) => {
      const settled: CiReport = { state: "green", failedRuns: [] };
      fake.commitCi.set(MERGE, settled);
    },
    numbers: [ISSUE, PULL],
  },
  {
    site: "a merge held for a red base, by review",
    agent: true,
    flow: "review",
    recipe: review,
    document: REVIEW_DOCUMENT,
    world: () => {
      const fake = makeFake("approve", { ciJob: true });
      fake.setLabels(PULL, [DEFAULT_LABELS.needsReview, SHIP]);
      fake.merge.baseCi = Option.some(RED);

      return fake;
    },
    work: item(`pr-${PULL}`, {
      pullRequest: PULL,
      headRef: `auto/issue-${ISSUE}`,
      agentWritten: true,
    }),
    parked: waitsOn(PullRequest.BASE_GREEN),
    settle: (fake) => {
      fake.merge.baseCi = Option.some(GREEN);
    },
    numbers: [PULL],
    repo: holding,
    settings: HOLDING,
  },
  {
    site: "a merge held for a red base, by re-review",
    // Its agent reviews before chernabog has written anything on the pull
    // request, so there is nothing to sabotage in the middle of the phase.
    agent: false,
    flow: "re-review",
    recipe: reReview,
    document: RE_REVIEW_DOCUMENT,
    world: () => {
      const fake = makeFake("approve", { ciJob: true });
      fake.people.me = "data-quail";
      fake.people.requested = ["data-quail"];
      fake.setLabels(PULL, [SHIP]);
      fake.rechecked.findings = [
        { finding: "Mention the change", remediated: true, blocking: true },
      ];
      fake.recordReview(
        {
          sha: HEAD,
          round: 1,
          verdict: "request-changes",
          reviewer: "data-quail",
          sessionId: "earlier-session",
          adapter: "claude",
        },
        "review-asked-again",
      );
      fake.merge.baseCi = Option.some(RED);

      return fake;
    },
    work: item(`pr-${PULL}-review-2`, {
      pullRequest: PULL,
      headRef: "auto/issue-3",
      agentWritten: true,
    }),
    parked: waitsOn(PullRequest.BASE_GREEN),
    settle: (fake) => {
      fake.merge.baseCi = Option.some(GREEN);
    },
    numbers: [PULL],
    repo: holding,
    settings: HOLDING,
  },
  {
    site: "the epic between rounds",
    agent: true,
    flow: "epic",
    recipe: epic,
    document: EPIC_DOCUMENT,
    world: () => {
      const fake = makeFake("approve", { ciJob: true });
      fake.graph.made.set(EPIC, madeIssue(EPIC, "An epic"));
      fake.setLabels(EPIC, [Plan.LABELS.epic]);

      for (const [number, blockedBy] of [
        [10, []],
        [11, [10]],
        [12, []],
      ] as const) {
        fake.graph.made.set(number, madeIssue(number, `Task ${number}`));
        fake.setLabels(number, [DEFAULT_LABELS.eligible]);
        fake.graph.blockedBy.set(number, [...blockedBy]);
        fake.graph.subIssues.set(EPIC, [...(fake.graph.subIssues.get(EPIC) ?? []), number]);
      }

      // #12's agent answers with questions, so the epic parks on it.
      fake.author.asks.push("/tmp/demo-worktrees/auto/issue-12");

      return fake;
    },
    work: item(`issue-${EPIC}`, { issue: EPIC }),
    // Its rounds take the tasks it can as far as they go, then it parks: #10
    // and #12 in its first, #11 once #10 is done in its second, and nothing
    // left to start in its third.
    parked: waitsOn(Epic.LAYER_CHANGED, Option.some("epic-3")),
    // A person answers #12 and queues it again.
    settle: (fake) => {
      fake.setLabels(12, [DEFAULT_LABELS.eligible]);
    },
    // The new run counts its rounds afresh: #12 in its first, then nothing
    // left to start, and no pull request merged for the epic to finish.
    resumed: waitsOn(Epic.LAYER_CHANGED, Option.some("epic-2")),
    numbers: [EPIC, 10, 11, 12, PULL],
  },
];

// Whether chernabog wrote `comment`: as the persona, or as the fake's GitHub
// writes every comment, its bot.
const ours = (fake: Fake, comment: Fake["comments"][number]) =>
  comment.author === fake.people.me || comment.author === "chernabog-bot";

// A person deletes every status label, and every comment the persona wrote.
// How many labels and comments it deleted.
const deleteEverything = (fake: Fake, numbers: ReadonlyArray<number>) => {
  let deleted = 0;

  for (const number of numbers) {
    const kept = fake.labelsOf(number).filter((label) => !STATUS.includes(label));
    deleted += fake.labelsOf(number).length - kept.length;
    fake.setLabels(number, kept);
  }

  const kept = fake.comments.filter((comment) => !ours(fake, comment));
  deleted += fake.comments.length - kept.length;
  fake.comments.splice(0, fake.comments.length, ...kept);

  return deleted;
};

// A marker's facts a person rewrote.
const MARKER = /<!-- (chernabog-[\w-]+) \{.*?\} -->/g;

// A person edits everything chernabog wrote: each item shows every status
// label it didn't and none it did, and every comment of the persona's says
// something else, its markers' facts rewritten. Every item's labels change,
// so it always edits something.
const editEverything = (fake: Fake, numbers: ReadonlyArray<number>) => {
  for (const number of numbers) {
    const had = fake.labelsOf(number);

    fake.setLabels(number, [
      ...had.filter((label) => !STATUS.includes(label)),
      ...STATUS.filter((label) => !had.includes(label)),
    ]);
  }

  fake.comments.forEach((comment, index) => {
    if (ours(fake, comment)) {
      fake.comments[index] = {
        ...comment,
        body: `A person rewrote this.\n\n${comment.body.replaceAll(MARKER, '<!-- $1 {"edited":true} -->')}`,
      };
    }
  });

  return numbers.length;
};

type Sabotage = {
  readonly how: "delete" | "edit";
  readonly when: "at the park" | "mid-phase";
};

const SABOTEURS = { delete: deleteEverything, edit: editEverything };

const sabotage = (fake: Fake, park: Park, how: Sabotage["how"]) =>
  SABOTEURS[how](fake, park.numbers);

// Data that is no record of what chernabog did: when a wait began, which
// two journeys run at different times, and a plan's `after`, the newest
// comment before the plan's, a cursor into the comments its answers are read
// from. A comment of chernabog's deleted before the plan was posted moves the
// cursor back, and the answers read after it are the same.
const VOLATILE = ["since", "after"];

// A record, without when it was written or when its wait began: two journeys
// run at different times.
const comparable = (fake: Fake) =>
  Object.fromEntries(
    [...fake.records()].map(([name, found]) => [
      name,
      {
        phase: `${found.phase}`,
        from: Option.getOrNull(Option.map(found.from, (phase) => `${phase}`)),
        by: `${found.by}`,
        data: Option.getOrNull(
          Option.map(found.data, (data) =>
            Object.fromEntries(Object.entries(data).filter(([key]) => !VOLATILE.includes(key))),
          ),
        ),
        blobs: found.blobs,
      },
    ]),
  );

const statusLabels = (fake: Fake, numbers: ReadonlyArray<number>) =>
  Object.fromEntries(
    numbers.map((number) => [
      number,
      fake
        .labelsOf(number)
        .filter((label) => STATUS.includes(label))
        .toSorted(),
    ]),
  );

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// `value` with each run's and session's random id named by the order it
// first appears in: two journeys' runs are the same runs by other ids.
const withoutIds = (value: Json): Json => {
  const named = new Map<string, string>();

  return Option.getOrThrow(
    parseJson(
      printJson(value).replaceAll(UUID, (id) => {
        const known = named.get(id) ?? `id-${named.size + 1}`;
        named.set(id, known);

        return known;
      }),
    ),
  );
};

// Runs `park` with `flow` to its park, as a run ending there does, then on
// from the item its trigger offers once the world settles, as far as
// `park.resumed` says, sabotaged as `sabotaged` says. What it recorded and
// where it got to.
const journey = (park: Park, flow: Flow, sabotaged: Option.Option<Sabotage>) =>
  Effect.gen(function* () {
    const fake = park.world();
    let touched = 0;
    const handle = flowHandle(park.repo ?? repo, park.flow, flow);

    for (const done of Option.toArray(
      Option.filter(sabotaged, (one) => one.when === "mid-phase"),
    )) {
      fake.agent.during.push(() => {
        touched += sabotage(fake, park, done.how);
      });
    }

    let parked = false;

    const parkedRun = yield* runUntil(handle, fake, park.work, (run) =>
      Effect.map(park.parked(run), (found) => {
        parked = found;

        return found;
      }),
    );

    expect([parkedRun.status, parked]).toEqual(["running", true]);
    fake.refs.clear();
    const atPark = comparable(fake);

    for (const done of Option.toArray(
      Option.filter(sabotaged, (one) => one.when === "at the park"),
    )) {
      touched += sabotage(fake, park, done.how);
    }

    // A sabotage that found nothing chernabog wrote would prove nothing.
    expect(touched > 0).toBe(Option.isSome(sabotaged));
    park.settle(fake);

    const offered = yield* flowTriggered(fake, flow, park.settings ?? {}).pipe(Effect.orDie);
    const taken = yield* Effect.fromOption(Arr.findFirst(offered, mayStart)).pipe(Effect.orDie);

    const finished = yield* Option.match(Option.fromUndefinedOr(park.resumed), {
      onNone: () => runToEnd(handle, fake, taken),
      onSome: (resumed) => runUntil(handle, fake, taken, resumed),
    });

    // Labels projected again, as the next projection of each item would.
    for (const number of park.numbers) {
      yield* onFake(
        fake,
        StatusLabels.projectItem(
          Option.match(
            Option.liftPredicate(number, (one) => one === PULL),
            {
              onNone: () => `issue-${number}`,
              onSome: (pull) => `pr-${pull}`,
            },
          ),
        ),
      );
    }

    return withoutIds({
      atPark,
      offered: taken.key,
      status: finished.status,
      summary: summaryOf(finished),
      records: comparable(fake),
      labels: statusLabels(fake, park.numbers),
    });
  });

const SABOTAGES: ReadonlyArray<Sabotage> = [
  { how: "delete", when: "at the park" },
  { how: "edit", when: "at the park" },
  { how: "delete", when: "mid-phase" },
  { how: "edit", when: "mid-phase" },
];

for (const park of PARKS) {
  const forms = [
    ["recipe", Effect.succeed(park.recipe)],
    ["document", loadFlow(documentOf(park.document))],
  ] as const;

  for (const [form, loading] of forms) {
    describe(`${park.flow}'s ${form}, parked on ${park.site}`, () => {
      for (const done of SABOTAGES.filter((one) => park.agent || one.when === "at the park")) {
        effect(
          `a person who ${done.how}s every label and comment chernabog wrote, ${done.when}, changes nothing but the labels`,
          () =>
            Effect.gen(function* () {
              const flow = yield* loading;
              const untouched = yield* journey(park, flow, Option.none());
              const sabotaged = yield* journey(park, flow, Option.some(done));

              expect(sabotaged).toEqual(untouched);
            }),
          ENGINE_TIMEOUT,
        );
      }
    });
  }
}

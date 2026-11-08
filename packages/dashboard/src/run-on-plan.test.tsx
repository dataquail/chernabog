// A run drawn on its plan, on its page: a running, a finished, a parked and a
// failed run of the review document, each node with its state, its time and
// its link; a repeat on its latest round and on a past one; a forEach's lanes
// and its template lane; a run with no plan on its history graph, as before;
// and a node's page, with its block, its outcome, its time and the logs of
// exactly its own engine steps.

import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { it } from "effect-bun-test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DaemonStatus,
  FlowPlan,
  FoundPlan,
  RunEnteredNode,
  RunHistory,
  RunReachedEnd,
  RunReply,
  RunTookBranch,
} from "#daemon/protocol";

import { DOCUMENT_PLANS } from "./document-plans.ts";
import { nodeHref, type NodePlace } from "./routes.ts";
import { type Detail, loadDetail, refetchesFor } from "./run.ts";
import { RunDetailView } from "./run-detail.tsx";
import { type LogState, runLogFeed } from "./run-log.ts";

const RunView = DaemonStatus.fields.recent.value;
const RunId = RunView.fields.id;
const NodeRef = RunHistory.fields.nodes.schema.value.fields.node;

const ID = "5714245a-211c-4f0d-8ce1-74b725bac0d6";

const at = (seconds: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 10, 8, 14, 0, seconds)));

const REVIEW = Schema.decodeUnknownSync(FlowPlan)(DOCUMENT_PLANS.review);

// A repeat whose body checks CI, ending on green, else going round again.
const LOOP = Schema.decodeSync(FlowPlan)({
  flow: "loop",
  subject: "pull-request",
  hash: "loop-hash",
  steps: [
    {
      id: "rounds",
      path: "steps[0]",
      kind: "repeat",
      state: {},
      steps: [
        {
          id: "check",
          path: "steps[0].repeat.steps[0]",
          kind: "use",
          block: "ci.check",
          in: { pr: "trigger.pr" },
          with: {},
          branches: [
            {
              outcome: "green",
              steps: [
                {
                  id: "steps[0].repeat.steps[0].on.green.steps[0]",
                  path: "steps[0].repeat.steps[0].on.green.steps[0]",
                  kind: "end",
                  end: "done",
                },
              ],
            },
          ],
        },
        { id: "again", path: "steps[0].repeat.steps[1]", kind: "next", next: {} },
      ],
    },
  ],
});

// A forEach whose lanes each build a task.
const LANES = Schema.decodeSync(FlowPlan)({
  flow: "lanes",
  subject: "epic",
  hash: "lanes-hash",
  steps: [
    {
      id: "tasks",
      path: "steps[0]",
      kind: "forEach",
      forEach: "plan.tasks",
      as: "task",
      scope: "epic.task",
      atOnce: "2",
      steps: [
        {
          id: "build",
          path: "steps[0].steps[0]",
          kind: "use",
          block: "task.build",
          in: { task: "task" },
          with: {},
          branches: [],
        },
      ],
    },
  ],
});

type Where = { readonly round?: number; readonly lane?: string };

const ref = (id: string, where: Where = {}) => ({ id, ...where });

const visit = (
  id: string,
  from: number,
  ended: Option.Option<[number, Outcome]>,
  where?: Where,
) => ({
  node: ref(id, where),
  enteredAt: at(from),
  ...Option.match(ended, {
    onNone: () => ({}),
    onSome: ([to, outcome]) => ({ finishedAt: at(to), outcome }),
  }),
});

const step = (
  name: string,
  from: number,
  ended: Option.Option<[number, Outcome]>,
  node: Option.Option<{ readonly id: string } & Where>,
) => ({
  step: name,
  enteredAt: at(from),
  ...Option.match(node, { onNone: () => ({}), onSome: (found) => ({ node: found }) }),
  ...Option.match(ended, {
    onNone: () => ({}),
    onSome: ([to, outcome]) => ({ finishedAt: at(to), outcome }),
  }),
});

type Outcome = "ok" | "failed";

const done = (to: number, outcome: Outcome = "ok") => Option.some<[number, Outcome]>([to, outcome]);

const open = Option.none<[number, Outcome]>();

const history = (fields: Partial<typeof RunHistory.Encoded>) =>
  Schema.decodeSync(RunHistory)({
    steps: [],
    waits: [],
    stepLogs: "tagged",
    plan: "plan-hash",
    nodes: [],
    branches: [],
    ends: [],
    ...fields,
  });

const run = (fields: Partial<Omit<typeof RunView.Type, "id">>) =>
  RunView.make({
    id: RunId.make(ID),
    repo: "api",
    persona: Option.some("bob"),
    flow: "review",
    itemKey: "pr-12",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    executionId: Option.none(),
    subjects: [],
    status: "running",
    currentStep: Option.none(),
    summary: Option.none(),
    configTree: Option.none(),
    startedAt: at(0),
    finishedAt: Option.none(),
    ...fields,
  });

const found = (
  runFields: Partial<Omit<typeof RunView.Type, "id">>,
  said: RunHistory,
  plan: FlowPlan = REVIEW,
): Detail => ({ kind: "found", run: run(runFields), history: said, plan });

const READ_TRIGGER = step("read-trigger", 0, done(1), Option.none());

const APPROVED_END = "steps[0].on.approve.steps[1]";
const CHANGES_END = "steps[0].on.changes.steps[0]";

const runningReview = found(
  {},
  history({
    steps: [READ_TRIGGER, step("review.round", 2, open, Option.some(ref("review")))],
    nodes: [visit("review", 2, open)],
  }),
);

const FINISHED = history({
  steps: [
    READ_TRIGGER,
    step("review.round", 2, done(10), Option.some(ref("review"))),
    step("pr.land", 11, done(20), Option.some(ref("land"))),
    step("release-claim", 21, done(22), Option.none()),
  ],
  nodes: [visit("review", 2, done(10)), visit("land", 11, done(20))],
  branches: [{ node: ref("review"), outcome: "approve", takenAt: at(10) }],
  ends: [{ node: ref(APPROVED_END), reachedAt: at(20) }],
});

const finishedReview = found({ status: "done", finishedAt: Option.some(at(22)) }, FINISHED);

const parkedReview = found(
  {},
  history({
    steps: [READ_TRIGGER, step("review.round", 2, open, Option.some(ref("review")))],
    nodes: [visit("review", 2, open)],
    waits: [
      {
        runId: ID,
        signal: "pr-push",
        deferred: "await-push",
        token: "t",
        parkedAt: at(30),
      },
    ],
  }),
);

const failedReview = found(
  { status: "failed", finishedAt: Option.some(at(8)) },
  history({
    steps: [
      READ_TRIGGER,
      step("review.round", 2, done(5, "failed"), Option.some(ref("review"))),
      step("tell-person", 6, done(8), Option.none()),
    ],
    nodes: [visit("review", 2, done(5, "failed"))],
  }),
);

// Two rounds of the loop: CI red in the first, running in the second.
const looping = found(
  { flow: "loop" },
  history({
    steps: [
      step("ci.check", 2, done(10), Option.some(ref("check", { round: 1 }))),
      step("ci.check", 12, open, Option.some(ref("check", { round: 2 }))),
    ],
    nodes: [visit("check", 2, done(10), { round: 1 }), visit("check", 12, open, { round: 2 })],
  }),
  LOOP,
);

const laning = found(
  { flow: "lanes" },
  history({
    steps: [
      step("build#task-1", 3, done(9), Option.some(ref("build", { lane: "task-1" }))),
      step("build#task-2", 10, open, Option.some(ref("build", { lane: "task-2" }))),
    ],
    nodes: [
      visit("tasks", 2, open),
      visit("build", 3, done(9), { lane: "task-1" }),
      visit("build", 10, open, { lane: "task-2" }),
    ],
    lanes: [{ lane: "task-2", needs: ["task-1"] }],
  }),
  LANES,
);

const noLanesYet = found({ flow: "lanes" }, history({ nodes: [visit("tasks", 2, open)] }), LANES);

const noPlan: Detail = {
  kind: "found",
  run: run({ flow: "implement" }),
  history: Schema.decodeSync(RunHistory)({
    steps: [step("claim", 0, done(1), Option.none()), step("implement", 2, open, Option.none())],
    waits: [],
  }),
};

const ENDED: LogState = { lines: [], connection: { kind: "ended" } };

// Each step's log as the page would follow it, by the step and its round.
const logged = new Map<string, ReadonlyArray<string>>([
  ["ci.check@1", ["red in round one"]],
  ["ci.check@2", ["running in round two"]],
  ["review.round@", ["reviewed the pull request"]],
]);

const StepLog = ({
  step: shown,
}: {
  readonly step: { readonly step: string; readonly node?: { readonly round?: number } };
}) => (
  <pre className="log">
    {(logged.get(`${shown.step}@${shown.node?.round ?? ""}`) ?? []).join("\n")}
  </pre>
);

const render = (detail: Detail, now: number, node: Option.Option<NodePlace> = Option.none()) =>
  renderToStaticMarkup(
    <RunDetailView
      asked={ID}
      detail={detail}
      log={ENDED}
      now={Date.parse(at(now))}
      slug={Option.none()}
      node={node}
      StepLog={StepLog}
    />,
  );

const unescaped = (text: string) =>
  text.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&");

// The element the canvas drew for a node, its opening tag to its close, by
// the key it carries.
const boxOf = (markup: string, key: string) =>
  Option.getOrThrow(
    Option.fromUndefinedOr(
      [...markup.matchAll(/<a [^>]*data-node="([^"]*)"[^>]*>.*?<\/a>/g)].find(
        (match) => unescaped(match[1]) === key,
      ),
    ),
  )[0];

const nodeAt = (id: string, where: Where = {}): NodePlace => ({
  kind: "node",
  id,
  round: Option.fromUndefinedOr(where.round),
  lane: Option.fromUndefinedOr(where.lane),
});

const linkOf = (place: NodePlace) => `href="${nodeHref(ID, place).replaceAll("&", "&amp;")}"`;

describe("a run with a plan is drawn on it", () => {
  test("a running run: what ran with its time, what runs with a live time, what it hasn't reached outlined", () => {
    const page = render(runningReview, 62);

    expect(page).toContain('class="plan-canvas');
    expect(page).not.toContain('aria-label="lane run"');

    const setUp = boxOf(page, "set-up");
    expect(setUp).toContain("state-ok");
    expect(setUp).toContain("1s");
    expect(setUp).toContain(linkOf({ kind: "set-up" }));

    const review = boxOf(page, "review");
    expect(review).toContain("state-running");
    expect(review).toContain("1m 00s");
    expect(review).toContain(linkOf(nodeAt("review")));

    expect(boxOf(page, "land")).toContain("state-not-reached");
    expect(boxOf(page, "land")).toContain(linkOf(nodeAt("land")));
    expect(boxOf(page, APPROVED_END)).toContain("state-not-reached");
    expect(boxOf(page, "wrap-up")).toContain("state-not-reached");
    expect(boxOf(page, "wrap-up")).toContain(linkOf({ kind: "wrap-up" }));
  });

  test("a finished run: each node with its time, the branch it took, and the one it didn't greyed", () => {
    const page = render(finishedReview, 600);

    expect(boxOf(page, "review")).toContain("state-ok");
    expect(boxOf(page, "review")).toContain("8s");
    expect(boxOf(page, "land")).toContain("state-ok");
    expect(boxOf(page, "land")).toContain("9s");
    expect(boxOf(page, APPROVED_END)).toContain("state-ok");
    expect(boxOf(page, CHANGES_END)).toContain("state-not-taken");
    expect(page).toMatch(/class="plan-outcome taken"[^>]*>approve</);
    expect(page).toMatch(/class="plan-outcome not-taken"[^>]*>changes</);
    expect(boxOf(page, "wrap-up")).toContain("state-ok");
    expect(boxOf(page, "wrap-up")).toContain("1s");
  });

  test("a parked run: the node it waits in, with how long it has been parked", () => {
    const page = render(parkedReview, 330);

    expect(boxOf(page, "review")).toContain("state-waiting");
    expect(boxOf(page, "review")).toContain("parked 5m 00s");
    expect(boxOf(page, "land")).toContain("state-not-reached");
  });

  test("a failed run: the node it failed at, and nothing after it reached", () => {
    const page = render(failedReview, 600);

    expect(boxOf(page, "review")).toContain("state-failed");
    expect(boxOf(page, "review")).toContain("3s");
    expect(boxOf(page, "land")).not.toContain("state-ok");
    expect(boxOf(page, APPROVED_END)).not.toContain("state-ok");
    expect(boxOf(page, "wrap-up")).toContain("state-ok");
  });

  test("a repeat shows its latest round, with a picker of its rounds", () => {
    const page = render(looping, 72);

    expect(page).toContain('aria-label="rounds of rounds"');
    expect(page).toMatch(/aria-pressed="true"[^>]*>round 2</);
    expect(page).toMatch(/aria-pressed="false"[^>]*>round 1</);

    const check = boxOf(page, "check@2");
    expect(check).toContain("state-running");
    expect(check).toContain("1m 00s");
    expect(check).toContain(linkOf(nodeAt("check", { round: 2 })));
    expect(page).not.toContain('data-node="check@1"');
  });

  test("a link to a node in a past round shows that round, and the node's page", () => {
    const place = nodeAt("check", { round: 1 });
    const page = render(looping, 72, Option.some(place));

    expect(page).toMatch(/aria-pressed="true"[^>]*>round 1</);

    const check = boxOf(page, "check@1");
    expect(check).toContain("state-ok");
    expect(check).toContain("8s");
    expect(check).toContain(linkOf(place));
    expect(check).toContain('aria-current="page"');
    expect(page).not.toContain('data-node="check@2"');
  });

  test("a forEach holds its lanes, in columns by what each waited on", () => {
    const page = render(laning, 70);

    expect(page).toContain('aria-label="lane task-1"');
    expect(page).toContain('aria-label="lane task-2"');
    expect(page).not.toContain('aria-label="template lane"');
    expect(page.indexOf('aria-label="lane task-2"')).toBeGreaterThan(
      page.indexOf('aria-label="lane task-1"'),
    );
    expect(page.match(/class="plan-column"/g)).toHaveLength(2);
    expect(boxOf(page, "build#task-1")).toContain("state-ok");
    expect(boxOf(page, "build#task-1")).toContain(linkOf(nodeAt("build", { lane: "task-1" })));
    expect(boxOf(page, "build#task-2")).toContain("state-running");
    expect(boxOf(page, "tasks#task-2")).toContain(linkOf(nodeAt("tasks", { lane: "task-2" })));
  });

  test("a forEach shows its template lane until its items are known", () => {
    const page = render(noLanesYet, 70);

    expect(page).toContain('aria-label="template lane"');
    expect(boxOf(page, "build")).toContain("state-not-reached");
  });

  test("a run with no plan keeps its history graph", () => {
    const page = render(noPlan, 70);

    expect(page).toContain('aria-label="lane run"');
    expect(page).toContain(`href="#/runs/${ID}/steps/claim"`);
    expect(page).not.toContain("plan-canvas");
  });
});

describe("a node's page", () => {
  test("says the block, its inputs, the outcome it reached, its time, and its step's log", () => {
    const page = render(finishedReview, 600, Option.some(nodeAt("review")));

    expect(page).toContain('aria-label="Node"');
    expect(page).toContain("review.round");
    expect(page).toContain("trigger.pr");
    expect(page).toMatch(/<dt>Outcome<\/dt><dd>approve<\/dd>/);
    expect(page).toMatch(/<dt>Took<\/dt><dd>8s<\/dd>/);
    expect(page).toContain("reviewed the pull request");
    expect(page).not.toContain('aria-label="Log"');
  });

  test("shows the logs of exactly its own engine steps: its round's, not another's", () => {
    const page = render(looping, 72, Option.some(nodeAt("check", { round: 1 })));

    expect(page).toContain("red in round one");
    expect(page).not.toContain("running in round two");
    expect(page.match(/class="log"/g)).toHaveLength(1);
  });

  test("of a node that ran no engine step, shows its outcome and no log", () => {
    const page = render(finishedReview, 600, Option.some(nodeAt(APPROVED_END)));

    expect(page).toContain("ran no engine step");
    expect(page).toMatch(/<dt>Outcome<\/dt><dd>ok<\/dd>/);
    expect(page).not.toContain('class="log"');
  });

  test("of set up, its steps", () => {
    const page = render(finishedReview, 600, Option.some({ kind: "set-up" }));

    expect(page).toContain("read-trigger");
    expect(page).not.toContain("release-claim");
  });

  test("of a place the plan doesn't have, says so", () => {
    expect(render(finishedReview, 600, Option.some(nodeAt("deploy")))).toContain(
      "plan has no node deploy.",
    );
  });
});

// A daemon that answers each path with what `reply` makes of it, and the
// URLs it was asked for.
const daemonAnswering = (reply: (path: string) => Response) => {
  const asked: Array<URL> = [];

  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      asked.push(url);

      return HttpClientResponse.fromWeb(request, reply(url.pathname));
    }),
  );

  return { asked, client };
};

describe("following a run on its plan", () => {
  it.live("loads the plan the run started with, by the hash its history names", () =>
    Effect.gen(function* () {
      const daemon = daemonAnswering((path) => {
        if (path.startsWith("/api/plans/")) {
          return Response.json(
            Schema.encodeSync(Schema.toCodecJson(FoundPlan))(
              FoundPlan.make({ plan: Option.some(REVIEW) }),
            ),
          );
        }

        if (path.endsWith("/history")) {
          return Response.json(Schema.encodeSync(Schema.toCodecJson(RunHistory))(FINISHED));
        }

        return Response.json(
          Schema.encodeSync(Schema.toCodecJson(RunReply))(Option.some(run({ status: "done" }))),
        );
      });

      const detail = yield* loadDetail("http://127.0.0.1:4848", ID).pipe(
        Effect.provideService(HttpClient.HttpClient, daemon.client),
      );

      expect(daemon.asked.map((url) => url.pathname)).toEqual([
        `/api/runs/${ID}`,
        `/api/runs/${ID}/history`,
        "/api/plans/plan-hash",
      ]);
      expect(detail.kind === "found" && detail.plan).toEqual(REVIEW);
    }),
  );

  test("loads the run again as it enters a node, takes a branch or reaches an end", () => {
    const events = [
      RunEnteredNode.make({
        eventId: "n",
        runId: RunId.make(ID),
        node: NodeRef.make(ref("review")),
        enteredAt: "now",
      }),
      RunTookBranch.make({
        eventId: "b",
        runId: RunId.make(ID),
        node: NodeRef.make(ref("review")),
        outcome: "approve",
        takenAt: "now",
      }),
      RunReachedEnd.make({
        eventId: "e",
        runId: RunId.make(ID),
        node: NodeRef.make(ref("end")),
        reachedAt: "now",
      }),
    ];

    expect(events.map((event) => refetchesFor({ kind: "event", event }, ID))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it.live("asks for a node's step's log at that node alone", () =>
    Effect.gen(function* () {
      const daemon = daemonAnswering(
        () =>
          new Response("event: end\ndata: \n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      );

      yield* Stream.runCollect(
        runLogFeed(
          "http://127.0.0.1:4848",
          ID,
          Option.some("ci.check"),
          Option.some(ref("check", { round: 1 })),
        ),
      ).pipe(Effect.provideService(HttpClient.HttpClient, daemon.client));

      const url = Option.getOrThrow(Arr.head(daemon.asked));

      expect(url.searchParams.get("step")).toBe("ci.check");
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
          url.searchParams.get("node") ?? "",
        ),
      ).toEqual({ id: "check", round: 1 });
    }),
  );
});

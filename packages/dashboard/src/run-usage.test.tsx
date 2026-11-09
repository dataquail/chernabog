// What a run spent, on its page: what the page loads from
// GET /api/runs/:id/usage, when it loads it again, how its numbers read, and
// the page rendered for a run whose calls all reported, one with a call that
// didn't, and one from before usage was kept.

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { it } from "effect-bun-test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DaemonStatus,
  RunEnteredStep,
  RunFinished,
  RunFinishedStep,
  RunHistory,
  RunUsage,
  StatusChanged,
  TokenUsageRecorded,
} from "#daemon/protocol";

import type { Heard } from "./feed.ts";
import { type Detail } from "./run.ts";
import { RunDetailView } from "./run-detail.tsx";
import { initialLog } from "./run-log.ts";
import { compactTokens, loadUsage, refetchesUsageFor, type UsageState } from "./run-usage.ts";

const RunView = DaemonStatus.fields.recent.value;
const RunId = RunView.fields.id;
const RunStep = RunHistory.fields.steps.value;
const RunTokens = RunUsage.fields.tokens.value;
const TokenCounts = RunTokens.fields.tokens;
const ModelTokens = RunTokens.fields.byModel.value;
const StepTokens = RunTokens.fields.byStep.value;

const ID = "5714245a-211c-4f0d-8ce1-74b725bac0d6";
const NOW = Date.parse("2026-10-31T14:00:00.000Z");

const found: Detail = {
  kind: "found",
  run: RunView.make({
    id: RunId.make(ID),
    repo: "api",
    persona: Option.some("bob"),
    flow: "implement",
    itemKey: "issue-7",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    executionId: Option.none(),
    subjects: [],
    status: "done",
    currentStep: Option.none(),
    summary: Option.none(),
    configTree: Option.none(),
    startedAt: "2026-10-31T11:00:00.000Z",
    finishedAt: Option.some("2026-10-31T13:30:00.000Z"),
  }),
  history: RunHistory.make({
    steps: [
      RunStep.make({ step: "implement", enteredAt: "2026-10-31T11:00:05.000Z" }),
      RunStep.make({ step: "review", enteredAt: "2026-10-31T12:00:00.000Z" }),
    ],
    waits: [],
  }),
};

const counts = (input: number, output: number, cacheRead: number, cacheWrite: number) =>
  TokenCounts.make({
    total: input + output + cacheRead + cacheWrite,
    input,
    output,
    cacheRead,
    cacheWrite,
  });

const opus = counts(12_000, 34_000, 1_100_000, 54_000);
const haiku = counts(2_000, 1_000, 40_000, 3_000);

const tokensOf = (unreported: boolean) =>
  RunTokens.make({
    tokens: counts(14_000, 35_000, 1_140_000, 57_000),
    byModel: [
      ModelTokens.make({ model: "claude-opus-5-5", tokens: opus }),
      ModelTokens.make({ model: "claude-haiku-5-5", tokens: haiku }),
    ],
    byStep: [
      StepTokens.make({
        step: Option.some("implement"),
        tokens: opus,
        byModel: [ModelTokens.make({ model: "claude-opus-5-5", tokens: opus })],
        unreported: false,
      }),
      StepTokens.make({
        step: Option.some("review"),
        tokens: haiku,
        byModel: [ModelTokens.make({ model: "claude-haiku-5-5", tokens: haiku })],
        unreported,
      }),
    ],
    unreported,
  });

// 2h 14m of compute.
const COMPUTE = (2 * 60 + 14) * 60_000;

const loaded = (usage: RunUsage): UsageState => ({ kind: "loaded", usage });

const full = loaded(
  RunUsage.make({ tokens: Option.some(tokensOf(false)), computeMs: Option.some(COMPUTE) }),
);

const partial = loaded(
  RunUsage.make({ tokens: Option.some(tokensOf(true)), computeMs: Option.some(COMPUTE) }),
);

const unrecorded = loaded(RunUsage.make({ tokens: Option.none(), computeMs: Option.none() }));

const render = (usage: UsageState, step: Option.Option<string> = Option.none()) =>
  renderToStaticMarkup(
    <RunDetailView
      asked={ID}
      detail={found}
      log={initialLog}
      now={NOW}
      slug={Option.none()}
      step={step}
      usage={usage}
    />,
  );

// The page's text without its markup, so a test reads what a person reads.
const textOf = (page: string) => page.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("how a run's numbers read", () => {
  test("tokens compactly", () => {
    expect([0, 950, 1_000, 1_234, 56_700, 1_240_000, 3_400_000_000].map(compactTokens)).toEqual([
      "0",
      "950",
      "1K",
      "1.2K",
      "56.7K",
      "1.2M",
      "3.4B",
    ]);
  });
});

describe("a run's usage on its page", () => {
  test("of a run whose calls all reported: its total, each category, each model, its compute time", () => {
    const page = textOf(render(full));

    expect(page).toContain("Usage");
    expect(page).toContain("1.2M tokens");
    expect(page).not.toContain("At least");
    expect(page).toContain("input 14K");
    expect(page).toContain("output 35K");
    expect(page).toContain("cache read 1.1M");
    expect(page).toContain("cache write 57K");
    expect(page).toContain("claude-opus-5-5 1.2M");
    expect(page).toContain("claude-haiku-5-5 46K");
    expect(page).toContain("Compute time 2h 14m");
  });

  test("of a run with a call that went unreported: at least its total", () => {
    const page = textOf(render(partial));

    expect(page).toContain("At least 1.2M tokens");
    expect(page).toContain("Compute time 2h 14m");
  });

  test("of a run from before usage was kept: not recorded, not zero", () => {
    const page = textOf(render(unrecorded));

    expect(page).toContain("Tokens Not recorded");
    expect(page).toContain("Compute time Not recorded");
    expect(page).not.toContain(" 0 tokens");
  });

  test("shows nothing while it loads, or when the daemon won't say", () => {
    expect(textOf(render({ kind: "loading" }))).not.toContain("Compute time");
    expect(textOf(render({ kind: "unavailable" }))).not.toContain("Compute time");
  });
});

describe("a step's usage on its page", () => {
  test("is that step's tokens by model", () => {
    const page = textOf(render(full, Option.some("implement")));

    expect(page).toContain("Tokens of implement");
    expect(page).toContain("claude-opus-5-5 1.2M");
  });

  test("is at least its tokens when one of its calls went unreported", () => {
    const page = textOf(render(partial, Option.some("review")));

    expect(page).toContain("Tokens of review");
    expect(page).toContain("At least 46K tokens");
    expect(page).toContain("claude-haiku-5-5 46K");
  });

  test("says when the step spent none, or the run kept none", () => {
    expect(textOf(render(full, Option.some("deploy")))).toContain("No agent call recorded");
    expect(textOf(render(unrecorded, Option.some("implement")))).toContain(
      "Tokens of implement Not recorded",
    );
  });
});

describe("what loads a run's usage again", () => {
  const recorded = (runId: string): Heard => ({
    kind: "event",
    event: TokenUsageRecorded.make({
      eventId: "u",
      runId: RunId.make(runId),
      step: Option.some("implement"),
      adapter: "claude",
      sessionId: "s",
      reported: true,
      recordedAt: "now",
    }),
  });

  const entered: Heard = {
    kind: "event",
    event: RunEnteredStep.make({
      eventId: "s",
      runId: RunId.make(ID),
      step: "review",
      enteredAt: "now",
    }),
  };

  const stepEnded: Heard = {
    kind: "event",
    event: RunFinishedStep.make({
      eventId: "e",
      runId: RunId.make(ID),
      step: "review",
      outcome: "ok",
      finishedAt: "now",
    }),
  };

  const ended: Heard = {
    kind: "event",
    event: RunFinished.make({
      eventId: "f",
      runId: RunId.make(ID),
      status: "done",
      summary: "",
      finishedAt: "now",
    }),
  };

  test("an agent call of its own recording what it spent, and its steps starting and ending", () => {
    expect(
      [recorded(ID), entered, stepEnded, ended].map((heard) => refetchesUsageFor(heard, ID)),
    ).toEqual([true, true, true, true]);
  });

  test("not another run's, nor another kind of event", () => {
    const changed: Heard = {
      kind: "event",
      event: StatusChanged.make({ eventId: "c", files: ["config.yaml"], at: "now" }),
    };

    expect(refetchesUsageFor(recorded("other"), ID)).toBe(false);
    expect(refetchesUsageFor(changed, ID)).toBe(false);
  });
});

// A daemon that answers each path with what `reply` makes of it, and the
// paths it was asked for.
const daemonAnswering = (reply: (path: string) => Response) => {
  const asked: Array<string> = [];

  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      asked.push(url.pathname);

      return HttpClientResponse.fromWeb(request, reply(url.pathname));
    }),
  );

  return { asked, client };
};

const encodeUsage = Schema.encodeSync(Schema.toCodecJson(RunUsage));

const usageFrom = (daemon: ReturnType<typeof daemonAnswering>) =>
  loadUsage("http://127.0.0.1:4848", ID).pipe(
    Effect.provideService(HttpClient.HttpClient, daemon.client),
  );

describe("loading a run's usage", () => {
  it.live("asks for it by the run's whole id", () =>
    Effect.gen(function* () {
      const usage = RunUsage.make({
        tokens: Option.some(tokensOf(true)),
        computeMs: Option.some(COMPUTE),
      });

      const daemon = daemonAnswering(() => Response.json(encodeUsage(usage)));

      expect(yield* usageFrom(daemon)).toEqual(loaded(usage));
      expect(daemon.asked).toEqual([`/api/runs/${ID}/usage`]);
    }),
  );

  it.live("is unavailable from a daemon that doesn't answer it", () =>
    Effect.gen(function* () {
      const daemon = daemonAnswering(() =>
        Response.json({ error: "no route /runs/x/usage" }, { status: 404 }),
      );

      expect(yield* usageFrom(daemon)).toEqual({ kind: "unavailable" });
    }),
  );
});

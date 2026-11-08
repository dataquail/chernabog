import { Agent, AgentError, CurrentActivity, Run } from "@chernabog/core";
import { describe, expect } from "bun:test";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effectAtHomeWith } from "../../../../../../test/effect-test.ts";
import { settings } from "../../../../../../test/sdk-fakes.ts";
import { RunId } from "../../../../../kernel/run-id.id.ts";
import { Exec } from "../../../../../platform/exec.ts";
import { GitHubTokens } from "../../../../../platform/github-auth.ts";
import { type TokenUsageReading } from "../../../domain/token-usage/model-usage.value-object.ts";
import { adaptersFor, AgentLive } from "../agents.ts";
import { type Adapter, type AgentSession } from "./adapter.ts";
import { type TokenUsageCall, TokenUsageRecorder } from "./token-usage.ts";

const effect = effectAtHomeWith(Layer.mergeAll(GitHubTokens.fixed("token-implicit"), Exec.layer));

const RUN = RunId.make("run-1");

const inRun = Layer.succeed(
  Run,
  Run.of({ flow: "implement", runId: RUN, executionId: "x", item: { key: "issue-3", data: {} } }),
);

// What the recorder was asked to record, in order.
class Recorded extends Context.Service<Recorded, Array<TokenUsageCall>>()("test/Recorded") {}

// The recorder the engine provides, in memory: session-1 was left at line:3
// by an earlier run.
const recorder = Layer.effect(
  TokenUsageRecorder,
  Effect.gen(function* () {
    const calls = yield* Recorded;

    return TokenUsageRecorder.of({
      cursor: (adapter, sessionId) =>
        Effect.succeed(
          Option.liftPredicate("line:3", () => adapter === "fake" && sessionId === "session-1"),
        ),
      record: (call) =>
        Effect.sync(() => {
          calls.push(call);
        }),
    });
  }),
).pipe(Layer.provideMerge(Layer.sync(Recorded, () => [])));

const reading: TokenUsageReading = {
  records: [
    {
      model: "opus",
      input: Option.some(100),
      output: Option.some(20),
      cacheRead: Option.some(9000),
      cacheWrite: Option.some(300),
    },
  ],
  cursor: "line:9",
};

const answered = Effect.succeed({ sessionId: "session-1", output: "done", costUsd: Option.none() });

type Usage = NonNullable<Adapter["usage"]>;

const fake = (run: Adapter["run"], usage: Option.Option<Usage>): Adapter =>
  Option.match(usage, {
    onNone: () => ({ name: "fake", run }),
    onSome: (reads) => ({ name: "fake", run, usage: reads }),
  });

type Seen = { sessions: Array<[AgentSession, Option.Option<string>]> };

const reporting =
  (seen: Seen = { sessions: [] }): Usage =>
  (session, cursor) =>
    Effect.sync(() => {
      seen.sessions.push([session, cursor]);

      return reading;
    });

const ask = Agent.use((agent) =>
  agent.run({
    cwd: "/work/tree",
    prompt: "implement the issue",
    sessionId: "session-1",
    resumePrompt: Option.none(),
    outputSchema: Option.none(),
    adapter: Option.some("fake"),
  }),
).pipe(Effect.provideService(CurrentActivity, Option.some("implement")));

const agentOf = (adapters: ReadonlyArray<Adapter>) =>
  AgentLive({ ...settings, agent: "fake" }, adapters, Option.none());

// The Agent service over `adapters`, with the recorder, in a run.
const inRunOver = (adapters: ReadonlyArray<Adapter>) =>
  Layer.mergeAll(agentOf(adapters), recorder, inRun);

const reported = (step = "implement") => ({
  runId: RUN,
  step: Option.some(step),
  adapter: "fake",
  sessionId: "session-1",
  reading: Option.some(reading),
});

const unreported = { ...reported(), reading: Option.none() };

describe("AgentLive records what each call spent", () => {
  effect("a call that answers records its adapter's reading, in the step it was made in", () =>
    Effect.gen(function* () {
      const result = yield* ask;

      expect(result.output).toBe("done");
      expect(yield* Recorded).toEqual([reported()]);
    }).pipe(Effect.provide(inRunOver([fake(() => answered, Option.some(reporting()))]))),
  );

  const seen: Seen = { sessions: [] };

  effect("the adapter reads its session from the cursor, where it ran, as whom it ran", () =>
    Effect.gen(function* () {
      yield* ask;

      const [session, cursor] = seen.sessions[0] ?? [];

      expect(seen.sessions).toHaveLength(1);
      expect(cursor).toEqual(Option.some("line:3"));
      expect(session).toEqual({
        sessionId: "session-1",
        cwd: "/work/tree",
        account: settings.account,
      });
    }).pipe(Effect.provide(inRunOver([fake(() => answered, Option.some(reporting(seen)))]))),
  );

  effect("a call that fails still records what it spent, and fails as it did", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(ask);

      expect(failure.message).toBe("the agent gave up");
      expect(yield* Recorded).toEqual([reported()]);
    }).pipe(
      Effect.provide(
        inRunOver([
          fake(
            () => Effect.fail(new AgentError({ message: "the agent gave up" })),
            Option.some(reporting()),
          ),
        ]),
      ),
    ),
  );

  const started = Deferred.makeUnsafe<boolean>();

  const hanging = fake(
    () => Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never)),
    Option.some(reporting()),
  );

  effect("a call that's interrupted still records what it spent", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(ask);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);

      expect(yield* Recorded).toEqual([reported()]);
    }).pipe(Effect.provide(inRunOver([hanging]))),
  );

  effect("an adapter that can't report records that it couldn't say", () =>
    Effect.gen(function* () {
      yield* ask;

      expect(yield* Recorded).toEqual([unreported]);
    }).pipe(Effect.provide(inRunOver([fake(() => answered, Option.none())]))),
  );

  for (const [how, usage] of [
    ["fails", () => Effect.fail(new AgentError({ message: "no session file" }))],
    ["dies", () => Effect.die("unreadable session file")],
  ] as const) {
    effect(`an adapter whose reader ${how} records that it couldn't say, and answers`, () =>
      Effect.gen(function* () {
        const result = yield* ask;

        expect(result.output).toBe("done");
        expect(yield* Recorded).toEqual([unreported]);
      }).pipe(Effect.provide(inRunOver([fake(() => answered, Option.some(usage))]))),
    );
  }

  const broken = Layer.succeed(
    TokenUsageRecorder,
    TokenUsageRecorder.of({
      cursor: () => Effect.die("state.db is gone"),
      record: () => Effect.die("state.db is gone"),
    }),
  );

  effect("a failure to read the cursor or record never fails the call", () =>
    Effect.gen(function* () {
      const result = yield* ask;

      expect(result.output).toBe("done");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(agentOf([fake(() => answered, Option.some(reporting()))]), inRun, broken),
      ),
    ),
  );

  effect("a call outside a run records nothing", () =>
    Effect.gen(function* () {
      yield* ask;

      expect(yield* Recorded).toEqual([]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(agentOf([fake(() => answered, Option.some(reporting()))]), recorder),
      ),
    ),
  );

  const rehearsal = adaptersFor({
    rehearsal: { standIns: { implement: { fixture: "done" } }, exclusive: true },
  });

  effect("a rehearsal's call records that it can't say what it spent", () =>
    Effect.gen(function* () {
      const cwd = yield* FileSystem.FileSystem.use((fs) =>
        fs.makeTempDirectoryScoped({ prefix: "token-usage-" }),
      );

      yield* Agent.use((agent) =>
        agent.run({
          cwd,
          prompt: "implement the issue",
          sessionId: "session-r",
          resumePrompt: Option.none(),
          outputSchema: Option.none(),
          adapter: Option.none(),
        }),
      ).pipe(Effect.provideService(CurrentActivity, Option.some("implement")));

      expect(yield* Recorded).toEqual([
        { ...unreported, adapter: "rehearsal", sessionId: "session-r" },
      ]);
    }).pipe(Effect.provide(inRunOver(rehearsal))),
  );
});

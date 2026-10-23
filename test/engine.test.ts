import {
  activity,
  Agent,
  awaitSignal,
  DEFAULT_LABELS,
  defineFlow,
  Git,
  GitHub,
  HEADLESS,
  NeedsHuman,
  Repo,
  type RepoSettings,
  Run,
  RunLog,
  Skip,
  StepFailed,
  StepRunner,
  Usage,
  type WorkItem,
  Worktree,
} from "@chernabog/sdk";
import type { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { IMPLICIT } from "../src/kernel/persona.value-object.ts";
import { RunId } from "../src/kernel/run-id.id.ts";
import {
  flowHandle,
  flowLayer,
  forEveryPersona,
} from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { StateAt } from "../src/modules/runs/runs.layer.ts";
import { attachExecutionUseCase } from "../src/modules/runs/use-cases/attach-execution.use-case.ts";
import { findRunUseCase } from "../src/modules/runs/use-cases/find-run.use-case.ts";
import { listRunWaitsUseCase } from "../src/modules/runs/use-cases/list-run-waits.use-case.ts";
import { startRunUseCase } from "../src/modules/runs/use-cases/start-run.use-case.ts";
import { Home, homePaths } from "../src/platform/home.ts";
import { DEFAULT_LIMITS, type EffectiveRepo } from "../src/repo-config.ts";
import { effect } from "./effect-test.ts";
import {
  deliverSignals,
  type EngineRun,
  pollRun,
  repoAs,
  runtimeFor,
  startRun,
} from "./sdk-fakes.ts";

const settings: RepoSettings = {
  name: "demo",
  slug: "dataquail/demo",
  path: "/tmp/demo",
  baseBranch: "main",
  account: {
    name: "work",
    configDir: Option.none(),
    expectedEmail: Option.none(),
    oauthTokenEnv: Option.none<string>(),
    usageGate: "usage" as const,
  },
  agent: "claude",
  agentAccounts: {},
  launcher: HEADLESS,
  flowAgents: {},
  labels: DEFAULT_LABELS,
  install: Option.none(),
  localGate: [],
  humanOnly: [],
  humanOnlyPaths: [],
  notes: [],
  board: Option.none(),
  reviewTrigger: Option.none(),
  limits: DEFAULT_LIMITS,
  env: {},
  configDir: "/tmp/demo/.chernabog",
};

const repo: EffectiveRepo = repoAs(settings);

const item = (key: string, signals: ReadonlyArray<string> = []): WorkItem => ({
  key,
  data: { key },
  signals,
});

const executed: Array<string> = [];

const ItemData = Schema.Struct({ key: Schema.String });

const flow = defineFlow({
  trigger: Effect.succeed([]),
  workflow: (work) =>
    Effect.gen(function* () {
      const { key } = yield* Schema.decodeUnknownEffect(ItemData)(work.data).pipe(Effect.orDie);

      // Each activity sees the run's own services, provided by the engine per run.
      const runId = yield* activity(
        "who-am-i",
        Run.use((run) => Effect.succeed(run.runId)),
        Schema.String,
      );

      yield* activity(
        "log",
        RunLog.use((log) => log.log(`hello from ${key}`)),
      );
      executed.push(`${key}:${runId}`);

      if (key === "skip") {
        return yield* new Skip({ reason: "nothing to do" });
      }

      if (key === "human") {
        return yield* activity("give-up", Effect.fail(new NeedsHuman({ reason: "loop cap" })));
      }

      if (key === "boom") {
        return yield* activity(
          "explode",
          Effect.fail(new StepFailed({ step: "explode", message: "kaboom" })),
        );
      }

      if (key === "whoami") {
        return `as ${yield* activity(
          "persona",
          Repo.use((own) => Effect.succeed(own.persona ?? "the implicit persona")),
          Schema.String,
        )}`;
      }

      if (key === "wait") {
        return `woke by ${yield* awaitSignal(["pushed"], { id: "round-1", timeout: "1 hour" })}`;
      }

      return `did ${key}`;
    }),
});

const handle = flowHandle(repo, "demo", flow);

// The flow under test reaches only for its run's own services; the others fail loudly if it touches them.
const servicesWith = (own: RepoSettings) =>
  Layer.mergeAll(
    Layer.succeed(Repo, own),
    Layer.mock(GitHub)({}),
    Layer.mock(Git)({}),
    Layer.mock(Worktree)({ pathFor: (branch) => `/tmp/demo-worktrees/${branch}` }),
    Layer.mock(Usage)({}),
    Layer.mock(Agent)({ adapters: [] }),
    Layer.mock(StepRunner)({}),
  );

const repoServices = servicesWith(settings);

// The services of alice's and bob's runs: their own Repo, which names them.
const asAliceOrBob = Effect.gen(function* () {
  const alice = yield* Layer.build(servicesWith({ ...settings, persona: "alice" }));
  const bob = yield* Layer.build(servicesWith({ ...settings, persona: "bob" }));

  return (persona: Option.Option<string>) =>
    Option.flatMap(persona, (login) => {
      if (login === "alice") {
        return Option.some(alice);
      }

      if (login === "bob") {
        return Option.some(bob);
      }

      return Option.none();
    });
});

// A fresh home and engine for each test, with the platform the test runs on.
const withEngine = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  personas = Effect.map(Layer.build(repoServices), forEveryPersona),
  flowsOf = handle,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-engine-" });
    const homeLayer = Home.at(home, home);

    const servicesFor = yield* personas;

    const engine = yield* Layer.build(
      runtimeFor(flowsOf).pipe(
        Layer.provideMerge(flowLayer(flowsOf, servicesFor)),
        Layer.provideMerge(StateAt(homePaths(home).state)),
        Layer.provideMerge(homeLayer),
      ),
    );

    const platform = yield* Effect.context<BunServices.BunServices>();

    return { home, value: yield* Effect.provideContext(program, Context.merge(platform, engine)) };
  });

const POLLS = 200;

const OLD = RunId.make("old");

const isRunning = (run: EngineRun) => run.status === "running";

// Polls the run until its workflow finishes.
const toEnd = (run: EngineRun) =>
  pollRun(run).pipe(
    Effect.repeat({ schedule: Schedule.spaced("25 millis"), while: isRunning, times: POLLS }),
    Effect.filterOrElse(
      (polled) => !isRunning(polled),
      () => Effect.die(`run ${run.id} never finished`),
    ),
  );

const started = (work: WorkItem) =>
  startRun(handle, IMPLICIT, work).pipe(
    Effect.flatMap((outcome) => Effect.fromOption(outcome.run)),
    Effect.orDie,
  );

const runToEnd = (work: WorkItem) => started(work).pipe(Effect.flatMap(toEnd));

const runAs = (persona: Option.Option<string>, work: WorkItem) =>
  startRun(handle, persona, work).pipe(
    Effect.flatMap((outcome) => Effect.fromOption(outcome.run)),
    Effect.orDie,
    Effect.flatMap(toEnd),
  );

const summaryOf = (run: EngineRun) => Option.getOrElse(run.summary, () => "");

describe("the engine", () => {
  effect("runs a flow to done, giving each activity the run it belongs to", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { home, value: finished } = yield* withEngine(runToEnd(item("one")));
      expect(finished.status).toBe("done");
      expect(summaryOf(finished)).toBe("did one");
      expect(executed).toContain(`one:${finished.id}`);
      const log = yield* fs.readFileString(homePaths(home).runLog(finished.id));
      expect(log).toContain("hello from one");
      expect(log).toContain("step: who-am-i");
    }),
  );

  effect("a Skip ends the run cleanly, and NeedsHuman hands it to a person", () =>
    Effect.gen(function* () {
      const { value } = yield* withEngine(
        Effect.all({ skipped: runToEnd(item("skip")), human: runToEnd(item("human")) }),
      );

      expect(value.skipped.status).toBe("skipped");
      expect(value.human.status).toBe("needs-human");
      expect(summaryOf(value.human)).toBe("loop cap");
    }),
  );

  effect("any other failure fails the run and names the activity", () =>
    Effect.gen(function* () {
      const { value: failed } = yield* withEngine(runToEnd(item("boom")));
      expect(failed.status).toBe("failed");
      expect(summaryOf(failed)).toContain("explode");
      expect(summaryOf(failed)).toContain("kaboom");
    }),
  );

  effect("an item with a run in flight does not get a second one", () =>
    Effect.gen(function* () {
      const { value } = yield* withEngine(
        Effect.all({
          first: startRun(handle, IMPLICIT, item("wait")),
          second: startRun(handle, IMPLICIT, item("wait")),
        }),
      );

      expect(value.first.started).toBe(true);
      expect(value.second.started).toBe(false);
      expect(Option.map(value.second.run, (run) => run.id)).toEqual(
        Option.map(value.first.run, (run) => run.id),
      );
    }),
  );

  effect("a waiting run wakes when the trigger reports its signal", () =>
    Effect.gen(function* () {
      const wakes = Effect.gen(function* () {
        const run = yield* started(item("wait"));

        // Before the run registers its wait, there is nothing to deliver.
        yield* listRunWaitsUseCase(run.id, "pushed").pipe(
          Effect.repeat({
            schedule: Schedule.spaced("25 millis"),
            until: ({ waits }) => waits.length > 0,
            times: POLLS,
          }),
        );
        expect(yield* deliverSignals(handle, IMPLICIT, [item("wait", ["pushed"])])).toBe(1);

        return yield* toEnd(run);
      });

      const { value: finished } = yield* withEngine(wakes);
      expect(finished.status).toBe("done");
      expect(summaryOf(finished)).toBe("woke by pushed");
    }),
  );
});

describe("personas", () => {
  const alice = Option.some("alice");
  const bob = Option.some("bob");

  effect("each run gets its persona's services", () =>
    Effect.gen(function* () {
      const { value } = yield* withEngine(
        Effect.all({ alice: runAs(alice, item("whoami")), bob: runAs(bob, item("whoami")) }),
        asAliceOrBob,
      );

      expect(summaryOf(value.alice)).toBe("as alice");
      expect(summaryOf(value.bob)).toBe("as bob");
    }),
  );

  effect("two personas' runs of one item are two runs, each saying whose it is", () =>
    Effect.gen(function* () {
      const { value } = yield* withEngine(
        Effect.all({
          alice: startRun(handle, alice, item("wait")),
          bob: startRun(handle, bob, item("wait")),
          again: startRun(handle, bob, item("wait")),
        }),
        asAliceOrBob,
      );

      expect(value.alice.started && value.bob.started).toBe(true);
      expect(value.again.started).toBe(false);
      expect(Option.flatMap(value.alice.run, (run) => run.persona)).toEqual(alice);
      expect(Option.flatMap(value.bob.run, (run) => run.persona)).toEqual(bob);
      expect(Option.map(value.alice.run, (run) => run.id)).not.toEqual(
        Option.map(value.bob.run, (run) => run.id),
      );
    }),
  );

  effect(
    "a run without a persona in its payload acts as its row's, as one adopted from before personas does",
    () =>
      Effect.gen(function* () {
        const adopted = Effect.gen(function* () {
          yield* startRunUseCase({
            id: OLD,
            repo: "demo",
            persona: bob,
            flow: "demo",
            itemKey: "whoami",
            itemTitle: Option.none(),
            itemUrl: Option.none(),
          });
          yield* attachExecutionUseCase(
            OLD,
            yield* handle.workflow.execute(
              { runId: "old", item: item("whoami") },
              { discard: true },
            ),
          );

          return yield* toEnd(Option.getOrThrow((yield* findRunUseCase(OLD)).run));
        });

        const { value: finished } = yield* withEngine(adopted, asAliceOrBob);
        expect(summaryOf(finished)).toBe("as bob");
      }),
  );

  effect(
    "a run from before personas, resumed before it's adopted, acts as the repo's first persona",
    () =>
      Effect.gen(function* () {
        const asPersonas = flowHandle(repoAs(settings, [alice, bob]), "demo", flow);

        const unadopted = Effect.gen(function* () {
          yield* startRunUseCase({
            id: OLD,
            repo: "demo",
            persona: Option.none(),
            flow: "demo",
            itemKey: "whoami",
            itemTitle: Option.none(),
            itemUrl: Option.none(),
          });
          yield* attachExecutionUseCase(
            OLD,
            yield* asPersonas.workflow.execute(
              { runId: "old", item: item("whoami") },
              { discard: true },
            ),
          );

          return yield* pollRun(Option.getOrThrow((yield* findRunUseCase(OLD)).run)).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("25 millis"),
              while: isRunning,
              times: POLLS,
            }),
          );
        });

        const { value: finished } = yield* withEngine(unadopted, asAliceOrBob, asPersonas);
        expect(summaryOf(finished)).toBe("as alice");
      }),
  );

  effect(
    "a run as a persona the repo no longer has fails, rather than acting as someone else",
    () =>
      Effect.gen(function* () {
        const { value: failed } = yield* withEngine(
          runAs(Option.some("carol"), item("whoami")),
          asAliceOrBob,
        );

        expect(failed.status).toBe("failed");
        expect(summaryOf(failed)).toContain("carol no longer runs demo");
      }),
  );
});

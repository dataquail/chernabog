import {
  activity,
  Agent,
  awaitSignal,
  DEFAULT_LABELS,
  defineFlow,
  Git,
  GitHub,
  HEADLESS,
  Implement,
  NeedsHuman,
  NotInReviewerPool,
  PersonaUnavailable,
  Repo,
  reportAs,
  type RepoSettings,
  Review,
  ReviewerSeat,
  Run,
  RunLog,
  Settings,
  type SetupError,
  Skip,
  StepFailed,
  StepRunner,
  Subjects,
  Usage,
  type WorkItem,
  Worktree,
} from "@chernabog/sdk";
import type { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
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
import { findRunHandler } from "../src/modules/runs/queries/find-run.handler.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { RunLogsLayer, StateAt } from "../src/modules/runs/runs.layer.ts";
import { attachExecutionUseCase } from "../src/modules/runs/use-cases/attach-execution.use-case.ts";
import { CancelTarget } from "../src/modules/runs/use-cases/cancel-run.result.ts";
import { cancelRunUseCase } from "../src/modules/runs/use-cases/cancel-run.use-case.ts";
import { recoverRunsUseCase } from "../src/modules/runs/use-cases/recover-runs.use-case.ts";
import { startRunUseCase } from "../src/modules/runs/use-cases/start-run.use-case.ts";
import { BUNDLED_CORE } from "../src/platform/flow-deps.ts";
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

      if (key === "subjects") {
        yield* Subjects.name("pr-40");
        yield* activity("release", Subjects.name("release-1.4"));
        yield* Subjects.name("pr-40");
        yield* activity("second-pull", Subjects.name("pr-41"));
      }

      if (key === "seat") {
        return `reviews as ${yield* Review.reviewerLogin}`;
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
    Layer.succeed(
      ReviewerSeat,
      ReviewerSeat.of({ login: Effect.die(new NotInReviewerPool({ reviewers: [] })) }),
    ),
  );

const repoServices = servicesWith(settings);

// The services of alice's and bob's runs: their own Repo, which names them.
const asAliceOrBob = Effect.gen(function* () {
  const alice = yield* Layer.build(servicesWith({ ...settings, persona: "alice" }));
  const bob = yield* Layer.build(servicesWith({ ...settings, persona: "bob" }));

  return (persona: Option.Option<string>) =>
    Option.flatMap(persona, (login): Option.Option<Effect.Effect<typeof alice, SetupError>> => {
      if (login === "alice") {
        return Option.some(Effect.succeed(alice));
      }

      if (login === "bob") {
        return Option.some(Effect.succeed(bob));
      }

      // dave isn't logged in to gh.
      if (login === "dave") {
        return Option.some(
          Effect.fail(
            new PersonaUnavailable({
              login,
              reason: "no oauth token found for github.com account dave",
            }),
          ),
        );
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
        Layer.merge(RunLogsLayer),
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
        yield* listRunWaitsHandler({ runId: run.id, signal: "pushed" }).pipe(
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
  effect("a cancelled waiting run stops in the engine, and no signal wakes it", () =>
    Effect.gen(function* () {
      const cancels = Effect.gen(function* () {
        const run = yield* started(item("wait"));

        yield* listRunWaitsHandler({ runId: run.id, signal: "pushed" }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("25 millis"),
            until: ({ waits }) => waits.length > 0,
            times: POLLS,
          }),
        );

        const cancelled = yield* cancelRunUseCase(CancelTarget.cases.ById.make({ asked: run.id }), {
          by: "alice",
          closeSessions: false,
          endAs: Option.none(),
        });

        const delivered = yield* deliverSignals(handle, IMPLICIT, [item("wait", ["pushed"])]);
        const polled = yield* pollRun(run);
        const execution = yield* handle.workflow.poll(Option.getOrThrow(run.executionId));

        return { cancelled, delivered, polled, execution };
      });

      const { value } = yield* withEngine(cancels);

      expect([value.cancelled.stopped, value.cancelled.wakesCleared]).toEqual([true, 1]);
      expect([value.delivered, value.polled.status]).toEqual([0, "cancelled"]);
      expect(Option.map(value.execution, (result) => result._tag)).toEqual(Option.some("Complete"));
    }),
  );

  effect(
    "a start a crash interrupted runs once on recovery, whether or not its workflow had started",
    () =>
      Effect.gen(function* () {
        const recorded = (key: string) =>
          startRunUseCase({
            id: RunId.make(key),
            coreVersion: BUNDLED_CORE,
            repo: "demo",
            persona: IMPLICIT,
            flow: "demo",
            itemKey: key,
            itemTitle: Option.none(),
            itemUrl: Option.none(),
            item: Option.some(item(key)),
          });

        const recovers = Effect.gen(function* () {
          // Killed after the run was recorded, before its workflow executed.
          yield* recorded("before");

          // Killed after its workflow executed, before the execution was attached.
          yield* recorded("after");

          const execution = yield* handle.workflow.execute(
            { runId: "after", item: item("after") },
            { discard: true },
          );

          const recovered = yield* recoverRunsUseCase();
          const ended = yield* Effect.forEach(recovered.executed, toEnd);

          return { execution, recovered, ended };
        });

        const { value } = yield* withEngine(recovers);

        expect(value.recovered.executed.map((run) => String(run.id)).toSorted()).toEqual([
          "after",
          "before",
        ]);
        expect(
          value.recovered.executed.find((run) => run.id === RunId.make("after"))?.executionId,
        ).toEqual(Option.some(value.execution));
        expect(value.ended.map((run) => run.status)).toEqual(["done", "done"]);
        expect(executed.filter((line) => line.startsWith("after:"))).toEqual(["after:after"]);
        expect(executed.filter((line) => line.startsWith("before:"))).toEqual(["before:before"]);
      }),
  );
});

describe("a run and the .chernabog/ tree it started from", () => {
  // The flow as an older tree has it, which says which tree it came from.
  const asOf = (tree: string) =>
    defineFlow({ trigger: Effect.succeed([]), workflow: () => Effect.succeed(`ran ${tree}`) });

  const asked: Array<string> = [];

  const origined = flowHandle(
    repo,
    "demo",
    flow,
    Option.some({
      tree: "current",
      flowAt: (tree) => Effect.sync(() => asked.push(tree)).pipe(Effect.as(asOf(tree))),
    }),
  );

  effect(
    "resumes against the tree it recorded: an older one's flow, or the handle's for its own tree or none",
    () =>
      Effect.gen(function* () {
        const recorded = (key: string, configTree: Option.Option<string>) =>
          startRunUseCase({
            id: RunId.make(key),
            coreVersion: BUNDLED_CORE,
            configTree,
            repo: "demo",
            persona: IMPLICIT,
            flow: "demo",
            itemKey: key,
            itemTitle: Option.none(),
            itemUrl: Option.none(),
            item: Option.some(item(key)),
          });

        const resumes = Effect.gen(function* () {
          yield* recorded("older-tree", Option.some("older"));
          yield* recorded("current-tree", Option.some("current"));
          yield* recorded("no-tree", Option.none());

          const recovered = yield* recoverRunsUseCase();

          return yield* Effect.forEach(recovered.executed, toEnd);
        });

        const { value } = yield* withEngine(
          resumes,
          Effect.map(Layer.build(repoServices), forEveryPersona),
          origined,
        );

        expect(Object.fromEntries(value.map((run) => [String(run.id), summaryOf(run)]))).toEqual({
          "older-tree": "ran older",
          "current-tree": "did current-tree",
          "no-tree": "did no-tree",
        });
        expect(asked).toEqual(["older"]);
      }),
  );

  effect("records the tree its flow was loaded from when it starts", () =>
    Effect.gen(function* () {
      const { value } = yield* withEngine(
        startRun(origined, IMPLICIT, item("fresh")).pipe(
          Effect.flatMap((outcome) => Effect.fromOption(outcome.run)),
          Effect.orDie,
          Effect.flatMap(toEnd),
        ),
        Effect.map(Layer.build(repoServices), forEveryPersona),
        origined,
      );

      expect(value.configTree).toEqual(Option.some("current"));
    }),
  );
});

describe("a run's subjects", () => {
  effect("records each subject a run names, once, in order", () =>
    Effect.gen(function* () {
      const { value } = yield* withEngine(runToEnd(item("subjects")));
      expect(value.status).toBe("done");
      expect(value.subjects).toEqual(["pr-40", "release-1.4", "pr-41"]);
    }),
  );

  effect("a run that names none has none, and Subjects.name outside a run does nothing", () =>
    Effect.gen(function* () {
      const { value } = yield* withEngine(runToEnd(item("one")));
      expect(value.subjects).toEqual([]);
      yield* Subjects.name("pr-1");
    }),
  );
});

describe("a flow's own settings", () => {
  // A setting no other flow and nothing in core knows: which branch a release promotes from.
  const Promote = Schema.Struct({ promoteFrom: Schema.String, dryRun: Schema.Boolean });

  const promoting = defineFlow({
    trigger: Effect.succeed([]),
    settings: Promote,
    workflow: () =>
      Effect.map(
        Settings.read(Promote),
        (own) => `promote from ${own.promoteFrom}, dry run: ${String(own.dryRun)}`,
      ),
  });

  // The team shares dryRun under settings:, and sets promoteFrom for promote alone.
  const [own] = repo.personas;

  const promoteHandle = flowHandle(
    {
      ...repo,
      personas: [
        {
          ...own,
          shared: { dryRun: true, promoteFrom: "main" },
          flows: { promote: { settings: { promoteFrom: "develop" } } },
        },
      ],
    },
    "promote",
    promoting,
  );

  effect("a run reads them typed, the flow's own over the shared ones", () =>
    Effect.gen(function* () {
      const { value: finished } = yield* withEngine(
        startRun(promoteHandle, IMPLICIT, item("release")).pipe(
          Effect.flatMap((outcome) => Effect.fromOption(outcome.run)),
          Effect.orDie,
          Effect.flatMap(toEnd),
        ),
        Effect.map(Layer.build(repoServices), forEveryPersona),
        promoteHandle,
      );

      expect(summaryOf(finished)).toBe("promote from develop, dry run: true");
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
            coreVersion: BUNDLED_CORE,
            repo: "demo",
            persona: bob,
            flow: "demo",
            itemKey: "whoami",
            itemTitle: Option.none(),
            itemUrl: Option.none(),
            item: Option.none(),
          });
          yield* attachExecutionUseCase(
            OLD,
            yield* handle.workflow.execute(
              { runId: "old", item: item("whoami") },
              { discard: true },
            ),
          );

          return yield* toEnd(Option.getOrThrow((yield* findRunHandler({ runId: OLD })).run));
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
            coreVersion: BUNDLED_CORE,
            repo: "demo",
            persona: Option.none(),
            flow: "demo",
            itemKey: "whoami",
            itemTitle: Option.none(),
            itemUrl: Option.none(),
            item: Option.none(),
          });
          yield* attachExecutionUseCase(
            OLD,
            yield* asPersonas.workflow.execute(
              { runId: "old", item: item("whoami") },
              { discard: true },
            ),
          );

          return yield* pollRun(
            Option.getOrThrow((yield* findRunHandler({ runId: OLD })).run),
          ).pipe(
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
    "a run as a persona that fails setup fails with the setup error, naming its fix, and does none of its work",
    () =>
      Effect.gen(function* () {
        executed.length = 0;

        const { value: failed } = yield* withEngine(
          runAs(Option.some("dave"), item("whoami")),
          asAliceOrBob,
        );

        expect(failed.status).toBe("failed");
        expect(summaryOf(failed)).toContain(
          "dave is unavailable: no oauth token found for github.com account dave",
        );
        expect(summaryOf(failed)).toContain(
          "Fix: run `gh auth login --hostname github.com` as dave",
        );
        expect(executed).toEqual([]);
      }),
  );

  effect(
    "a run that asks for a reviewer seat its persona doesn't hold fails with NotInReviewerPool, which no flow handles",
    () =>
      Effect.gen(function* () {
        const { value: failed } = yield* withEngine(runAs(IMPLICIT, item("seat")));
        expect(failed.status).toBe("failed");
        expect(summaryOf(failed)).toContain(
          "runs as the implicit account, which has no seat in the reviewer pool",
        );
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

// A flow's errors, checked by the compiler: `bun run check` fails if a flow
// that lets a work error or a GitHubError through compiles. The expected
// errors below are the test; the runtime test only says they're here.

const pushes = Implement.push("push", "/tmp/worktree", "auto/issue-1");

const leaksWorkError = defineFlow({
  trigger: Effect.succeed([]),
  // @ts-expect-error -- the test: a push can fail with PushRejected and NothingCommitted, which the flow must handle.
  workflow: () => pushes,
});

const handlesWorkErrors = defineFlow({
  trigger: Effect.succeed([]),
  workflow: () =>
    pushes.pipe(
      Effect.catchTags({
        PushRejected: (rejected) => Effect.fail(new NeedsHuman({ reason: rejected.message })),
        NothingCommitted: (nothing) => Effect.fail(new NeedsHuman({ reason: nothing.message })),
      }),
    ),
});

const queued = GitHub.use((github) => github.queuedIssues).pipe(
  Effect.map((issues) => issues.map((issue) => Implement.issueItem(issue))),
);

const leaksGitHubError = defineFlow({
  // @ts-expect-error -- the test: a trigger that reads GitHub can fail with GitHubError, which only reportAs may let through.
  trigger: queued,
  workflow: () => Effect.void,
});

const reportsGitHubError = defineFlow({
  trigger: queued.pipe(reportAs("trigger")),
  workflow: () => Effect.void,
});

describe("a flow's errors", () => {
  test("flows that let errors through are compile errors", () => {
    expect([leaksWorkError, handlesWorkErrors, leaksGitHubError, reportsGitHubError]).toHaveLength(
      4,
    );
  });
});

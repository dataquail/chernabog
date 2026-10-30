// Runs whose work item goes while they're in flight, through the real engine
// and the recipes' own checks: a parked run whose pull request closes, and an
// implement run whose issue closes while the agent works. Each ends as
// superseded with why, lets its claim go, and leaves its agent session.

import {
  awaitSignal,
  Claims,
  DEFAULT_LABELS,
  defineFlow,
  PullRequest,
  Review,
  RunLog,
} from "@chernabog/sdk";
import type { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import implement from "../packages/recipes/flows/implement.ts";
import { IMPLICIT } from "../src/kernel/persona.value-object.ts";
import { RunValidity } from "../src/modules/runs/domain/schedule/validity.value-object.ts";
import {
  type FlowHandle,
  flowHandle,
  flowLayer,
  forEveryPersona,
} from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { checkRunValidityHandler } from "../src/modules/runs/queries/check-run-validity.handler.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { RunLogsLayer, RuntimeLayer, StateAt } from "../src/modules/runs/runs.layer.ts";
import {
  type CancelledRun,
  CancelTarget,
} from "../src/modules/runs/use-cases/cancel-run.result.ts";
import { cancelRunUseCase } from "../src/modules/runs/use-cases/cancel-run.use-case.ts";
import { Home, homePaths } from "../src/platform/home.ts";
import { effect } from "./effect-test.ts";
import {
  type EngineRun,
  type Fake,
  ISSUE,
  item,
  makeFake,
  pollRun,
  PULL,
  repo,
  startRun,
  summaryOf,
} from "./sdk-fakes.ts";

const POLLS = { schedule: Schedule.spaced("25 millis"), times: 200 };

const quietLog = Layer.succeed(
  RunLog,
  RunLog.of({ log: () => Effect.void, step: () => Effect.void, stepDone: () => Effect.void }),
);

// A run parked on its pull request's approval, holding the pull request's claim.
const parking = defineFlow({
  trigger: Effect.succeed([]),
  stillValid: Review.stillValid,
  workflow: (work) =>
    Effect.gen(function* () {
      const { pullRequest } = yield* Review.pullRequestOf(work);
      yield* PullRequest.own(pullRequest);
      const signal = yield* awaitSignal(["closed:approved"], { id: "1", timeout: "14 days" });

      return `woke by ${signal}`;
    }),
});

// The engine over one flow as the daemon builds it: its workflow, and a
// registry that gives the flow's checks and cleanup the fake's services.
const withEngine = <A, E, R>(handle: FlowHandle, fake: Fake, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-superseded-" });
    const platform = yield* Effect.context<BunServices.BunServices>();
    const services = yield* Layer.build(Layer.mergeAll(fake.services, quietLog));
    const context = Context.merge(platform, services);

    const engine = yield* Layer.build(
      RuntimeLayer({
        handles: [handle],
        services: () => Option.some(Effect.succeed(context)),
      }).pipe(
        Layer.merge(RunLogsLayer),
        Layer.provideMerge(flowLayer(handle, forEveryPersona(services))),
        Layer.provideMerge(StateAt(homePaths(home).state)),
        Layer.provideMerge(Home.at(home, home)),
      ),
    );

    return yield* Effect.provideContext(body, Context.merge(platform, engine));
  });

const superseding = (run: EngineRun, reason: string) =>
  cancelRunUseCase(CancelTarget.cases.ById.make({ asked: run.id }), {
    by: "chernabog",
    closeSessions: false,
    endAs: Option.some({ ending: "superseded" as const, reason }),
  });

describe("a run whose work item goes", () => {
  const pullWork = item(`pr-${PULL}`, {
    pullRequest: PULL,
    headRef: `auto/issue-${ISSUE}`,
    agentWritten: true,
  });

  effect("parked on a pull request that closes, ends as superseded and lets its claim go", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      const handle = flowHandle(repo, "parking", parking);

      const value = yield* withEngine(
        handle,
        fake,
        Effect.gen(function* () {
          const started = Option.getOrThrow((yield* startRun(handle, IMPLICIT, pullWork)).run);

          yield* listRunWaitsHandler({ runId: started.id, signal: "closed:approved" }).pipe(
            Effect.repeat({ ...POLLS, until: ({ waits }) => waits.length > 0 }),
          );

          const before = yield* checkRunValidityHandler({ runId: started.id });
          const held = fake.refs.has(Claims.refFor(Claims.pullRequest(PULL)));
          fake.states.pull = "closed";
          const after = yield* checkRunValidityHandler({ runId: started.id });
          const ended = yield* superseding(started, "#7 was closed");
          const polled = yield* pollRun(started);

          return { before, held, after, ended, polled };
        }),
      );

      expect([value.before._tag, value.held]).toEqual(["Valid", true]);
      expect(value.after).toEqual(RunValidity.cases.Gone.make({ reason: `#${PULL} was closed` }));
      expect(value.polled.status).toBe("superseded");
      expect(summaryOf(value.polled)).toMatch(/^#7 was closed; interrupted in await-/);
      expect(value.ended.releasedClaims).toEqual([Claims.refFor(Claims.pullRequest(PULL))]);
      expect(fake.refs.has(Claims.refFor(Claims.pullRequest(PULL)))).toBe(false);
    }),
  );

  // An implement run in its agent step, ended by `end`; what it left once its
  // workflow had stopped in the engine.
  const endedMidStep = <E, R>(
    fake: Fake,
    end: (run: EngineRun) => Effect.Effect<CancelledRun, E, R>,
  ) =>
    Effect.gen(function* () {
      fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
      fake.agent.hangs = true;
      const handle = flowHandle(repo, "implement", implement);

      return yield* withEngine(
        handle,
        fake,
        Effect.gen(function* () {
          const work = item(`issue-${ISSUE}`, { issue: ISSUE });
          const started = Option.getOrThrow((yield* startRun(handle, IMPLICIT, work)).run);

          const working = yield* pollRun(started).pipe(
            Effect.repeat({
              ...POLLS,
              until: (run) => Option.contains(run.currentStep, "implement"),
            }),
          );

          const commentsBefore = fake.comments.length;
          const ended = yield* Effect.orDie(end(started));

          // Whatever the workflow would still do, it has done once it stops.
          yield* handle.workflow
            .poll(Option.getOrThrow(started.executionId))
            .pipe(Effect.repeat({ ...POLLS, until: Option.isSome }));

          const polled = yield* pollRun(started);

          return { working, ended, polled, commentsBefore };
        }),
      );
    });

  effect(
    "an implement run whose issue closes mid-agent-step is interrupted, and writes nothing more",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve", { reviewers: ["zach"] });

        const value = yield* endedMidStep(fake, (run) =>
          Effect.gen(function* () {
            fake.states.issue = "closed";
            const checked = yield* checkRunValidityHandler({ runId: run.id });

            expect(checked).toEqual(
              RunValidity.cases.Gone.make({ reason: `#${ISSUE} was closed` }),
            );

            return yield* superseding(run, `#${ISSUE} was closed`);
          }),
        );

        expect(Option.getOrThrow(value.working.currentStep)).toBe("implement");
        expect([value.ended.stopped, value.polled.status]).toEqual([true, "superseded"]);
        expect(summaryOf(value.polled)).toBe(`#${ISSUE} was closed; interrupted in implement`);
        expect(fake.git.opened).toBe(false);
        expect(fake.refs.has(Claims.refFor(Claims.issue(ISSUE)))).toBe(false);
        // No hand-off to a person: no comment, no auto:needs-human.
        expect(fake.comments.length).toBe(value.commentsBefore);
        expect(fake.labelsOf(ISSUE)).not.toContain(DEFAULT_LABELS.needsHuman);
      }),
  );

  effect("a cancel mid-agent-step stops the agent, and the run writes nothing more", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", { reviewers: ["zach"] });

      const value = yield* endedMidStep(fake, (run) =>
        cancelRunUseCase(CancelTarget.cases.ById.make({ asked: run.id }), {
          by: "alice",
          closeSessions: false,
          endAs: Option.none(),
        }),
      );

      expect([value.ended.stopped, value.polled.status]).toEqual([true, "cancelled"]);
      expect(fake.git.opened).toBe(false);
      expect(fake.comments.length).toBe(value.commentsBefore);
      expect(fake.labelsOf(ISSUE)).not.toContain(DEFAULT_LABELS.needsHuman);
    }),
  );
});

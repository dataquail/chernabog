// POST /commands/:tag, the daemon's one route for the commands its clients
// dispatch on its bus (docs/adr/0016-state-changing-commands-go-through-the-daemon.md),
// served over a scratch home's socket on a bus that records what reached it,
// and the CLI's and TUI's calls through it.

import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { CommandBus, type DispatchTable, makeCommandBus } from "@effect-server-utils/cqrs";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  DaemonEnrollmentCommands,
  DaemonTrustCommands,
  throughDaemon,
} from "../src/interface/daemon/daemon.client.ts";
import { Refusal } from "../src/interface/daemon/daemon.protocol.ts";
import { commandsRoute } from "../src/interface/daemon/daemon-commands.server.ts";
import { applySetting, type SettingAction } from "../src/interface/tui/settings.ts";
import { RepoSlug } from "../src/kernel/repo-slug.id.ts";
import { PauseState } from "../src/modules/enrollment/commands/pause-repo.command.ts";
import { RepoNotEnrolled } from "../src/modules/enrollment/domain/enrolled-repo/enrolled-repo.errors.ts";
import { EnrolledRepoSummary } from "../src/modules/enrollment/domain/enrolled-repo/enrolled-repo-summary.value-object.ts";
import { EnrollmentCommands } from "../src/modules/enrollment/enrollment.platform.ts";
import { MachineQueries } from "../src/modules/machine/machine.platform.ts";
import { MachineSetupView } from "../src/modules/machine/queries/read-machine-setup.query.ts";
import { TrustOutcome } from "../src/modules/trust/commands/trust-repo.command.ts";
import { Home, homePaths } from "../src/platform/home.ts";
import { effectAtHomeWith } from "./effect-test.ts";

// What reached the daemon's bus, in order.
type Dispatched = { readonly tag: string; readonly payload: object };

const summary = EnrolledRepoSummary.make({
  name: "demo",
  repo: RepoSlug.make("acme/demo"),
  path: "/work/demo",
});

const pauseState = (paused: boolean) =>
  PauseState.make({ name: "demo", repo: RepoSlug.make("acme/demo"), paused, changed: true });

const notEnrolled = new RepoNotEnrolled({ asked: "nope", enrolled: ["demo"] });

// A bus over handlers that record each command and answer as enrollment's
// and trust's do: a repo named "nope" isn't enrolled.
const recordingBus = (dispatched: Array<Dispatched>) => {
  const answer =
    <A>(tag: string, success: A) =>
    (payload: { readonly name: string }) =>
      Effect.sync(() => dispatched.push({ tag, payload })).pipe(
        Effect.andThen(
          Effect.mapError(
            Effect.fromOption(Option.liftPredicate(success, () => payload.name !== "nope")),
            () => notEnrolled,
          ),
        ),
      );

  const table: DispatchTable = {
    PauseRepoCommand: answer("PauseRepoCommand", pauseState(true)),
    ResumeRepoCommand: answer("ResumeRepoCommand", pauseState(false)),
    SetPersonaFlowCommand: answer("SetPersonaFlowCommand", summary),
    SetFlowScheduleCommand: answer("SetFlowScheduleCommand", summary),
    SetPersonaAccountCommand: answer("SetPersonaAccountCommand", summary),
    UnenrollRepoCommand: answer("UnenrollRepoCommand", summary),
    RepointRepoCommand: answer("RepointRepoCommand", summary),
    TrustRepoCommand: (payload: { readonly repo: RepoSlug }) =>
      Effect.sync(() => dispatched.push({ tag: "TrustRepoCommand", payload })).pipe(
        Effect.as(
          TrustOutcome.make({
            repo: payload.repo,
            tree: "abc123",
            previous: Option.none(),
            changes: Option.some("first trust"),
            trusted: true,
          }),
        ),
      ),
  };

  return Layer.succeed(CommandBus, makeCommandBus(table));
};

const answerRefusing = <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  handler.pipe(
    Effect.catch((error) =>
      HttpServerResponse.schemaJson(Refusal)({ error: String(error) }, { status: 500 }),
    ),
  );

// The route, served on the home's socket as the daemon serves it; `checked`
// counts what it ran after a dispatch that succeeded.
const serve = (dispatched: Array<Dispatched>, checked: { count: number }) =>
  Effect.gen(function* () {
    const socket = homePaths((yield* Home).root).socket;

    yield* Layer.build(
      HttpRouter.serve(
        commandsRoute(
          answerRefusing,
          Effect.sync(() => {
            checked.count += 1;
          }),
        ),
        { disableLogger: true, disableListenLog: true },
      ).pipe(
        Layer.provide(BunHttpServer.layer({ unix: socket })),
        Layer.provide(recordingBus(dispatched)),
      ),
    );

    return socket;
  });

// What the machine offers, as machine setup would read it.
const offered = MachineSetupView.make({
  personas: ["alice"],
  accounts: [{ name: "work", agent: "claude" }],
});

const FakeMachine = Layer.succeed(
  MachineQueries,
  MachineQueries.of({
    CheckServiceQuery: () => Effect.die("not asked"),
    InspectAccountDirQuery: () => Effect.die("not asked"),
    PlanSetupQuery: () => Effect.die("not asked"),
    ReadMachineSetupQuery: () => Effect.succeed(offered),
  }),
);

// Enrollment here, which a dispatch through the daemon never reaches.
const NoEnrollmentHere = Layer.succeed(
  EnrollmentCommands,
  EnrollmentCommands.of({
    ApplyEnrollmentCommand: () => Effect.die("dispatched here"),
    PauseRepoCommand: () => Effect.die("dispatched here"),
    RepointRepoCommand: () => Effect.die("dispatched here"),
    ResumeRepoCommand: () => Effect.die("dispatched here"),
    SetFlowScheduleCommand: () => Effect.die("dispatched here"),
    SetPersonaAccountCommand: () => Effect.die("dispatched here"),
    SetPersonaFlowCommand: () => Effect.die("dispatched here"),
    UnenrollRepoCommand: () => Effect.die("dispatched here"),
  }),
);

// What the daemon answers a POST of `body` to /commands/<tag> on `socket`.
const post = (socket: string, tag: string, body: Readonly<Record<string, number | string>>) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const overSocket: BunFetchRequestInit = { unix: socket };

    const response = yield* client
      .execute(
        HttpClientRequest.post(`http://daemon/commands/${tag}`).pipe(
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, overSocket));

    return {
      status: response.status,
      refusal: yield* HttpClientResponse.schemaBodyJson(Refusal)(response),
    };
  });

const effect = effectAtHomeWith(
  Layer.mergeAll(FetchHttpClient.layer, FakeMachine, NoEnrollmentHere),
);

describe("POST /commands/:tag", () => {
  effect("dispatches an allowlisted command on the daemon's bus, and answers its success", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = [];
      const checked = { count: 0 };
      yield* serve(dispatched, checked);

      const paused = yield* DaemonEnrollmentCommands.PauseRepoCommand({ name: "demo" });

      expect(paused).toBeInstanceOf(PauseState);
      expect(paused).toEqual(pauseState(true));
      expect(dispatched).toEqual([{ tag: "PauseRepoCommand", payload: { name: "demo" } }]);
      // The daemon checks what the command changed, as /reload has it.
      expect(checked.count).toBe(1);

      const trusted = yield* DaemonTrustCommands.TrustRepoCommand({
        repo: RepoSlug.make("acme/demo"),
        path: "/work/demo",
      });

      expect(trusted.trusted).toBe(true);
      expect(dispatched.map((each) => each.tag)).toEqual(["PauseRepoCommand", "TrustRepoCommand"]);
    }),
  );

  effect("refuses a tag that isn't on the allowlist with 404, dispatching nothing", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = [];
      const socket = yield* serve(dispatched, { count: 0 });

      for (const tag of ["RepointRepoCommand", "ClaimReloadCommand", "CancelRunCommand", "Nope"]) {
        const { refusal, status } = yield* post(socket, tag, { name: "demo" });

        expect(status).toBe(404);
        expect(refusal.error).toContain(`dispatches no ${tag}`);
      }

      expect(dispatched).toEqual([]);
    }),
  );

  effect("refuses a payload its command's schema doesn't decode, with 400", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = [];
      const socket = yield* serve(dispatched, { count: 0 });

      const { status } = yield* post(socket, "PauseRepoCommand", { repo: 7 });

      expect(status).toBe(400);
      expect(dispatched).toEqual([]);
    }),
  );

  effect("answers a command's failure as a refusal with its tag, which the client fails with", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = [];
      const checked = { count: 0 };
      const socket = yield* serve(dispatched, checked);

      const failed = yield* Effect.flip(
        DaemonEnrollmentCommands.PauseRepoCommand({ name: "nope" }),
      );

      expect(failed).toBeInstanceOf(RepoNotEnrolled);
      expect(failed).toEqual(notEnrolled);
      expect(checked.count).toBe(0);

      const { refusal, status } = yield* post(socket, "PauseRepoCommand", { name: "nope" });

      expect(status).toBe(422);
      expect(refusal.error).toBe(notEnrolled.message);
      expect(refusal.tag).toBe("RepoNotEnrolled");
      expect(refusal.failure).toEqual(
        yield* Schema.encodeEffect(Schema.toCodecJson(RepoNotEnrolled))(notEnrolled),
      );
    }),
  );

  effect("fails with DaemonUnavailable when no daemon answers", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(
        DaemonEnrollmentCommands.PauseRepoCommand({ name: "demo" }),
      );

      expect(failed._tag).toBe("DaemonUnavailable");
    }),
  );
});

describe("through the daemon first", () => {
  const here = (ran: { count: number }) =>
    Effect.sync(() => {
      ran.count += 1;

      return pauseState(true);
    });

  effect("dispatches here only when no daemon answers", () =>
    Effect.gen(function* () {
      const ran = { count: 0 };

      const paused = yield* throughDaemon(
        DaemonEnrollmentCommands.PauseRepoCommand({ name: "demo" }),
        here(ran),
      );

      expect(paused).toEqual(pauseState(true));
      expect(ran.count).toBe(1);
    }),
  );

  effect("never retries here what the daemon refused", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = [];
      yield* serve(dispatched, { count: 0 });
      const ran = { count: 0 };

      const failed = yield* Effect.result(
        throughDaemon(DaemonEnrollmentCommands.PauseRepoCommand({ name: "nope" }), here(ran)),
      );

      expect(Result.isFailure(failed)).toBe(true);
      expect(ran.count).toBe(0);
      expect(dispatched.map((each) => each.tag)).toEqual(["PauseRepoCommand"]);
    }),
  );
});

describe("the live view's settings keys", () => {
  effect("reach the daemon's route: a flow off, a schedule, an account, a pause", () =>
    Effect.gen(function* () {
      const dispatched: Array<Dispatched> = [];
      yield* serve(dispatched, { count: 0 });

      // What the settings view's keys produce (test/tui.test.ts): e on a flow,
      // a schedule typed, an account picked, and p on a repo, twice.
      const actions: ReadonlyArray<SettingAction> = [
        {
          kind: "toggle-flow",
          repo: "demo",
          flow: "implement",
          persona: Option.some("alice"),
          enabled: false,
        },
        {
          kind: "set-schedule",
          repo: "demo",
          flow: "implement",
          persona: Option.some("alice"),
          schedule: Option.some("*/20 * * * *"),
        },
        {
          kind: "set-account",
          repo: "demo",
          persona: Option.some("alice"),
          role: Option.none(),
          account: Option.some("work"),
        },
        { kind: "pause", repo: "demo", paused: true },
        { kind: "pause", repo: "demo", paused: false },
      ];

      for (const action of actions) {
        yield* applySetting(action);
      }

      expect(dispatched).toEqual([
        {
          tag: "SetPersonaFlowCommand",
          payload: {
            name: "demo",
            persona: Option.some("alice"),
            flow: "implement",
            enabled: false,
          },
        },
        {
          tag: "SetFlowScheduleCommand",
          payload: {
            name: "demo",
            persona: Option.some("alice"),
            flow: "implement",
            schedule: Option.some("*/20 * * * *"),
          },
        },
        {
          tag: "SetPersonaAccountCommand",
          payload: {
            name: "demo",
            persona: Option.some("alice"),
            role: Option.none(),
            account: Option.some("work"),
            offered: { personas: ["alice"], accounts: [{ name: "work", agent: "claude" }] },
          },
        },
        { tag: "PauseRepoCommand", payload: { name: "demo" } },
        { tag: "ResumeRepoCommand", payload: { name: "demo" } },
      ]);
    }),
  );
});

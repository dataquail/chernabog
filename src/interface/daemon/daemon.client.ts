// The CLI and TUI talk to the daemon over a local socket and never open the
// workflow engine themselves.

import { type Command } from "@effect-server-utils/cqrs";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CancelledRun, RunHistory } from "../../modules/runs/runs.platform.ts";
import { Home, homePaths } from "../../platform/home.ts";
import {
  CancelRequest,
  DaemonStatus,
  Refusal,
  Reloaded,
  RunReply,
  RunRequest,
  TickResult,
} from "./daemon.protocol.ts";
import {
  daemonEnrollmentCommands,
  daemonTrustCommands,
  wireSchemas,
} from "./daemon-commands.client.ts";

export class DaemonUnavailable extends Schema.TaggedError<
  DaemonUnavailable,
  { readonly brand: "DaemonUnavailable" }
>()("DaemonUnavailable", {
  message: Schema.String,
}) {}

export class DaemonRefused extends Schema.TaggedError<
  DaemonRefused,
  { readonly brand: "DaemonRefused" }
>()("DaemonRefused", {
  message: Schema.String,
}) {}

// The daemon's answer to a request, whatever its status; none when no daemon answers.
const exchange = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const socket = homePaths((yield* Home).root).socket;

    if (!(yield* fs.exists(socket).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new DaemonUnavailable({
        message:
          "the daemon is not running (start it with chernabog start, or chernabog install the first time)",
      });
    }

    const client = yield* HttpClient.HttpClient;
    // Bun's fetch reaches a unix socket through its own `unix` option.
    const overSocket: BunFetchRequestInit = { unix: socket };

    return yield* client.execute(HttpClientRequest.prependUrl(request, "http://chernabog")).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, overSocket),
      Effect.mapError(
        () => new DaemonUnavailable({ message: `the daemon is not answering on ${socket}` }),
      ),
    );
  });

// What the daemon refused with, as it said it; none when it said nothing readable.
const refusalOf = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(Refusal)(response).pipe(Effect.option);

const refusedWith = (
  response: HttpClientResponse.HttpClientResponse,
  refusal: Option.Option<Refusal>,
) =>
  new DaemonRefused({
    message: Option.match(refusal, {
      onNone: () => `HTTP ${response.status}`,
      onSome: (said) => said.error,
    }),
  });

const send = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const response = yield* exchange(request);

    if (response.status < 400) {
      return response;
    }

    return yield* refusedWith(response, yield* refusalOf(response));
  });

const reply =
  <S extends Schema.Constraint>(schema: S) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(
        (error) =>
          new DaemonRefused({
            message: `unexpected reply from the daemon: ${error.message}`,
          }),
      ),
    );

const withRequest = (request: HttpClientRequest.HttpClientRequest, body: RunRequest) =>
  HttpClientRequest.schemaBodyJson(RunRequest)(request, body).pipe(
    Effect.mapError((error) => new DaemonRefused({ message: error.message })),
  );

export const daemonStatus = send(HttpClientRequest.get("/status")).pipe(
  Effect.flatMap(reply(DaemonStatus)),
);

export const daemonRun = (request: RunRequest) =>
  withRequest(HttpClientRequest.post("/run"), request).pipe(
    Effect.flatMap(send),
    Effect.flatMap(reply(TickResult)),
  );

export const daemonTick = (request: RunRequest) =>
  withRequest(HttpClientRequest.post("/tick"), request).pipe(
    Effect.flatMap(send),
    Effect.flatMap(reply(TickResult)),
  );

export const daemonReload = send(HttpClientRequest.post("/reload")).pipe(
  Effect.flatMap(reply(Reloaded)),
);

export const daemonRunRow = (runId: string) =>
  send(HttpClientRequest.get(`/runs/${encodeURIComponent(runId)}`)).pipe(
    Effect.flatMap(reply(RunReply)),
  );

// The steps a run has entered and the signals it waits on.
export const daemonRunHistory = (runId: string) =>
  send(HttpClientRequest.get(`/runs/${encodeURIComponent(runId)}/history`)).pipe(
    Effect.flatMap(reply(RunHistory)),
  );

export const daemonCancel = (request: CancelRequest) =>
  HttpClientRequest.schemaBodyJson(CancelRequest)(HttpClientRequest.post("/cancel"), request).pipe(
    Effect.mapError((error) => new DaemonRefused({ message: error.message })),
    Effect.flatMap(send),
    Effect.flatMap(reply(CancelledRun)),
  );

// A command dispatched on the daemon's bus (POST /commands/:tag), encoded and
// decoded with the command's own schemas. It fails with the command's own
// error when the daemon's dispatch did, DaemonRefused when the daemon refused
// it otherwise, and DaemonUnavailable when no daemon answers. `M` is the
// command `command` is: a group keeps its messages erased.
const daemonDispatch = <M extends Command.Any>(
  command: Command.Any,
  payload: Command.Payload<M>,
): Effect.Effect<
  Command.Success<M>,
  Command.Failure<M> | DaemonUnavailable | DaemonRefused,
  FileSystem.FileSystem | Home | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const schemas = wireSchemas<M>(command);

    const request = yield* HttpClientRequest.schemaBodyJson(schemas.payload)(
      HttpClientRequest.post(`/commands/${encodeURIComponent(command.tag)}`),
      payload,
    ).pipe(Effect.mapError((error) => new DaemonRefused({ message: error.message })));

    const response = yield* exchange(request);

    if (response.status < 400) {
      return yield* reply(schemas.success)(response);
    }

    const refusal = yield* refusalOf(response);

    const failure = yield* Option.match(
      Option.flatMap(refusal, (said) => Option.fromUndefinedOr(said.failure)),
      {
        onNone: () => Effect.succeedNone,
        onSome: (encoded) =>
          Schema.decodeUnknownEffect(Schema.toCodecJson(schemas.failure))(encoded).pipe(
            Effect.option,
          ),
      },
    );

    if (Option.isSome(failure)) {
      return yield* Effect.fail(failure.value);
    }

    // The route's own 404 always says why. A bare one is a daemon from before
    // the route, between an upgrade and its restart: it can't dispatch the
    // command, so it has refused nothing, and the command is dispatched here.
    if (response.status === 404 && Option.isNone(refusal)) {
      return yield* new DaemonUnavailable({
        message:
          "the running daemon predates this chernabog's /commands route; it restarts on this chernabog once its runs finish",
      });
    }

    return yield* refusedWith(response, refusal);
  });

// What dispatching a module's commands through the daemon offers: the calls
// its own dispatcher does, each also failing when the daemon is gone or refused.
export type DaemonDispatcher<G extends Command.AnyGroup> = {
  readonly [Tag in Command.Tags<G>]: (
    payload: Command.Payload<Command.Subset<G, Tag>>,
  ) => Effect.Effect<
    Command.Success<Command.Subset<G, Tag>>,
    Command.Failure<Command.Subset<G, Tag>> | DaemonUnavailable | DaemonRefused,
    FileSystem.FileSystem | Home | HttpClient.HttpClient
  >;
};

// The call for one of a group's commands, by its tag.
const callOf =
  <G extends Command.AnyGroup>(group: G) =>
  <Tag extends Command.Tags<G>>(tag: Tag) =>
  (payload: Command.Payload<Command.Subset<G, Tag>>) =>
    Effect.flatMap(
      Effect.fromOption(Arr.findFirst(group.messages, (command) => command.tag === tag)).pipe(
        Effect.orDie,
      ),
      (command) => daemonDispatch<Command.Subset<G, Tag>>(command, payload),
    );

const enrollmentCall = callOf(daemonEnrollmentCommands);

// Enrollment's commands the daemon dispatches, offered as EnrollmentCommands
// offers them.
export const DaemonEnrollmentCommands = {
  ApplyEnrollmentCommand: enrollmentCall("ApplyEnrollmentCommand"),
  UnenrollRepoCommand: enrollmentCall("UnenrollRepoCommand"),
  PauseRepoCommand: enrollmentCall("PauseRepoCommand"),
  ResumeRepoCommand: enrollmentCall("ResumeRepoCommand"),
  SetPersonaFlowCommand: enrollmentCall("SetPersonaFlowCommand"),
  SetFlowScheduleCommand: enrollmentCall("SetFlowScheduleCommand"),
  SetPersonaAccountCommand: enrollmentCall("SetPersonaAccountCommand"),
} satisfies DaemonDispatcher<typeof daemonEnrollmentCommands>;

// Trust's command the daemon dispatches, offered as TrustCommands offers it.
export const DaemonTrustCommands = {
  TrustRepoCommand: callOf(daemonTrustCommands)("TrustRepoCommand"),
} satisfies DaemonDispatcher<typeof daemonTrustCommands>;

// A command through the daemon first, so its events reach the daemon's bus;
// dispatched here only when no daemon answers. A refusal from the daemon is
// the answer, never retried here.
export const throughDaemon = <A, E, R, A2, E2, R2>(
  viaDaemon: Effect.Effect<A, E | DaemonUnavailable, R>,
  here: Effect.Effect<A2, E2, R2>,
) => viaDaemon.pipe(Effect.catchTag("DaemonUnavailable", () => here));

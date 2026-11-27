// The hub's session API (ADR 24, "The session API"): a TCP listener of its
// own, apart from the daemon's socket and the dashboard's listener, whose
// only routes are one agent session's:
//
//   POST /runs/:run/sessions/:session/stop      Claude's Stop hook
//   POST /runs/:run/sessions/:session/question  its AskUserQuestion hook
//   PUT  /runs/:run/sessions/:session/answer    the session's answer
//   POST /runs/:run/sessions/:session/commands/:name
//                                               one of SESSION_COMMANDS
//
// It forwards nothing to the socket, so `/commands/…`, `/dashboard/…` and
// the dashboard's `/api/…` don't exist here rather than being filtered. It
// binds 127.0.0.1 on a port the OS picks, and the gateway addresses it is
// given, which a container runtime's host gateway reaches, on the same port.
//
// Every request carries its session's token as `Authorization: Bearer`. The
// listener derives the token from the run and session the path names, with
// the key it drew as it opened (session-token.ts), and refuses any other; so
// a token reaches its own session's routes alone. The session must also be
// one its run launched, as its launch record says, so a run's key reaches
// none of another run's sessions. A token is revoked once its session ends
// (its `chernabog __launch` no longer runs, by agent.pid) or its run does:
// every route of either is refused with a 410. A request with an Origin
// header, a browser's, is refused.
//
// The routes act on the session dir in the chernabog home: stop and question
// are Claude's Stop and AskUserQuestion hooks (stop-hook.ts,
// open-pr-question.ts), which Claude calls as HTTP hooks, and whether a
// person works in the session comes from its launch record, never the request.

import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Headers from "effect/http/Headers";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  checkAnswer,
  knownLaunch,
  launchRuns,
  questionHook,
  readText,
  recordPullRequest,
  sessionFiles,
  stopHook,
} from "../../modules/runs/runs.platform.ts";
import { writeFileAtomic } from "../../platform/atomic-write.ts";
import { type Exec } from "../../platform/exec.ts";
import {
  newHubKey,
  runKey,
  sameSessionToken,
  SESSION_API_LOOPBACK,
  sessionToken,
} from "../../platform/session-token.ts";
import { Refusal } from "./daemon.protocol.ts";

// More than any answer or hook input, far less than Bun's default.
const MAX_BODY_BYTES = 1024 * 1024;

// A run's or session's id as a path names it: letters, digits and dashes,
// so no path elsewhere matches, encoded or not.
const ROUTE =
  /^\/runs\/([A-Za-z0-9-]{1,128})\/sessions\/([A-Za-z0-9-]{1,128})\/([a-z]+(?:\/[a-z-]{1,64})?)$/;

// What an agent session may ask of chernabog (#715): what the bundled prompts
// and recipes tell an agent to run, and nothing else, each taking its
// arguments as JSON. `open-pr` is `chernabog open-pr --draft`, so it takes
// `draft: true` and nothing less: without --draft it is the person's own way
// to finish, which no agent runs. A command off this list has no route.
const OpenPrArgs = Schema.Struct({
  draft: Schema.Literal(true),
  title: Schema.String,
  body: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
});

const COMMANDS = {
  "open-pr": OpenPrArgs,
} as const;

type CommandName = keyof typeof COMMANDS;

export const SESSION_COMMANDS: ReadonlyArray<string> = Object.keys(COMMANDS);

type RouteName = "stop" | "question" | "answer" | `commands/${CommandName}`;

const METHODS: Readonly<Record<RouteName, string>> = {
  stop: "POST",
  question: "POST",
  answer: "PUT",
  "commands/open-pr": "POST",
};

const isRouteName = (name: string): name is RouteName => Object.hasOwn(METHODS, name);

const JsonFile = Schema.fromJsonString(Schema.Json);

export type SessionApiOptions = {
  // The chernabog home, whose sessions/ the routes act on.
  readonly root: string;
  // Whether a run is live: one with a running spoke, or the foreground run
  // that is this process's. Every other run's routes are refused.
  readonly isLive: (runId: string) => Effect.Effect<boolean>;
  readonly log: (line: string) => Effect.Effect<void>;
  // Addresses beside loopback that a container runtime's host gateway
  // reaches; each is bound on the loopback's port, and one that can't be is
  // logged and left out.
  readonly gateways: ReadonlyArray<string>;
};

// An open session API: its port, the addresses it bound, and a run's key,
// which the hub hands the run's spoke to mint its sessions' tokens with.
export type SessionApi = {
  readonly port: number;
  readonly hosts: ReadonlyArray<string>;
  readonly runKey: (runId: string) => Uint8Array;
};

export class SessionApiRefused extends Schema.TaggedError<
  SessionApiRefused,
  { readonly brand: "SessionApiRefused" }
>()("SessionApiRefused", { message: Schema.String }) {}

const refuse = (status: number, error: string) =>
  HttpServerResponse.schemaJson(Refusal)({ error }, { status }).pipe(Effect.orDie);

// What a hook route answers: the hook's output, or nothing to let Claude go on.
const hookOutput = (printed: Option.Option<string>) =>
  HttpServerResponse.text(
    Option.getOrElse(printed, () => ""),
    {
      status: 200,
      contentType: "application/json",
    },
  );

const bearer = (headers: Headers.Headers) =>
  Option.flatMap(Headers.get(headers, "authorization"), (value) =>
    Option.fromNullishOr(/^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(value.trim())?.[1]),
  );

const describe = (cause: Cause.Cause<unknown>) => Cause.pretty(cause).split("\n")[0] ?? "";

export const openSessionApi = (options: SessionApiOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const services = yield* Effect.context<FileSystem.FileSystem | Exec>();
    const hubKey = yield* newHubKey;
    const keyOf = (runId: string) => runKey(hubKey, runId);

    // The routes change a session's files a step at a time; one call at a
    // time per session keeps two from interleaving their reads and writes,
    // while one session's slow git check holds up no other session. A lock
    // is a few bytes, and a hub sees few sessions before it restarts.
    const locks = new Map<string, Semaphore.Semaphore>();

    const lockOf = (sessionId: string) =>
      Option.getOrElse(Option.fromUndefinedOr(locks.get(sessionId)), () => {
        const made = Semaphore.makeUnsafe(1);
        locks.set(sessionId, made);

        return made;
      });

    const stop = (dir: string, files: ReturnType<typeof sessionFiles>) =>
      Effect.gen(function* () {
        const launch = yield* knownLaunch(files);
        const withPerson = Option.exists(launch, (record) => record.withPerson === true);

        return hookOutput(yield* stopHook(dir, withPerson));
      });

    const question = (dir: string) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* request.text;

        return hookOutput(yield* questionHook(dir, input));
      });

    const answer = (files: ReturnType<typeof sessionFiles>) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const text = yield* request.text;

        if (yield* fs.exists(files.done)) {
          return yield* refuse(409, "This session already handed its work to chernabog.");
        }

        const schema = Option.flatMap(yield* readText(files.schema), (found) =>
          Schema.decodeOption(JsonFile)(found),
        );

        const checked = checkAnswer(schema, Option.some(text));

        if (Result.isFailure(checked)) {
          return yield* refuse(422, checked.failure);
        }

        yield* writeFileAtomic(fs, files.answer, text);

        return HttpServerResponse.empty({ status: 204 });
      });

    // The session API's `open-pr`, as `chernabog open-pr --draft`: a refusal
    // is the CLI's own reason, as a 422, so the agent can fix it.
    const openPr = (files: ReturnType<typeof sessionFiles>) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const text = yield* request.text;

        const args = Schema.decodeUnknownOption(OpenPrArgs)(
          Option.getOrUndefined(Schema.decodeOption(JsonFile)(text)),
        );

        if (Option.isNone(args)) {
          return yield* refuse(
            422,
            'open-pr takes {"draft": true, "title": …, "body": …, "summary": …} as JSON; without draft it is the person\'s own, not a session\'s',
          );
        }

        const recorded = yield* Effect.result(
          recordPullRequest(files, {
            title: args.value.title,
            body: args.value.body ?? "",
            summary: Option.fromUndefinedOr(args.value.summary),
            draft: args.value.draft,
          }),
        );

        if (Result.isFailure(recorded)) {
          return yield* refuse(422, recorded.failure.message);
        }

        return HttpServerResponse.text(`${recorded.success.join("\n")}\n`, { status: 200 });
      });

    const handle = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const header = (name: string) => Headers.get(request.headers, name);

      if (Option.isSome(header("origin"))) {
        return yield* refuse(403, "the session API takes no requests from a browser");
      }

      const path = new URL(request.url, "http://session-api").pathname;

      const route = Option.flatMap(
        Option.fromNullishOr(ROUTE.exec(path)),
        ([, run, session, called]) =>
          Option.liftPredicate(
            { runId: run, sessionId: session, name: called },
            (found): found is { runId: string; sessionId: string; name: RouteName } =>
              isRouteName(found.name),
          ),
      );

      if (Option.isNone(route)) {
        return yield* refuse(404, `no route ${path}`);
      }

      const { name, runId, sessionId } = route.value;

      if (request.method !== METHODS[name]) {
        return yield* refuse(405, `${path} takes ${METHODS[name]}`);
      }

      const expected = sessionToken(keyOf(runId), sessionId);

      if (!Option.exists(bearer(request.headers), (given) => sameSessionToken(given, expected))) {
        return yield* refuse(401, "that token isn't this session's");
      }

      if (!(yield* options.isLive(runId))) {
        return yield* refuse(410, `run ${runId} has ended; nothing waits on this session`);
      }

      const files = sessionFiles(options.root, sessionId);

      return yield* Effect.gen(function* () {
        const launch = yield* knownLaunch(files);

        if (!Option.exists(launch, (record) => record.runId === runId)) {
          return yield* refuse(404, `no session ${sessionId} in run ${runId}`);
        }

        if (!(yield* launchRuns(files))) {
          return yield* refuse(410, `session ${sessionId} has ended; nothing waits on it`);
        }

        switch (name) {
          case "stop":
            return yield* stop(files.dir, files);
          case "question":
            return yield* question(files.dir);
          case "answer":
            return yield* answer(files);
          case "commands/open-pr":
            return yield* openPr(files);
        }
      }).pipe(lockOf(sessionId).withPermits(1));
    }).pipe(
      Effect.catchCause((cause) =>
        options
          .log(`session API: ${describe(cause)}`)
          .pipe(Effect.andThen(refuse(500, "the hub couldn't answer that"))),
      ),
    );

    const listen = (hostname: string, port: number) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();

        return yield* BunHttpServer.make({
          hostname,
          port,
          development: false,
          maxRequestBodySize: MAX_BODY_BYTES,
          disablePreemptiveShutdown: true,
        }).pipe(
          Effect.tap((server) => server.serve(handle.pipe(Effect.provide(services)))),
          Effect.map((server) => ({ scope, server })),
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
      });

    const first = yield* listen(SESSION_API_LOOPBACK, 0).pipe(
      Effect.mapError(
        (error) =>
          new SessionApiRefused({
            message: `can't listen on ${SESSION_API_LOOPBACK}: ${String(error)}`,
          }),
      ),
    );

    yield* Effect.addFinalizer(() => Scope.close(first.scope, Exit.void));

    const { address } = first.server;
    let port = 0;

    if (!Predicate.isTagged(address, "UnixPathAddress")) {
      ({ port } = address);
    }

    const hosts = [SESSION_API_LOOPBACK];

    for (const gateway of options.gateways) {
      const opened = yield* Effect.exit(listen(gateway, port));

      if (Exit.isSuccess(opened)) {
        yield* Effect.addFinalizer(() => Scope.close(opened.value.scope, Exit.void));
        hosts.push(gateway);
      } else {
        yield* options.log(
          `session API: can't listen on ${gateway}:${port} too (${describe(opened.cause)}); containers whose host gateway is ${gateway} won't reach it`,
        );
      }
    }

    yield* options.log(
      `session API listening on ${hosts.map((host) => `${host}:${port}`).join(", ")}`,
    );

    return { port, hosts, runKey: keyOf } satisfies SessionApi;
  });

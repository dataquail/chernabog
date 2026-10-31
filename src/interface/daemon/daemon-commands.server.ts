// POST /commands/:tag: an allowlisted command (daemon-commands.client.ts)
// dispatched on the daemon's merged CommandBus (docs/adr/0015-composition-roots.md),
// so what it says reaches the daemon's event bus. The body is the command's
// payload, decoded with its own schema; the answer is its success, encoded
// with its own, or a Refusal carrying its error's tag and the error, encoded
// with its failure schema. A tag not on the allowlist is refused 404.
// Socket-only for now (DAEMON_COMMAND_LISTENERS).

import { describeError } from "@chernabog/core";
import { CommandBus } from "@effect-server-utils/cqrs";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { Refusal } from "./daemon.protocol.ts";
import { daemonCommand, daemonCommandTags, wireSchemas } from "./daemon-commands.client.ts";

const CommandPath = Schema.Struct({ tag: Schema.String });

const refuse = (status: number, refusal: Refusal) =>
  HttpServerResponse.schemaJson(Refusal)(refusal, { status });

// What a failure carries that names it: every command's errors are tagged.
const Tagged = Schema.Struct({ _tag: Schema.String });

// What the route does with one request; `afterwards` runs once a dispatch
// succeeded, for the daemon to notice what it changed, as /reload does. The
// command has happened by then, so nothing afterwards may fail its answer.
export const dispatchCommandEndpoint = <R>(afterwards: Effect.Effect<void, never, R>) =>
  Effect.gen(function* () {
    const { tag } = yield* HttpRouter.schemaPathParams(CommandPath);
    const found = daemonCommand(tag);

    if (Option.isNone(found)) {
      return yield* refuse(404, {
        error: `the daemon dispatches no ${tag}; it dispatches ${daemonCommandTags.join(", ")}`,
      });
    }

    const command = found.value;
    const schemas = wireSchemas<typeof command>(command);

    const payload = yield* Effect.result(HttpServerRequest.schemaBodyJson(schemas.payload));

    if (Result.isFailure(payload)) {
      return yield* refuse(400, {
        error: `${tag}'s payload doesn't decode: ${describeError(payload.failure)}`,
      });
    }

    const bus = yield* CommandBus;
    const dispatched = yield* Effect.result(bus.execute(command, payload.success));

    if (Result.isFailure(dispatched)) {
      const encoded = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(schemas.failure))(
        dispatched.failure,
      ).pipe(Effect.option);

      return yield* refuse(422, {
        error: describeError(dispatched.failure),
        ...Option.match(Schema.decodeUnknownOption(Tagged)(dispatched.failure), {
          onNone: () => ({}),
          onSome: (tagged) => ({ tag: tagged._tag }),
        }),
        ...Option.match(encoded, {
          onNone: () => ({}),
          onSome: (failure) => ({ failure }),
        }),
      });
    }

    yield* afterwards;

    return yield* HttpServerResponse.schemaJson(schemas.success)(dispatched.success);
  });

// The route, for the daemon's server to register with its own `answer`.
export const commandsRoute = <X, R>(
  answer: <E2, R2>(
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E2, R2>,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, X, R2>,
  afterwards: Effect.Effect<void, never, R>,
) => HttpRouter.add("POST", "/commands/:tag", answer(dispatchCommandEndpoint(afterwards)));

// What each agent call of a run spent, recorded when the call ends, however
// it ends: the adapter reads its own records of the session since the
// session's cursor, and the run keeps a row per model. An adapter that can't
// say, or whose reader fails, leaves a row that says so (not reported is not
// zero) and the cursor where it was. Reading or recording usage never fails
// the call. Vendors stay behind the adapter: no flow learns of any of it.

import { Run } from "@chernabog/core";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { RunId } from "../../../../../kernel/run-id.id.ts";
import { type TokenUsageReading } from "../../../domain/token-usage/model-usage.value-object.ts";
import { type Adapter, type AdapterServices, type AgentSession } from "./adapter.ts";

export type TokenUsageCall = {
  readonly runId: RunId;
  readonly step: Option.Option<string>;
  readonly adapter: string;
  readonly sessionId: string;
  // None when the adapter couldn't say.
  readonly reading: Option.Option<TokenUsageReading>;
};

// Where a run's agent calls record what they spent: the engine provides it
// to the flows it runs, over the runs' commands and queries in state.db.
// Without it, as in a step's own process, nothing is recorded.
export class TokenUsageRecorder extends Context.Service<
  TokenUsageRecorder,
  {
    readonly cursor: (adapter: string, sessionId: string) => Effect.Effect<Option.Option<string>>;
    readonly record: (call: TokenUsageCall) => Effect.Effect<void>;
  }
>()("chernabog/TokenUsageRecorder") {}

// The adapter's reading of the session since `cursor`, or none when it has no
// reader, the cursor couldn't be read, or the reader failed or died.
const readingOf = (
  adapter: Adapter,
  session: AgentSession,
  cursor: Exit.Exit<Option.Option<string>>,
): Effect.Effect<Option.Option<TokenUsageReading>, never, AdapterServices> => {
  const reads = Option.fromUndefinedOr(adapter.usage);

  if (Option.isNone(reads) || Exit.isFailure(cursor)) {
    return Effect.succeedNone;
  }

  return Effect.exit(reads.value(session, cursor.value)).pipe(
    Effect.map((read) =>
      Option.liftPredicate(read, Exit.isSuccess).pipe(Option.map((ok) => ok.value)),
    ),
  );
};

// `call`, an agent call through `adapter` on `session`, recording what it
// spent when it ends, in a run whose engine records usage; else just `call`.
export const recordingTokenUsage =
  (
    adapter: Adapter,
    session: AgentSession,
    step: Option.Option<string>,
    log: (line: string) => Effect.Effect<void>,
  ) =>
  <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | AdapterServices> =>
    Effect.gen(function* () {
      const run = yield* Effect.serviceOption(Run);
      const recorder = yield* Effect.serviceOption(TokenUsageRecorder);

      if (Option.isNone(run) || Option.isNone(recorder)) {
        return yield* call;
      }

      const cursor = yield* Effect.exit(recorder.value.cursor(adapter.name, session.sessionId));

      const record = readingOf(adapter, session, cursor).pipe(
        Effect.flatMap((reading) =>
          recorder.value.record({
            runId: RunId.make(run.value.runId),
            step,
            adapter: adapter.name,
            sessionId: session.sessionId,
            reading,
          }),
        ),
        Effect.catchCause((cause) =>
          log(`chernabog: couldn't record what the agent call spent: ${Cause.pretty(cause)}`),
        ),
      );

      return yield* call.pipe(Effect.onExit(() => record));
    });

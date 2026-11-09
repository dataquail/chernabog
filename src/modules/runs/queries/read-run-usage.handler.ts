import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ComputeTime } from "../domain/domain-services/compute-time.domain-service.ts";
import { TokenUsageRow } from "../storage/token-usage.schema.ts";
import {
  ModelTokens,
  type ReadRunUsagePayload,
  RunTokens,
  RunUsage,
  StepTokens,
  TokenCounts,
} from "./read-run-usage.query.ts";

// What the run's steps and its finish are read as: only what compute time needs.
const StepTimes = Schema.Struct({
  step: Schema.String,
  entered_at: Schema.String,
  finished_at: Schema.NullOr(Schema.String),
});

const RunFinish = Schema.Struct({ finished_at: Schema.NullOr(Schema.String) });

// The counts of some rows summed, a count a row doesn't report adding nothing.
const countsOf = (rows: ReadonlyArray<TokenUsageRow>) => {
  const sum = (count: (row: TokenUsageRow) => Option.Option<number>) =>
    rows.reduce((total, row) => total + Option.getOrElse(count(row), () => 0), 0);

  const input = sum((row) => Option.fromNullOr(row.input));
  const output = sum((row) => Option.fromNullOr(row.output));
  const cacheRead = sum((row) => Option.fromNullOr(row.cache_read));
  const cacheWrite = sum((row) => Option.fromNullOr(row.cache_write));

  return TokenCounts.make({
    total: input + output + cacheRead + cacheWrite,
    input,
    output,
    cacheRead,
    cacheWrite,
  });
};

// The rows grouped by a key, in the order each key was first recorded.
const groupedBy = <K>(rows: ReadonlyArray<TokenUsageRow>, key: (row: TokenUsageRow) => K) =>
  Arr.dedupe(rows.map(key)).map((each) => [each, rows.filter((row) => key(row) === each)] as const);

const tokensOf = (rows: Arr.NonEmptyReadonlyArray<TokenUsageRow>) => {
  const unreported = (some: ReadonlyArray<TokenUsageRow>) => some.some((row) => row.reported === 0);

  return RunTokens.make({
    tokens: countsOf(rows),
    byModel: groupedBy(
      rows.filter((row) => row.reported !== 0),
      (row) => row.model,
    ).flatMap(([model, some]) =>
      Option.toArray(
        Option.map(Option.fromNullOr(model), (named) =>
          ModelTokens.make({ model: named, tokens: countsOf(some) }),
        ),
      ),
    ),
    byStep: groupedBy(rows, (row) => row.step).map(([step, some]) =>
      StepTokens.make({
        step: Option.fromNullOr(step),
        tokens: countsOf(some),
        byModel: [],
        unreported: unreported(some),
      }),
    ),
    unreported: unreported(rows),
  });
};

export const readRunUsageHandler = Effect.fn("readRunUsageHandler")(function* ({
  runId,
}: ReadRunUsagePayload) {
  const sql = yield* SqlClient.SqlClient;

  // Queries over the runs' own tables: a failure is a bug, not a condition.
  const usage =
    yield* sql`SELECT * FROM om_agent_usage WHERE run_id = ${runId} ORDER BY rowid`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TokenUsageRow))),
      Effect.orDie,
    );

  const steps = yield* sql`SELECT step, entered_at, finished_at FROM om_steps
    WHERE run_id = ${runId} ORDER BY entered_at, rowid`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StepTimes))),
    Effect.orDie,
  );

  const finish = yield* sql`SELECT finished_at FROM om_runs WHERE id = ${runId}`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RunFinish))),
    Effect.orDie,
  );

  const now = DateTime.formatIso(yield* DateTime.now);

  return RunUsage.make({
    tokens: Option.map(
      Arr.match(usage, { onEmpty: Option.none, onNonEmpty: Option.some }),
      tokensOf,
    ),
    computeMs: ComputeTime.of({
      steps: steps.map((row) => ({
        step: row.step,
        enteredAt: row.entered_at,
        finishedAt: Option.fromNullOr(row.finished_at),
      })),
      runFinishedAt: Option.flatMap(Arr.head(finish), (row) => Option.fromNullOr(row.finished_at)),
      now,
    }),
  });
});

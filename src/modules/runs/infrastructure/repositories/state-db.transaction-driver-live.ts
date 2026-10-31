// The transaction a runs command's unit of work opens in state.db, over the SQL
// client the runs' stores and the workflow engine's journal share.
//
// The client is one SQLite connection behind a one-permit semaphore, and a
// transaction holds that permit until it ends: every other statement in the
// process, the engine's journal included, waits for it. So a unit of work over
// this driver holds only the runs' own reads and writes, never a call to
// GitHub, git, a launcher or the engine (docs/adr/0009-commands-declare-their-unit-of-work.md).

import { TransactionDriver, TransactionFailed } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

// The client's own errors at the boundary are its BEGIN, COMMIT or SAVEPOINT
// failing: the stores turn theirs into defects before they get here.
const asTransactionFailed = <E>(error: E | SqlError.SqlError) => {
  if (SqlError.isSqlError(error)) {
    return new TransactionFailed({ message: error.message });
  }

  return error;
};

export const StateDbTransactionDriverLive = Layer.effect(
  TransactionDriver,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // The client is depth-aware: inside a transaction it opens a savepoint.
    const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql.withTransaction(effect).pipe(Effect.mapError(asTransactionFailed));

    return TransactionDriver.of({
      withTransaction: scoped,
      withSavepoint: scoped,
      isActive: Effect.map(Effect.serviceOption(sql.transactionService), Option.isSome),
    });
  }),
);

// Holds in om_holds, in state.db: each flow's latest, which the daemon replaces
// every tick and `status` reads.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type HoldsRoot } from "../../domain/holds/holds.root.ts";
import { HoldsRepository } from "../../domain/ports/repositories/holds.repository.ts";
import { HoldColumns, toRoots } from "./hold.mapper.ts";

export const HoldsRepositoryLive = Layer.effect(
  HoldsRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS om_holds (
      repo TEXT NOT NULL,
      persona TEXT,
      flow TEXT NOT NULL,
      item_key TEXT NOT NULL,
      reason TEXT NOT NULL,
      at TEXT NOT NULL
    )`;

    // Queries this adapter wrote against its own table: a failure is a bug, not a condition.
    const findAll = sql`SELECT * FROM om_holds ORDER BY repo, flow, persona, rowid`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(HoldColumns))),
      Effect.map(toRoots),
      Effect.orDie,
    );

    const save = (holds: HoldsRoot) =>
      Effect.gen(function* () {
        const persona = Option.getOrNull(holds.persona);
        yield* sql`DELETE FROM om_holds WHERE repo = ${holds.repo} AND flow = ${holds.flow} AND persona IS ${persona}`;

        for (const item of holds.items) {
          yield* sql`INSERT INTO om_holds (repo, persona, flow, item_key, reason, at) VALUES (${holds.repo}, ${persona}, ${holds.flow}, ${item.itemKey}, ${item.reason}, ${holds.at})`;
        }
      }).pipe(sql.withTransaction, Effect.asVoid, Effect.orDie);

    return HoldsRepository.of({ findAll, save });
  }).pipe(Effect.orDie),
);

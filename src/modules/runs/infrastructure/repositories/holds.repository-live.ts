// Holds in om_holds, in state.db: each flow's latest, which the daemon replaces
// every tick and `status` reads.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type Specification } from "../../../../kernel/specification.ts";
import { HoldsRepository } from "../../domain/holds/holds.repository.ts";
import { type HoldsRoot } from "../../domain/holds/holds.root.ts";
import { criteriaToWhere } from "./criteria-to-sql.ts";
import { HoldColumns, holdsColumns, toRoots } from "./hold.mapper.ts";

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
    const findMany = (spec: Specification<HoldsRoot>) =>
      criteriaToWhere(sql, spec.criteria, holdsColumns).pipe(
        Effect.flatMap(
          (where) => sql`SELECT * FROM om_holds WHERE ${where} ORDER BY repo, flow, persona, rowid`,
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(HoldColumns))),
        Effect.map(toRoots),
        Effect.orDie,
      );

    const upsertOne = (holds: HoldsRoot) =>
      Effect.gen(function* () {
        const persona = Option.getOrNull(holds.persona);
        yield* sql`DELETE FROM om_holds WHERE repo = ${holds.repo} AND flow = ${holds.flow} AND persona IS ${persona}`;

        for (const item of holds.items) {
          yield* sql`INSERT INTO om_holds (repo, persona, flow, item_key, reason, at) VALUES (${holds.repo}, ${persona}, ${holds.flow}, ${item.itemKey}, ${item.reason}, ${holds.at})`;
        }
      }).pipe(sql.withTransaction, Effect.asVoid, Effect.orDie);

    return HoldsRepository.of({ findMany, upsertOne });
  }).pipe(Effect.orDie),
);

import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { type Criteria, Spec } from "../../../../kernel/specification.ts";
import { type ColumnMap, criteriaToWhere } from "./criteria-to-sql.ts";

type Row = {
  readonly id: string;
  readonly acceptedAt: Option.Option<string>;
  readonly revokedAt: Option.Option<string>;
};

const columns: ColumnMap = { id: "id", acceptedAt: "accepted_at", revokedAt: "revoked_at" };

const Ids = Schema.Array(Schema.Struct({ id: Schema.String }));

// The fragment as SQLite's compiler renders it, and the ids of the rows it selects.
const where = (criteria: Criteria) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fragment = yield* criteriaToWhere(sql, criteria, columns);
    const statement = sql`SELECT id FROM invites WHERE ${fragment} ORDER BY id`;
    const [text, params] = statement.compile();
    const ids = (yield* Schema.decodeUnknownEffect(Ids)(yield* statement)).map((row) => row.id);

    return { text: text.replace(/^SELECT id FROM invites WHERE | ORDER BY id$/g, ""), params, ids };
  });

const invites = sqliteAfter(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE invites (id TEXT, accepted_at TEXT, revoked_at TEXT)`;
    yield* sql`INSERT INTO invites VALUES ('a', NULL, NULL), ('b', 'x', NULL), ('c', NULL, 'y')`;
  }),
);

describe("criteriaToWhere", () => {
  effect("compiles composed null checks to a WHERE fragment with no parameters", () =>
    Effect.gen(function* () {
      const isOpen = Spec.not(
        Spec.or(Spec.isNotNull<Row>("acceptedAt"), Spec.isNotNull<Row>("revokedAt")),
      );

      const { ids, params, text } = yield* where(isOpen.criteria);
      expect(text).toBe('(NOT ("accepted_at" IS NOT NULL OR "revoked_at" IS NOT NULL))');
      expect(params).toEqual([]);
      expect(ids).toEqual(["a"]);
    }).pipe(Effect.provide(invites)),
  );

  effect("binds an Eq's value as a parameter, never into the text", () =>
    Effect.gen(function* () {
      const { ids, params, text } = yield* where(Spec.eq<Row, "id">("id", "b").criteria);
      expect(text).toBe('"id" = ?');
      expect(params).toEqual(["b"]);
      expect(ids).toEqual(["b"]);
    }).pipe(Effect.provide(invites)),
  );

  effect("joins a key and a variant into one AND", () =>
    Effect.gen(function* () {
      const spec = Spec.and(Spec.eq<Row, "id">("id", "c"), Spec.isNull<Row>("acceptedAt"));
      const { ids, text } = yield* where(spec.criteria);
      expect(text).toBe('("id" = ? AND "accepted_at" IS NULL)');
      expect(ids).toEqual(["c"]);
    }).pipe(Effect.provide(invites)),
  );

  effect("compiles an empty conjunction to TRUE and an empty disjunction to FALSE", () =>
    Effect.gen(function* () {
      expect((yield* where(Spec.all<Row>().criteria)).ids).toEqual(["a", "b", "c"]);
      expect((yield* where(Spec.or<Row>().criteria)).ids).toEqual([]);
    }).pipe(Effect.provide(invites)),
  );

  effect("dies on a field with no column, a bug rather than a query", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const exit = yield* Effect.exit(
        criteriaToWhere(sql, Spec.eq<Row, "id">("id", "a").criteria, { acceptedAt: "accepted_at" }),
      );

      expect(Exit.hasDies(exit)).toBe(true);
    }).pipe(Effect.provide(invites)),
  );
});

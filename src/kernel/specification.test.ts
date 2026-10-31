import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { Criteria, pinnedValue, Spec } from "./specification.ts";

type Row = {
  readonly id: string;
  readonly acceptedAt: Option.Option<string>;
  readonly revokedAt: Option.Option<string>;
};

const open = (row: Partial<Row> = {}): Row => ({
  id: "1",
  acceptedAt: Option.none(),
  revokedAt: Option.none(),
  ...row,
});

describe("Spec builders: a predicate and its criteria in one object", () => {
  test("eq matches by field and records an Eq criterion", () => {
    const withId = Spec.eq<Row, "id">("id", "abc");
    expect(withId(open({ id: "abc" }))).toBe(true);
    expect(withId(open({ id: "xyz" }))).toBe(false);
    expect(withId.criteria).toEqual(Criteria.Eq({ field: "id", value: "abc" }));
  });

  test("isNull and isNotNull read an Option field's None as null", () => {
    const accepted = Spec.isNotNull<Row>("acceptedAt");
    expect(accepted(open({ acceptedAt: Option.some("2026-01-01") }))).toBe(true);
    expect(accepted(open())).toBe(false);
    expect(Spec.isNull<Row>("acceptedAt")(open())).toBe(true);
    expect(accepted.criteria).toEqual(Criteria.IsNotNull({ field: "acceptedAt" }));
  });

  test("and, or and not compose both the predicate and the AST", () => {
    const isOpen = Spec.not(
      Spec.or(Spec.isNotNull<Row>("acceptedAt"), Spec.isNotNull<Row>("revokedAt")),
    );

    expect(isOpen(open())).toBe(true);
    expect(isOpen(open({ acceptedAt: Option.some("2026-01-01") }))).toBe(false);
    expect(isOpen(open({ revokedAt: Option.some("2026-01-01") }))).toBe(false);

    expect(isOpen.criteria).toEqual(
      Criteria.Not({
        node: Criteria.Or({
          nodes: [
            Criteria.IsNotNull({ field: "acceptedAt" }),
            Criteria.IsNotNull({ field: "revokedAt" }),
          ],
        }),
      }),
    );
  });

  test("all holds of everything, and an empty or of nothing", () => {
    expect(Spec.all<Row>()(open())).toBe(true);
    expect(Spec.all<Row>().criteria).toEqual(Criteria.And({ nodes: [] }));
    expect(Spec.or<Row>()(open())).toBe(false);
  });
});

describe("pinnedValue", () => {
  test("finds the value an Eq pins a field to, alone or in a conjunction", () => {
    const spec = Spec.and(Spec.isNull<Row>("acceptedAt"), Spec.eq<Row, "id">("id", "abc"));
    expect(pinnedValue(spec.criteria, "id")).toEqual(Option.some("abc"));
    expect(pinnedValue(Spec.eq<Row, "id">("id", "abc").criteria, "id")).toEqual(Option.some("abc"));
  });

  test("finds none under a disjunction or a negation, or for another field", () => {
    const either = Spec.or(Spec.eq<Row, "id">("id", "a"), Spec.eq<Row, "id">("id", "b"));
    expect(pinnedValue(either.criteria, "id")).toEqual(Option.none());
    expect(pinnedValue(Spec.not(Spec.eq<Row, "id">("id", "a")).criteria, "id")).toEqual(
      Option.none(),
    );
    expect(pinnedValue(Spec.eq<Row, "id">("id", "a").criteria, "acceptedAt")).toEqual(
      Option.none(),
    );
  });
});

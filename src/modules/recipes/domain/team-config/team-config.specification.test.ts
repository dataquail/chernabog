import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { pinnedValue } from "../../../../kernel/specification.ts";
import { TeamConfigRoot } from "./team-config.root.ts";
import { TeamConfigSpecifications } from "./team-config.specification.ts";

const configOf = (root: string) =>
  TeamConfigRoot.make({
    root,
    agent: Option.none(),
    runners: Option.none(),
    reviewers: Option.none(),
    flows: {},
  });

describe("TeamConfigSpecifications", () => {
  test("ofCheckout holds of one checkout's config, and pins its root", () => {
    const spec = TeamConfigSpecifications.ofCheckout("/a");

    expect([configOf("/a"), configOf("/b")].filter(spec)).toEqual([configOf("/a")]);
    expect(pinnedValue(spec.criteria, "root")).toEqual(Option.some("/a"));
  });
});

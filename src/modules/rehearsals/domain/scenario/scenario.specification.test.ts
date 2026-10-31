import { describe, expect, test } from "bun:test";

import { Criteria, pinnedValue } from "../../../../kernel/specification.ts";
import { ScenarioRoot } from "./scenario.root.ts";
import { ScenarioSpecifications } from "./scenario.specification.ts";

const scenario = (path: string) =>
  ScenarioRoot.make({ path, dir: "/rehearsals", repo: "you/scratch" });

describe("ScenarioSpecifications", () => {
  test("atPath holds of the scenario in that file only, and pins its path", () => {
    const spec = ScenarioSpecifications.atPath("/rehearsals/implement.yaml");
    expect(spec(scenario("/rehearsals/implement.yaml"))).toBe(true);
    expect(spec(scenario("/rehearsals/review.yaml"))).toBe(false);
    expect(spec.criteria).toEqual(
      Criteria.Eq({ field: "path", value: "/rehearsals/implement.yaml" }),
    );
    expect(pinnedValue(spec.criteria, "path")._tag).toBe("Some");
  });
});

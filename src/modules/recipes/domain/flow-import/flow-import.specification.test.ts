import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { pinnedValue, Spec } from "../../../../kernel/specification.ts";
import { FlowImportRoot } from "./flow-import.root.ts";
import { FlowImportSpecifications } from "./flow-import.specification.ts";

const imported = (root: string, flow: string) =>
  FlowImportRoot.make({ root, flow, from: `@chernabog/recipes/${flow}` });

const imports = [imported("/a", "review"), imported("/a", "merge"), imported("/b", "review")];

describe("FlowImportSpecifications", () => {
  test("inCheckout holds of one checkout's imports, and pins its root", () => {
    const spec = FlowImportSpecifications.inCheckout("/a");
    expect(imports.filter(spec)).toEqual([imports[0], imports[1]]);
    expect(pinnedValue(spec.criteria, "root")).toEqual(Option.some("/a"));
  });

  test("forFlow narrows a checkout's imports to one flow", () => {
    const spec = Spec.and(
      FlowImportSpecifications.inCheckout("/b"),
      FlowImportSpecifications.forFlow("review"),
    );

    expect(imports.filter(spec)).toEqual([imported("/b", "review")]);
    expect(pinnedValue(spec.criteria, "root")).toEqual(Option.some("/b"));
  });
});

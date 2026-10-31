import { describe, expect, test } from "bun:test";

import { Criteria } from "../../../../kernel/specification.ts";
import { MachineSetupRootOps } from "./machine-setup.root-ops.ts";
import { MachineSetupSpecifications } from "./machine-setup.specification.ts";

describe("MachineSetupSpecifications", () => {
  test("thisMachine holds of the one setup there is, as an empty conjunction", () => {
    expect(MachineSetupSpecifications.thisMachine(MachineSetupRootOps.unset)).toBe(true);
    expect(MachineSetupSpecifications.thisMachine.criteria).toEqual(Criteria.And({ nodes: [] }));
  });
});

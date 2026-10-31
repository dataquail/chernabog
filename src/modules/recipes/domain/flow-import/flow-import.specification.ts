import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type FlowImportRoot } from "./flow-import.root.ts";

// Every flow the checkout at `root` imports.
const inCheckout = (root: string): Specification<FlowImportRoot> =>
  Spec.eq<FlowImportRoot, "root">("root", root);

// The import of one flow, in whichever checkout.
const forFlow = (flow: string): Specification<FlowImportRoot> =>
  Spec.eq<FlowImportRoot, "flow">("flow", flow);

export const FlowImportSpecifications = { inCheckout, forFlow } as const;

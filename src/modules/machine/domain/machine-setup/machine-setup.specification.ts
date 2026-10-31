import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type MachineSetupRoot } from "./machine-setup.root.ts";

// This machine's setup: the only one there is, so a spec that holds of any.
const thisMachine: Specification<MachineSetupRoot> = Spec.all<MachineSetupRoot>();

export const MachineSetupSpecifications = { thisMachine } as const;

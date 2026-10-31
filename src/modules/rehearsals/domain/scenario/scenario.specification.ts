import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type ScenarioRoot } from "./scenario.root.ts";

// The scenario in the file at `path`.
const atPath = (path: string): Specification<ScenarioRoot> =>
  Spec.eq<ScenarioRoot, "path">("path", path);

export const ScenarioSpecifications = { atPath } as const;

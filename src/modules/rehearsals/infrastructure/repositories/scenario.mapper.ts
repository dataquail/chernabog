import * as Option from "effect/Option";

import { type ScenarioFile } from "../../../../kernel/scenario.value-object.ts";
import { ScenarioRoot } from "../../domain/scenario/scenario.root.ts";

const directoryOf = (path: string) =>
  Option.getOrElse(
    Option.liftPredicate(
      path.slice(0, Math.max(path.lastIndexOf("/"), 0)),
      (dir) => dir.length > 0,
    ),
    () => "/",
  );

// A scenario file as the aggregate it is, at the path it was read from.
export const toRoot = (path: string, file: ScenarioFile) =>
  ScenarioRoot.make({ ...file, path, dir: directoryOf(path) });

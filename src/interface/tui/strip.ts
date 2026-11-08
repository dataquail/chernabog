// A run row's strip: the run's path through its plan, as RunOnPlan draws it.

import * as Option from "effect/Option";

import type { RunOnPlan } from "../daemon/daemon.protocol.ts";
import type { Line } from "./view.ts";

export const runStrip = (_onPlan: RunOnPlan, _width: number): Option.Option<Line> => Option.none();

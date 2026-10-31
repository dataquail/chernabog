// How the daemon learns that a run ended: not yet.

import { EventBus } from "@effect-server-utils/cqrs";
import * as Effect from "effect/Effect";

import { type RunView } from "../../modules/runs/runs.platform.ts";

export const subscribeRunEndings = (_react: (ended: RunView) => Effect.Effect<void>) =>
  EventBus.use(() => Effect.void);

// Posting a comment as a step of its own, with no other effect. A replay finds
// it posted, so each distinct comment on an issue or pull request posts once
// per run.

import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";

import { activity } from "../abi/flow.ts";
import { GitHub } from "../abi/services.ts";

export const commentStep = (kind: "issue" | "pr", number: number, body: string) =>
  activity(
    `comment-${kind}-${number}-${createHash("sha256").update(body).digest("hex").slice(0, 12)}`,
    GitHub.use((github) => github.comment(number, body)).pipe(Effect.asVoid),
  );

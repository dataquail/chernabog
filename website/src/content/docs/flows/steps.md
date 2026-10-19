---
title: Steps
description: Effect and shell steps in .chernabog/stages/, and their exit codes.
---

A flow runs a step from `.chernabog/stages/` with `step("name", input, { output })`. Each runs in its own process, as one activity.

| Kind   | File                 | Contract                                                                    |
| ------ | -------------------- | --------------------------------------------------------------------------- |
| Effect | `name.ts`            | default-exports `defineStage({ name, input, output, run })`; gets the SDK's services |
| Shell  | `name`, executable   | reads `{ input, repo, run }` as JSON on stdin; prints its output as JSON on the last line of stdout |

| Exit   | Means          |
| ------ | -------------- |
| `0`    | continue       |
| `78`   | skip the run   |
| other  | fail the run   |

A step that crashes partway runs again, so every step must be safe to repeat.

```ts
// .chernabog/stages/find-work.ts
import { defineStage, GitHub, Skip } from "@chernabog/sdk";
import { Effect, Schema } from "effect";

export default defineStage({
  name: "find-work",
  input: Schema.Struct({}),
  output: Schema.Struct({ issue: Schema.Number }),
  run: () =>
    Effect.gen(function* () {
      const issue = yield* (yield* GitHub).oldestQueued;
      if (issue === undefined) return yield* new Skip({ reason: "nothing queued" });
      return { issue };
    }),
});
```

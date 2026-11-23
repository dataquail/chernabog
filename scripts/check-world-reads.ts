// `bun run lint:architecture`'s check that no source reads the world back as
// a record (world-reads.ts): run with `bun scripts/check-world-reads.ts`. It
// prints each read and fails when there is one.

import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { describeRead, treeReads } from "./world-reads.ts";

const program = Effect.gen(function* () {
  const reads = yield* treeReads();

  for (const read of reads) {
    yield* Console.error(describeRead(read));
  }

  if (reads.length > 0) {
    return yield* Effect.fail(
      `${reads.length} read(s) of the world back as a record (ADR 21: the world is input, never record). See scripts/world-reads.ts.`,
    );
  }
});

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));

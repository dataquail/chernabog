import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunLogsClientFake } from "../infrastructure/clients/run-logs.client-fake.ts";
import { followRunLogHandler } from "./follow-run-log.handler.ts";

const a = RunId.make("a");

describe("followRunLogHandler", () => {
  const logs = { a: "started\n" };

  effect("reads what the log gained from an offset, as one piece, and where to read next", () =>
    Effect.gen(function* () {
      const first = yield* followRunLogHandler({ runId: a, from: 0 });

      expect([first.text, first.next]).toEqual([Option.some("started"), 8]);

      logs.a = `${logs.a}step: implement\nfinished: done\n`;
      const second = yield* followRunLogHandler({ runId: a, from: first.next });

      expect([second.text, second.next]).toEqual([
        Option.some("step: implement\nfinished: done"),
        39,
      ]);
      expect(yield* followRunLogHandler({ runId: a, from: second.next })).toMatchObject({
        text: Option.none(),
        next: 39,
      });
    }).pipe(Effect.provide(RunLogsClientFake(logs))),
  );

  effect("gains nothing from a log not written yet, or only whitespace", () =>
    Effect.gen(function* () {
      expect(yield* followRunLogHandler({ runId: RunId.make("b"), from: 0 })).toMatchObject({
        text: Option.none(),
        next: 0,
      });
      expect(yield* followRunLogHandler({ runId: a, from: 0 })).toMatchObject({
        text: Option.none(),
        next: 2,
      });
    }).pipe(Effect.provide(RunLogsClientFake({ a: "\n\n" }))),
  );
});

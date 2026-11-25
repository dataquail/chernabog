import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import { type RunId } from "../../../../kernel/run-id.id.ts";
import { RunSpokesClient } from "../../domain/ports/clients/run-spokes.client.ts";
import { type EndedSpoke } from "../../domain/run/ended-spoke.value-object.ts";
import { type RunStatus } from "../../domain/run/run-status.value-object.ts";
import { endingOf } from "../../domain/run-spoke/spoke-end-request.value-object.ts";

// A test's live spokes, by run id, each as it ends, and the spokes ended, in
// order, with the ending each was ended for. `steps`, if given, is told when
// each is ended, so a test can see what came before and after.
export type FakeSpokes = {
  readonly live: Record<string, EndedSpoke>;
  readonly ended: Array<{ readonly runId: RunId; readonly ending: RunStatus }>;
  readonly forgotten: Array<RunId>;
  readonly steps: Array<string>;
};

export const fakeSpokes = (held: Partial<FakeSpokes> = {}): FakeSpokes => ({
  live: {},
  ended: [],
  forgotten: [],
  steps: [],
  ...held,
});

export const RunSpokesClientFake = (spokes: FakeSpokes) =>
  Layer.succeed(
    RunSpokesClient,
    RunSpokesClient.of({
      end: (runId, request) =>
        Effect.sync(() => {
          const found = Record.get(spokes.live, runId);

          if (Option.isSome(found)) {
            spokes.ended.push({ runId, ending: endingOf(request) });
            spokes.steps.push(`ended spoke of ${runId}`);
            delete spokes.live[runId];
          }

          return found;
        }),
      forget: (runId) =>
        Effect.sync(() => {
          spokes.forgotten.push(runId);
        }),
    }),
  );

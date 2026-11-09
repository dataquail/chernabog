import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import {
  type CompiledDocument,
  FlowCompilerClient,
  type PhaseGap,
} from "../../domain/ports/clients/flow-compiler.client.ts";

// A checkout whose documents compile as `compiled` says, keeping what it
// writes in `files`, by flow, and whose SDK finds these gaps across its flows,
// or none from before phases.
export const FlowCompilerClientFake = (
  compiled: { readonly [flow: string]: CompiledDocument },
  files = new Map<string, string>(),
  gaps: Option.Option<ReadonlyArray<PhaseGap>> = Option.some([]),
) =>
  Layer.succeed(
    FlowCompilerClient,
    FlowCompilerClient.of({
      catalogue: () =>
        Effect.succeed({
          format: "",
          subjects: [],
          sources: [],
          loopStates: [],
          laneScopes: [],
          blocks: [],
        }),
      documents: () => Effect.succeed(Object.keys(compiled).toSorted()),
      compile: (_, flow) =>
        Effect.succeed(
          Option.getOrElse(Record.get(compiled, flow), () => ({
            source: Option.none<string>(),
            problems: [],
            typeChecked: false,
          })),
        ),
      phaseGaps: () => Effect.succeed(gaps),
      written: (_, flow) => Effect.succeed(Option.fromUndefinedOr(files.get(flow))),
      write: (_, flow, source) =>
        Effect.sync(() => {
          files.set(flow, source);
        }),
    }),
  );

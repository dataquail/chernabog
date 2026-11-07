import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import {
  type CompiledDocument,
  FlowCompilerClient,
} from "../../domain/ports/clients/flow-compiler.client.ts";

// A checkout whose documents compile as `compiled` says, keeping what it
// writes in `files`, by flow.
export const FlowCompilerClientFake = (
  compiled: { readonly [flow: string]: CompiledDocument },
  files = new Map<string, string>(),
) =>
  Layer.succeed(
    FlowCompilerClient,
    FlowCompilerClient.of({
      documents: () => Effect.succeed(Object.keys(compiled).toSorted()),
      compile: (_, flow) =>
        Effect.succeed(
          Option.getOrElse(Record.get(compiled, flow), () => ({
            source: Option.none<string>(),
            problems: [],
            typeChecked: false,
          })),
        ),
      written: (_, flow) => Effect.succeed(Option.fromUndefinedOr(files.get(flow))),
      write: (_, flow, source) =>
        Effect.sync(() => {
          files.set(flow, source);
        }),
    }),
  );

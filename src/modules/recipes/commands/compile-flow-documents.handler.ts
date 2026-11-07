import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { FlowCompilerClient } from "../domain/ports/clients/flow-compiler.client.ts";
import {
  CompiledFlow,
  type CompileFlowDocumentsPayload,
  FlowDocumentsCompiled,
} from "./compile-flow-documents.command.ts";

export const compileFlowDocumentsHandler = Effect.fn("compileFlowDocumentsHandler")(
  function* ({ check, names, root }: CompileFlowDocumentsPayload) {
    const compiler = yield* FlowCompilerClient;
    const documents = yield* compiler.documents(root);
    const unknown = names.filter((name) => !documents.includes(name));

    const chosen = documents.filter((flow) => names.length === 0 || names.includes(flow));

    const flows = yield* Effect.forEach(chosen, (flow) =>
      Effect.gen(function* () {
        const compiled = yield* compiler.compile(root, flow);
        const { problems, typeChecked } = compiled;

        if (Option.isNone(compiled.source)) {
          return new CompiledFlow({ flow, outcome: "problems", problems, typeChecked });
        }

        const source = compiled.source.value;
        const same = Option.contains(yield* compiler.written(root, flow), source);

        if (same) {
          return new CompiledFlow({ flow, outcome: "unchanged", problems, typeChecked });
        }

        if (check) {
          return new CompiledFlow({ flow, outcome: "stale", problems, typeChecked });
        }

        yield* compiler.write(root, flow, source);

        return new CompiledFlow({ flow, outcome: "wrote", problems, typeChecked });
      }),
    );

    return new FlowDocumentsCompiled({ flows, unknown });
  },
  withUnitOfWork,
  // Its stores are files on this machine: they have no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);

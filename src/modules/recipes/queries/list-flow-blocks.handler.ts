import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { FlowCompilerClient } from "../domain/ports/clients/flow-compiler.client.ts";
import {
  FlowBlocksUnavailable,
  FlowCatalogue,
  type ListFlowBlocksPayload,
} from "./list-flow-blocks.query.ts";

export const listFlowBlocksHandler = Effect.fn("listFlowBlocksHandler")(
  function* ({ root }: ListFlowBlocksPayload) {
    const compiler = yield* FlowCompilerClient;
    const said = yield* compiler.catalogue(root);

    return yield* Schema.decodeUnknownEffect(FlowCatalogue)(said);
  },
  Effect.mapError((error) => new FlowBlocksUnavailable({ message: error.message })),
);

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import { ConfigTreeClient } from "../../domain/ports/clients/config-tree.client.ts";
import { ConfigTreeUnavailable } from "../../domain/trust-record/trust-record.errors.ts";

// Each checkout's tree of .chernabog/, by path; a checkout not listed has none.
// What changed reads as `<previous>..<tree>`, or `first trust` without a previous.
export const ConfigTreeClientFake = (trees: Readonly<Record<string, string>>) => {
  const treeOf = (path: string, baseBranch: string) =>
    Effect.fromOption(Record.get(trees, path)).pipe(
      Effect.mapError(
        () =>
          new ConfigTreeUnavailable({
            message: `${path}: no .chernabog/ on ${baseBranch}; run chernabog init and merge it first`,
          }),
      ),
    );

  return Layer.succeed(
    ConfigTreeClient,
    ConfigTreeClient.of({
      treeOf,
      localTreeOf: treeOf,
      changesSince: (_path, previous, tree) =>
        Effect.succeed(
          Option.match(previous, {
            onNone: () => `first trust of ${tree}`,
            onSome: (from) => `${from}..${tree}`,
          }),
        ),
    }),
  );
};

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import { Home, homePaths } from "../../../platform/home.ts";
import { ConfigTreeClient } from "../domain/ports/clients/config-tree.client.ts";
import { TrustFile } from "../storage/trust-file.schema.ts";
import { type CheckTrustPayload, TrustCheck } from "./check-trust.query.ts";

// A repo is trusted while the tree of .chernabog/ on its base branch is the one
// trust.json records for it. A trust.json that's missing or doesn't parse
// trusts nothing.
export const checkTrustHandler = Effect.fn("checkTrustHandler")(function* (
  query: CheckTrustPayload,
) {
  const tree = yield* Effect.option((yield* ConfigTreeClient).localTreeOf(query.path));

  const fs = yield* FileSystem.FileSystem;
  const file = homePaths((yield* Home).root).trust;

  const trusted = (yield* fs.readFileString(file).pipe(Effect.option)).pipe(
    Option.flatMap(Schema.decodeOption(TrustFile)),
    Option.flatMap((records) => Record.get(records, query.repo)),
    Option.map((entry) => entry.tree),
  );

  return TrustCheck.make({
    repo: query.repo,
    tree,
    trusted: Option.isSome(tree) && Option.contains(trusted, tree.value),
  });
});

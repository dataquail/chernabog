import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import { Home, homePaths } from "../../../platform/home.ts";
import { TrustFile } from "../storage/trust-file.schema.ts";
import { type FindTrustedTreePayload, TrustedTree } from "./find-trusted-tree.query.ts";

// Read from trust.json itself: one that's missing or doesn't parse trusts nothing.
export const findTrustedTreeHandler = Effect.fn("findTrustedTreeHandler")(function* (
  query: FindTrustedTreePayload,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = homePaths((yield* Home).root).trust;

  const tree = (yield* fs.readFileString(file).pipe(Effect.option)).pipe(
    Option.flatMap(Schema.decodeOption(TrustFile)),
    Option.flatMap((records) => Record.get(records, query.repo)),
    Option.map((entry) => entry.tree),
  );

  return TrustedTree.make({ repo: query.repo, tree });
});

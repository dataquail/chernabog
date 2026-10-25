import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { BundleClient } from "../domain/ports/clients/bundle.client.ts";
import { ChernabogDirClient } from "../domain/ports/clients/chernabog-dir.client.ts";
import {
  ignoresToAppend,
  missingIgnores,
  scaffoldWrites,
} from "../domain/scaffold/scaffold.value-object.ts";
import { Scaffolded } from "./recipe.result.ts";

type Change = (typeof Scaffolded.Type.changes)[number];

// Writes the scaffold of .chernabog/ into the repo at `root`, never
// overwriting a file that is there, except the generated schemas, which are
// brought up to date. package.json is written for a new .chernabog/ and left
// alone after that: its SDK pin says what the flows are written against, and
// only moving the flows (upgradeRepoUseCase) moves it. A .chernabog/ written
// against a newer SDK than this binary runs is refused, rather than moved back.
export const scaffoldRepoUseCase = Effect.fn("scaffoldRepoUseCase")(function* (root: string) {
  const dir = yield* ChernabogDirClient;
  const bundle = yield* BundleClient;
  const manifest = yield* dir.read(root, ".chernabog/package.json");

  for (const found of Option.toArray(manifest)) {
    yield* bundle.refuseNewer(found);
  }

  const scaffold = yield* bundle.scaffold;
  const present: Record<string, Option.Option<string>> = {};

  for (const file of Object.keys(scaffold.files)) {
    present[file] = yield* dir.read(root, `.chernabog/${file}`);
  }

  const writes = scaffoldWrites(scaffold, (file) => present[file] ?? Option.none());
  const changes: Array<Change> = [];

  for (const write of writes) {
    yield* dir.write(root, `.chernabog/${write.file}`, write.text);
    changes.push({
      path: `.chernabog/${write.file}`,
      change: Option.getOrElse(
        Option.liftPredicate("updated" as const, () => write.updated),
        () => "written" as const,
      ),
      entries: [],
    });
  }

  if (Option.isNone(manifest)) {
    yield* dir.write(root, ".chernabog/package.json", scaffold.manifest);
    changes.push({ path: ".chernabog/package.json", change: "written", entries: [] });
  }

  const gitignore = Option.getOrElse(yield* dir.read(root, ".gitignore"), () => "");
  const missing = missingIgnores(gitignore);

  if (missing.length > 0) {
    yield* dir.append(root, ".gitignore", ignoresToAppend(gitignore, missing));
    changes.push({ path: ".gitignore", change: "ignored", entries: missing });
  }

  return Scaffolded.make({ changes });
});

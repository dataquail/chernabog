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
// brought up to date, and package.json's pins of the bundled packages, which
// move to this binary's. When either changes, the repo relies on this binary,
// so its chernabog floor rises to it; a binary older than the floor refuses,
// rather than move the repo back.
export const scaffoldRepoUseCase = Effect.fn("scaffoldRepoUseCase")(function* (root: string) {
  const dir = yield* ChernabogDirClient;
  const bundle = yield* BundleClient;
  const manifest = yield* dir.read(root, ".chernabog/package.json");

  for (const found of Option.toArray(manifest)) {
    yield* bundle.checkFloor(found);
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

  type Manifest = { readonly text: string; readonly change: "written" | "pinned" };

  const pinned = yield* Option.match(manifest, {
    onNone: () => Effect.succeedSome<Manifest>({ text: scaffold.manifest, change: "written" }),
    onSome: (found) =>
      bundle
        .pinned(
          found,
          writes.some((write) => write.updated),
        )
        .pipe(Effect.map(Option.map((text): Manifest => ({ text, change: "pinned" })))),
  });

  for (const { change, text } of Option.toArray(pinned)) {
    yield* dir.write(root, ".chernabog/package.json", text);
    changes.push({ path: ".chernabog/package.json", change, entries: [] });
  }

  const gitignore = Option.getOrElse(yield* dir.read(root, ".gitignore"), () => "");
  const missing = missingIgnores(gitignore);

  if (missing.length > 0) {
    yield* dir.append(root, ".gitignore", ignoresToAppend(gitignore, missing));
    changes.push({ path: ".gitignore", change: "ignored", entries: missing });
  }

  return Scaffolded.make({ changes });
});

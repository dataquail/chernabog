import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { BundleClient } from "../domain/ports/clients/bundle.client.ts";
import { ChernabogDirClient } from "../domain/ports/clients/chernabog-dir.client.ts";
import {
  ignoresToAppend,
  missingIgnores,
  scaffoldWrites,
} from "../domain/scaffold/scaffold.value-object.ts";
import { Scaffolded, type ScaffoldRepoPayload } from "./scaffold-repo.command.ts";

type Change = (typeof Scaffolded.Type.changes)[number];

export const scaffoldRepoHandler = Effect.fn("scaffoldRepoHandler")(
  function* (cmd: ScaffoldRepoPayload) {
    const { root } = cmd;
    const dir = yield* ChernabogDirClient;
    const bundle = yield* BundleClient;
    const manifest = yield* dir.read(root, ".chernabog/package.json");

    for (const found of Option.toArray(manifest)) {
      yield* bundle.refuseNewer(found);
    }

    const bundled = yield* bundle.scaffold;

    const scaffold = {
      ...bundled,
      files: { ...bundled.files, "config.schema.json": yield* bundle.configSchema(root) },
    };

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
  },
  withUnitOfWork,
  // Its stores are files on this machine: they have no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);

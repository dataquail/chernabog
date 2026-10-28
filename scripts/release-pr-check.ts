// Fails when merging the release PR would leave out a version it moves, because
// release-please can't find that part's section in the PR's body. CI runs it on
// release-please's PR, with the body in RELEASE_PR_BODY and the base branch's
// manifest at BASE_MANIFEST.
// Run: RELEASE_PR_BODY="$(gh pr view <n> --json body --jq .body)" BASE_MANIFEST=<file> bun scripts/release-pr-check.ts

import { fileURLToPath } from "node:url";

import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { type Manifest, type ReleaseConfig, unreleased } from "./release-pr.ts";

class ReleasePrError extends Schema.TaggedError<
  ReleasePrError,
  { readonly brand: "ReleasePrError" }
>()("ReleasePrError", {
  message: Schema.String,
}) {}

const ReleaseConfigFile = Schema.fromJsonString(
  Schema.Struct({
    packages: Schema.Record(
      Schema.String,
      Schema.Struct({
        component: Schema.optionalKey(Schema.String),
        "include-component-in-tag": Schema.optionalKey(Schema.Boolean),
      }),
    ),
  }),
);

const ManifestFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

const inRepo = (file: string) => fileURLToPath(new URL(`../${file}`, import.meta.url));

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const body = yield* Config.String("RELEASE_PR_BODY");
  const base = yield* Config.String("BASE_MANIFEST");

  const config: ReleaseConfig = yield* Schema.decodeEffect(ReleaseConfigFile)(
    yield* fs.readFileString(inRepo("release-please-config.json")),
  );

  const before: Manifest = yield* Schema.decodeEffect(ManifestFile)(yield* fs.readFileString(base));

  const after: Manifest = yield* Schema.decodeEffect(ManifestFile)(
    yield* fs.readFileString(inRepo(".release-please-manifest.json")),
  );

  yield* Arr.match(unreleased(body, config, before, after), {
    onEmpty: () => Console.log("release-please finds a section for every version this PR moves"),
    onNonEmpty: (problems) => Effect.fail(new ReleasePrError({ message: problems.join("\n") })),
  });
});

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));

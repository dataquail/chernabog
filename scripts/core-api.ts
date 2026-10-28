// The text of packages/core/API.md: @chernabog/core's public declarations,
// as tsc emits them from its sources, one module after another. Core only
// grows within a major (docs/adr/0004-core-abi.md), so every change to what
// it declares shows in review as a diff of this file. A test renders it again
// to check the committed file is current.

import { fileURLToPath } from "node:url";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

export const coreApiFile = `${ROOT}packages/core/API.md`;

const HEADER = `# @chernabog/core's API

What \`@chernabog/core\` declares, module by module, as \`tsc\` emits it. \`bun run gen:core-api\` writes this file, and a test fails when it is out of date. Within a major, change it only by adding to it: see [ADR 0004](../../docs/adr/0004-core-abi.md).
`;

// tsc's declarations of core, emitted into a directory of their own.
const emitted = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-core-api-" });

  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(
      `${ROOT}node_modules/.bin/tsc`,
      [
        "--ignoreConfig",
        "--declaration",
        "--emitDeclarationOnly",
        "--outDir",
        dir,
        "--target",
        "esnext",
        "--module",
        "preserve",
        "--moduleResolution",
        "bundler",
        "--allowImportingTsExtensions",
        "--strict",
        "--skipLibCheck",
        "--types",
        "bun",
        `${ROOT}packages/core/src/index.ts`,
      ],
      { cwd: ROOT, forceKillAfter: "5 seconds" },
    ),
  );

  if (exitCode !== 0) {
    return yield* Effect.die(`tsc exited ${exitCode} declaring packages/core`);
  }

  return dir;
});

export const renderCoreApi = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* emitted;
    const files = Arr.sort(yield* fs.readDirectory(dir), Order.String);
    const modules: Array<string> = [];

    for (const file of files) {
      modules.push(
        `## ${file.replace(/\.d\.ts$/, ".ts")}\n\n\`\`\`ts\n${yield* fs.readFileString(path.join(dir, file))}\`\`\`\n`,
      );
    }

    return `${HEADER}\n${modules.join("\n")}`;
  }),
);

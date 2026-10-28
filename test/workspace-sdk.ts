// A .chernabog/ in a test has @chernabog/sdk installed the way a snapshot
// would, but from this checkout: a link to packages/sdk under its
// node_modules. The loader resolves the SDK from there and substitutes the
// binary's core and effect for its imports, as it does for one from npm.

import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

const WORKSPACE_SDK = fileURLToPath(new URL("../packages/sdk", import.meta.url));

export const installWorkspaceSdk = (configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${configDir}/node_modules/@chernabog`, { recursive: true });
    yield* fs.symlink(WORKSPACE_SDK, `${configDir}/node_modules/@chernabog/sdk`);
  });

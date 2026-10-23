// How to run this same program again: the compiled binary, or bun on the source
// entry point during development.

import { fileURLToPath } from "node:url";

export const SOURCE_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

// Homebrew runs a formula's binary from <prefix>/Cellar/<name>/<version>/,
// which `brew upgrade` deletes, and keeps <prefix>/opt/<name> linked to the
// current version. What this command is written into, a launchd plist, a
// systemd unit or a hook, has to outlive an upgrade, so it names the opt path.
export const stableExecutable = (path: string) =>
  path.replace(/^(.*)\/Cellar\/([^/]+)\/[^/]+\//, "$1/opt/$2/");

export const selfCommand = (): ReadonlyArray<string> => {
  if (Bun.isStandaloneExecutable) {
    return [stableExecutable(process.execPath)];
  }

  return [process.execPath, `${SOURCE_ROOT}/src/interface/cli/main.ts`];
};

// bun itself, for `bun install`: the compiled binary acts as bun when BUN_BE_BUN
// is set, and from source this is bun already.
export const bunExecutable = () => process.execPath;

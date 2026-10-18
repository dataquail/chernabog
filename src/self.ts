// How to run this same program again: the compiled binary, or bun on the source
// entry point during development.

import { fileURLToPath } from 'node:url';

export const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

export const selfCommand = (): ReadonlyArray<string> => {
  if (Bun.isStandaloneExecutable) return [process.execPath];

  return [process.execPath, `${SOURCE_ROOT}/src/main.ts`];
};

// bun itself, for `bun install`: the compiled binary acts as bun when BUN_BE_BUN
// is set, and from source this is bun already.
export const bunExecutable = () => process.execPath;

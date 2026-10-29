// Every test's timeout, as the package.json test scripts set it with
// --timeout=15000, so a bare `bun test` gives a slow test, such as one that
// runs git for real on a busy machine, the same room as `bun run test` does.

import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(15_000);

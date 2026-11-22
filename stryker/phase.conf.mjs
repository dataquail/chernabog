// The Phase and PhaseWriter formats the threads trailers rely on.
import { mutationConfig } from "./base.mjs";

export default mutationConfig("phase", {
  mutate: ["packages/core/src/phase.ts"],
  testFiles: [
    "test/progress.test.ts",
    "src/modules/runs/infrastructure/runtime/progress.test.ts",
    "src/modules/runs/infrastructure/runtime/phase-announcer.test.ts",
    "test/ledger.test.ts",
    "test/backfill.test.ts",
    "test/phases-record.test.ts",
    "test/merge-hold-ci.test.ts",
  ],
});

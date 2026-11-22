// The transition catalogue, park and reconcile. Park's only tests are the
// engine runs below that wait in real time, so mutants get a long timeout
// until park has a fast test of its own.
import { mutationConfig } from "./base.mjs";

export default mutationConfig("phases", {
  mutate: ["packages/sdk/src/phases.ts"],
  testFiles: [
    "test/ledger.test.ts",
    "test/phases-record.test.ts",
    "test/review-phases.test.ts",
    "test/compose-phases.test.ts",
    "test/backfill.test.ts",
    "test/merge-hold-ci.test.ts",
    "test/leases.test.ts",
    "test/reservations.test.ts",
    "test/recipes.test.ts",
    "test/reviewer-pool.test.ts",
    // Park.
    "test/ci-park.test.ts",
    "test/document-park-ci.test.ts",
    "test/document-park-wait.test.ts",
    "test/adopted-ci.test.ts",
    "test/resolve-conflicts-ci.test.ts",
    "test/plan-ci.test.ts",
    "test/adopt.test.ts",
  ],
  timeoutMS: 120000,
});

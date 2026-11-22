// The transition catalogue, park and reconcile. Only fast tests: park's own
// are phases.test.ts's, in Effect's in-memory workflow engine, so the engine
// runs that wait in real time stay out, and mutants keep the default timeout.
import { mutationConfig } from "./base.mjs";

export default mutationConfig("phases", {
  mutate: ["packages/sdk/src/phases.ts"],
  testFiles: [
    "test/phases.test.ts",
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
    "test/with-person.test.ts",
  ],
});

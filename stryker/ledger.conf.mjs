// The ledger and its tamper-evidence check (ADR 21, decision 5). The check
// runs on every advance a test makes on the Progress fake (bunfig.toml's
// preload), so every fast test that advances an item reaches it.
import { mutationConfig } from "./base.mjs";

export default mutationConfig("ledger", {
  mutate: ["packages/sdk/src/ledger-check.ts", "packages/sdk/src/ledger.ts"],
  testFiles: [
    "test/ledger.test.ts",
    "test/compose-phases.test.ts",
    "test/backfill.test.ts",
    "test/phases-record.test.ts",
    "test/merge-hold-ci.test.ts",
    "test/leases.test.ts",
    "test/reservations.test.ts",
    "test/recipes.test.ts",
    "test/reviewer-pool.test.ts",
  ],
});

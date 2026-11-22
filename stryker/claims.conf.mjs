// Leases and claims: the lease ref only one writer can create.
import { mutationConfig } from "./base.mjs";

export default mutationConfig("claims", {
  mutate: ["packages/core/src/claims.ts"],
  testFiles: [
    "test/claims.test.ts",
    "test/leases.test.ts",
    "test/reservations.test.ts",
    "test/still-valid.test.ts",
    "test/recipes.test.ts",
    "test/ledger.test.ts",
    "src/modules/rehearsals/infrastructure/clients/scratch-repo.client-live.test.ts",
  ],
});

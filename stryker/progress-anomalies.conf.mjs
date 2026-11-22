// `chernabog progress anomalies` over the repo's SDK's Ledger (ADR 21,
// decision 5): its own test, over a fake ledger, and ledger.test.ts, which
// reaches parseSeen.
import { mutationConfig } from "./base.mjs";

export default mutationConfig("progress-anomalies", {
  mutate: ["src/modules/runs/infrastructure/runtime/progress-anomalies.ts"],
  testFiles: [
    "src/modules/runs/infrastructure/runtime/progress-anomalies.test.ts",
    "test/ledger.test.ts",
  ],
});

// A finished CI run wakes only what waits on it (#555): the SDK's routes, and
// the plan's decisions over them. The runtime's ci-plan.ts has no test short
// of the acceptance tests, so its pure core, the domain service, stands in.
import { mutationConfig } from "./base.mjs";

export default mutationConfig("ci-wake", {
  mutate: [
    "packages/sdk/src/events.ts",
    "src/modules/runs/domain/domain-services/ci-plan.domain-service.ts",
  ],
  testFiles: [
    "test/ci-plan.test.ts",
    "test/sdk-events.test.ts",
    "src/modules/runs/domain/domain-services/ci-plan.domain-service.test.ts",
  ],
});

// The threads adapter's compare-and-set: every test that reaches it.
// threads-setup.test.ts reaches only its module-level constants.
import { mutationConfig } from "./base.mjs";

export default mutationConfig("progress", {
  mutate: ["src/modules/runs/infrastructure/runtime/progress.ts"],
  testFiles: [
    "src/modules/runs/infrastructure/runtime/progress.test.ts",
    "test/progress.test.ts",
    "src/modules/runs/infrastructure/runtime/phase-announcer.test.ts",
    "src/modules/runs/infrastructure/runtime/threads-setup.test.ts",
  ],
});

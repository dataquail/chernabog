// A lost race sends nothing; a retry that finds its own write sends again.
import { mutationConfig } from "./base.mjs";

export default mutationConfig("phase-announcer", {
  mutate: ["src/modules/runs/infrastructure/runtime/phase-announcer.ts"],
  testFiles: ["src/modules/runs/infrastructure/runtime/phase-announcer.test.ts"],
});

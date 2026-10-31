import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { RecipesPeerLive } from "../../../../../test/recipe-repo.ts";
import { TeamFlows } from "../../domain/enrolled-repo/team-flows.value-object.ts";
import { TeamFlowsAcl } from "../../domain/ports/acl/team-flows.acl.ts";
import { TeamFlowsAclLive } from "./team-flows.acl-live.ts";

// A checkout whose .chernabog/config.yaml is `config`.
const checkout = (config: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-team-" });
    yield* fs.makeDirectory(`${root}/.chernabog`);
    yield* fs.writeFileString(`${root}/.chernabog/config.yaml`, config);

    return root;
  });

// The adapter over the recipes module's own handlers and storage.
const live = TeamFlowsAclLive.pipe(Layer.provide(RecipesPeerLive));

describe("TeamFlowsAclLive", () => {
  effect(
    "asks the recipes module the team's config, and answers it as enrollment's TeamFlows",
    () =>
      Effect.gen(function* () {
        const root = yield* checkout(
          "agent: claude\nreviewers: [bob]\nflows:\n  review:\n    agent: codex\n    runners: [bob]\n  fix:\n    enabled: false\n",
        );

        expect(yield* (yield* TeamFlowsAcl).of(root)).toEqual(
          TeamFlows.make({
            agent: Option.some("claude"),
            runners: Option.none(),
            reviewers: ["bob"],
            flows: { review: { agent: "codex", runners: ["bob"] }, fix: { enabled: false } },
          }),
        );
      }).pipe(Effect.provide(live)),
  );

  effect("a config the recipes module can't read is a checkout enrolling can't read", () =>
    Effect.gen(function* () {
      const root = yield* checkout("flows: [");
      const error = yield* Effect.flip((yield* TeamFlowsAcl).of(root));

      expect(error._tag).toBe("CheckoutUnreadable");
      expect(error.message).toContain(`${root}/.chernabog/config.yaml`);
    }).pipe(Effect.provide(live)),
  );
});

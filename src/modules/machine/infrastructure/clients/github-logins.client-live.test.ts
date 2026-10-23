import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effectAtHomeWith } from "../../../../../test/effect-test.ts";
import { execTestLayer } from "../../../../platform/exec.ts";
import { GitHubLoginsClient } from "../../domain/ports/clients/github-logins.client.ts";
import { GitHubLoginsClientLive } from "./github-logins.client-live.ts";

// gh answers `auth status` as it does logged in to alice and bob, the active one twice.
const effect = effectAtHomeWith(
  execTestLayer((command, args) =>
    Option.liftPredicate(
      {
        exitCode: 0,
        stdout:
          "github.com\n  ✓ Logged in to github.com account alice (keyring)\n  - Active account: true\n",
        stderr:
          "  ✓ Logged in to github.com account bob (keyring)\n  ✓ Logged in to github.com account alice (GH_TOKEN)\n",
      },
      () => command === "gh" && args[1] === "status",
    ),
  ),
);

describe("GitHubLoginsClientLive", () => {
  effect("reads gh's logins from gh auth status, each once", () =>
    Effect.gen(function* () {
      expect(yield* (yield* GitHubLoginsClient).logins).toEqual(["alice", "bob"]);
    }).pipe(Effect.provide(Layer.fresh(GitHubLoginsClientLive))),
  );
});

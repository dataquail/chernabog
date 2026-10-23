// gh's logins on github.com, from `gh auth status`. Asked without GH_TOKEN,
// which gh would report instead of its own logins.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Exec } from "../../../../Exec.ts";
import { TOKEN_VARIABLES } from "../../../../github-auth.ts";
import { HostEnvironment, withVariables } from "../../../../platform/environment.ts";
import { GitHubLoginsClient } from "../../domain/ports/clients/github-logins.client.ts";

const LOGGED_IN = /Logged in to github\.com account (\S+)/g;

export const GitHubLoginsClientLive = Layer.effect(
  GitHubLoginsClient,
  Effect.gen(function* () {
    const services = yield* Effect.context<Exec | HostEnvironment>();

    const logins = Effect.gen(function* () {
      const host = yield* HostEnvironment;

      const status = yield* (yield* Exec).run(
        "gh",
        ["auth", "status", "--hostname", "github.com"],
        {
          env: withVariables(host.variables, {}, TOKEN_VARIABLES),
        },
      );

      return Arr.dedupe(
        [...`${status.stdout}\n${status.stderr}`.matchAll(LOGGED_IN)].map((match) => match[1]),
      );
    }).pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
      Effect.provideContext(services),
    );

    return GitHubLoginsClient.of({ logins });
  }),
);

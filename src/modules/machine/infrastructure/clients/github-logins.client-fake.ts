import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GitHubLoginsClient } from "../../domain/ports/clients/github-logins.client.ts";

// gh logged in to `logins`.
export const GitHubLoginsClientFake = (logins: ReadonlyArray<string>) =>
  Layer.succeed(GitHubLoginsClient, GitHubLoginsClient.of({ logins: Effect.succeed(logins) }));

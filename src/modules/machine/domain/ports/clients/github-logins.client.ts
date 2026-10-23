import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

// The accounts gh is logged in to on github.com: the logins this machine can
// act as, since a persona's token comes from `gh auth token --user <login>`.
// None when gh is logged in to none, or can't say.
export type GitHubLoginsClientService = {
  readonly logins: Effect.Effect<ReadonlyArray<string>>;
};

export class GitHubLoginsClient extends Context.Service<
  GitHubLoginsClient,
  GitHubLoginsClientService
>()("GitHubLoginsClient") {}

import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type ConfigTreeUnavailable } from "../../trust-record/trust-record.errors.ts";

// A checkout's .chernabog/ as git has it: the tree a person trusts, and what a
// person reviews before trusting it.
export type ConfigTreeClientService = {
  // The tree hash of .chernabog/ on the config branch, GitHub's default,
  // asked of origin and fetched first.
  readonly treeOf: (path: string) => Effect.Effect<string, ConfigTreeUnavailable>;
  // The same, as git has it now, without asking origin: quick, for showing
  // whether a repo is trusted rather than deciding it.
  readonly localTreeOf: (path: string) => Effect.Effect<string, ConfigTreeUnavailable>;
  // What changed in .chernabog/ from `previous` to `tree`, or, with none, every
  // file it holds: the text a person reads before trusting it.
  readonly changesSince: (
    path: string,
    previous: Option.Option<string>,
    tree: string,
  ) => Effect.Effect<string, ConfigTreeUnavailable>;
};

export class ConfigTreeClient extends Context.Service<ConfigTreeClient, ConfigTreeClientService>()(
  "ConfigTreeClient",
) {}

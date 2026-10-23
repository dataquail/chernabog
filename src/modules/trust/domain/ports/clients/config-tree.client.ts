import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';
import type * as Option from 'effect/Option';

import { type ConfigTreeUnavailable } from '../../trust-record/trust-record.errors.ts';

// A checkout's .chernabog/ as git has it: the tree a person trusts, and what a
// person reviews before trusting it.
export type ConfigTreeClientService = {
  // The tree hash of .chernabog/ on the base branch, fetched from origin first.
  readonly treeOf: (path: string, baseBranch: string) => Effect.Effect<string, ConfigTreeUnavailable>;
  // What changed in .chernabog/ from `previous` to `tree`, or, with none, every
  // file it holds: the text a person reads before trusting it.
  readonly changesSince: (path: string, previous: Option.Option<string>, tree: string) => Effect.Effect<string, ConfigTreeUnavailable>;
};

export class ConfigTreeClient extends Context.Service<ConfigTreeClient, ConfigTreeClientService>()('ConfigTreeClient') {}

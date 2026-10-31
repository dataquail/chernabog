import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { type TrustRecordRoot } from "./trust-record.root.ts";

// What trust's commands tell whoever listens, the dashboard's /events stream
// and the notifier: a repo's .chernabog/ trusted, so the daemon runs its
// flows. A command dispatches one only after the record that makes it true is
// saved, and its id names the repo, the tree and when, so a repeat has the
// same id for a consumer to drop.
//
// Claiming a reload says nothing: it is the daemon's own bookkeeping.

// A person trusted a tree of a repo's .chernabog/, first or over another.
export const RepoTrusted = Schema.TaggedStruct("RepoTrusted", {
  eventId: Schema.String,
  repo: RepoSlug,
  tree: Schema.String,
  previous: Schema.Option(Schema.String),
  trustedAt: Schema.String,
});

export type RepoTrusted = typeof RepoTrusted.Type;

const trusted = (record: TrustRecordRoot, previous: Option.Option<string>) =>
  RepoTrusted.make({
    eventId: `${record.repo}:trusted:${record.tree}:${record.at}`,
    repo: record.repo,
    tree: record.tree,
    previous,
    trustedAt: record.at,
  });

export const TrustEvents = { trusted } as const;

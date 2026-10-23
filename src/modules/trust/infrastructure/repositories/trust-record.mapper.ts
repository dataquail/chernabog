// Trust records as trust.json keeps them: one object, by slug, of the tree
// trusted and when.

import * as Schema from "effect/Schema";

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { TrustRecordRoot } from "../../domain/trust-record/trust-record.root.ts";

const TrustEntry = Schema.Struct({ tree: Schema.String, at: Schema.String });

export const TrustFile = Schema.fromJsonString(Schema.Record(Schema.String, TrustEntry), {
  space: 2,
});

export type TrustFile = typeof TrustFile.Type;

export const toRoot = (slug: string, entry: typeof TrustEntry.Type) =>
  TrustRecordRoot.make({ repo: RepoSlug.make(slug), tree: entry.tree, at: entry.at });

export const toEntry = (record: TrustRecordRoot): typeof TrustEntry.Type => ({
  tree: record.tree,
  at: record.at,
});

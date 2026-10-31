// Trust records to and from trust.json's entries (storage/trust-file.schema.ts).

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { TrustRecordRoot } from "../../domain/trust-record/trust-record.root.ts";
import { type TrustEntry } from "../../storage/trust-file.schema.ts";

export const toRoot = (slug: string, entry: TrustEntry) =>
  TrustRecordRoot.make({ repo: RepoSlug.make(slug), tree: entry.tree, at: entry.at });

export const toEntry = (record: TrustRecordRoot): TrustEntry => ({
  tree: record.tree,
  at: record.at,
});

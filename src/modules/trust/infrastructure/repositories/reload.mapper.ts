// Reloads as reloaded.json keeps them: one object, by slug, of the tree each
// repo last restarted the daemon on.

import * as Schema from "effect/Schema";

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { ReloadRoot } from "../../domain/reload/reload.root.ts";

export const ReloadedFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String), {
  space: 2,
});

export type ReloadedFile = typeof ReloadedFile.Type;

export const toRoot = (slug: string, tree: string) =>
  ReloadRoot.make({ repo: RepoSlug.make(slug), tree });

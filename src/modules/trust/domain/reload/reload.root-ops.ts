import * as Option from "effect/Option";

import { type RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { ReloadRoot } from "./reload.root.ts";

// Restarting the daemon on a repo's trusted tree: the record that it did,
// none when the repo last restarted it on this very tree. A different tree,
// including one it restarted on before another, restarts it again.
const claim = (record: Option.Option<ReloadRoot>, repo: RepoSlug, tree: string) =>
  Option.map(
    Option.liftPredicate(tree, () => !Option.exists(record, (found) => found.tree === tree)),
    (claimed) => ReloadRoot.make({ repo, tree: claimed }),
  );

export const ReloadRootOps = { claim } as const;

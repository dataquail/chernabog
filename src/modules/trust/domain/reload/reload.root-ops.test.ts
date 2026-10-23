import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { ReloadRoot } from "./reload.root.ts";
import { ReloadRootOps } from "./reload.root-ops.ts";

const repo = RepoSlug.make("dataquail/demo");

describe("ReloadRootOps.claim", () => {
  test("a repo's first restart on a tree records it", () => {
    expect(ReloadRootOps.claim(Option.none(), repo, "aaaa")).toEqual(
      Option.some(ReloadRoot.make({ repo, tree: "aaaa" })),
    );
  });

  test("the tree it last restarted on doesn't restart it again; another tree does", () => {
    const last = Option.some(ReloadRoot.make({ repo, tree: "aaaa" }));

    expect(ReloadRootOps.claim(last, repo, "aaaa")).toEqual(Option.none());
    expect(ReloadRootOps.claim(last, repo, "bbbb")).toEqual(
      Option.some(ReloadRoot.make({ repo, tree: "bbbb" })),
    );
  });
});
